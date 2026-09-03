// `grok agent --always-approve stdio`: grok stays up and speaks ACP JSON-RPC
// on stdin/stdout.
//
// The turn is driven by four protocol facts, all from grok's agent-mode docs:
//   - `initialize` opens the connection;
//   - `session/new` (or `session/load`) opens the conversation;
//   - `session/prompt` is the user turn, and `session/update` notifications
//     carry the stream;
//   - `session/cancel` ends an in-flight prompt in-protocol.
//
// ACP updates are converted into the same streaming-messages-json shapes the
// print transport emits, so the accumulator does not know which path produced
// them. While the turn runs it is registered as live, so a caller can deliver
// abort / steer / follow_up. Sending is always the caller's decision.

import { INIT_TIMEOUT_MS, SERVER_INFO } from "../config.ts";
import type { GrokHandle, RunResult } from "../grok-process.ts";
import { runGrok } from "../grok-process.ts";
import { asRecord } from "../parse.ts";
import type { CallContext } from "../types.ts";
import { agentArgs } from "./args.ts";
import type { MidRunCommand } from "./registry.ts";
import { registerRun } from "./registry.ts";
import type { RunPlan, Transport } from "./types.ts";

export function waitFor<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
	let timer: NodeJS.Timeout | undefined;
	return Promise.race([
		promise,
		new Promise<never>((_, reject) => {
			timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms);
		}),
	]).finally(() => {
		if (timer) clearTimeout(timer);
	});
}

interface PendingRequest {
	resolve: (value: Record<string, unknown>) => void;
	reject: (err: Error) => void;
}

/**
 * One ACP JSON-RPC conversation over a grok stdin/stdout pair.
 *
 * Incoming requests from grok (permission prompts, fs reads we did not
 * advertise) are answered so the turn cannot stall; we never advertise fs or
 * terminal capabilities, so grok uses its own tools.
 */
class AcpClient {
	private nextId = 1;
	private readonly pending = new Map<number, PendingRequest>();
	private sessionId: string | null = null;
	private textChunks: string[] = [];
	private pendingSteer: string | null = null;
	private pendingFollowUp: string | null = null;
	private promptId: number | null = null;
	private settled = false;
	private unregister: () => void = () => {};
	private readonly handle: GrokHandle;
	private readonly onEvent: (event: unknown) => void;
	private readonly plan: RunPlan;

	constructor(handle: GrokHandle, onEvent: (event: unknown) => void, plan: RunPlan) {
		this.handle = handle;
		this.onEvent = onEvent;
		this.plan = plan;
	}

	get id(): string | null {
		return this.sessionId;
	}

	handleLine(event: unknown): void {
		const record = asRecord(event);
		if (record === null || record.jsonrpc !== "2.0") return;

		// Incoming request from grok — answer so the turn cannot stall.
		if (typeof record.method === "string" && Object.hasOwn(record, "id") && !Object.hasOwn(record, "result")) {
			this.answerIncoming(record);
			return;
		}

		// Response to one of our requests.
		if (typeof record.id === "number") {
			const waiter = this.pending.get(record.id);
			if (waiter) {
				this.pending.delete(record.id);
				if (record.error !== undefined) {
					const err = asRecord(record.error);
					waiter.reject(new Error(typeof err?.message === "string" ? err.message : "ACP request failed"));
				} else {
					waiter.resolve(asRecord(record.result) ?? {});
				}
				if (record.id === this.promptId) {
					void this.onPromptSettled(asRecord(record.result) ?? {}, record.error !== undefined);
				}
				return;
			}
		}

		if (record.method === "session/update") {
			this.onUpdate(asRecord(record.params));
		}
	}

	request(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
		const id = this.nextId++;
		return new Promise((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			this.handle.send({ jsonrpc: "2.0", id, method, params });
		});
	}

	notify(method: string, params: Record<string, unknown>): void {
		this.handle.send({ jsonrpc: "2.0", method, params });
	}

	rejectAll(reason: string): void {
		for (const [id, waiter] of [...this.pending]) {
			this.pending.delete(id);
			waiter.reject(new Error(reason));
		}
	}

	deliver(command: MidRunCommand, message?: string): void {
		if (command === "abort" || command === "steer") {
			if (this.sessionId) this.notify("session/cancel", { sessionId: this.sessionId });
		}
		if (command === "steer" && typeof message === "string") this.pendingSteer = message;
		if (command === "follow_up" && typeof message === "string") this.pendingFollowUp = message;
	}

	attachLive(sessionId: string): void {
		this.sessionId = sessionId;
		this.unregister = registerRun({
			sessionId,
			cwd: this.plan.cwd,
			startedAt: Date.now(),
			handle: this.handle,
			deliver: (command, message) => this.deliver(command, message),
		});
	}

	detachLive(): void {
		this.unregister();
	}

	async startPrompt(text: string): Promise<void> {
		if (!this.sessionId) throw new Error("ACP session is not open");
		this.textChunks = [];
		this.promptId = this.nextId;
		await this.request("session/prompt", {
			sessionId: this.sessionId,
			prompt: [{ type: "text", text }],
		});
	}

	private answerIncoming(record: Record<string, unknown>): void {
		const method = record.method;
		if (method === "session/request_permission") {
			this.handle.send({
				jsonrpc: "2.0",
				id: record.id,
				result: { outcome: { outcome: "selected", optionId: "allow-once" } },
			});
			return;
		}
		this.handle.send({
			jsonrpc: "2.0",
			id: record.id,
			error: { code: -32601, message: `Method not found: ${String(method)}` },
		});
	}

	private onUpdate(params: Record<string, unknown> | null): void {
		if (params === null) return;
		const update = asRecord(params.update) ?? params;
		const kind = update.sessionUpdate;
		if (kind === "agent_message_chunk") {
			const content = asRecord(update.content);
			const text = typeof content?.text === "string" ? content.text : "";
			if (text) {
				this.textChunks.push(text);
				this.onEvent({
					type: "assistant",
					message: {
						role: "assistant",
						model: this.plan.overrides.model,
						content: [{ type: "text", text }],
					},
				});
			}
			return;
		}
		if (kind === "tool_call") {
			const name =
				typeof update.toolName === "string"
					? update.toolName
					: typeof update.title === "string"
						? update.title
						: "tool";
			const rawInput = asRecord(update.rawInput) ?? {};
			this.onEvent({
				type: "assistant",
				message: {
					role: "assistant",
					model: this.plan.overrides.model,
					content: [{ type: "tool_use", id: update.toolCallId, name, input: rawInput }],
				},
			});
		}
	}

	private emitResult(subtype: string, text: string, isError: boolean): void {
		if (this.settled) return;
		this.settled = true;
		this.detachLive();
		this.onEvent({
			type: "result",
			subtype,
			is_error: isError,
			result: text,
			session_id: this.sessionId,
			num_turns: 1,
			duration_ms: 0,
			usage: { input_tokens: 0, output_tokens: 0 },
			permission_denials: [],
		});
		this.handle.endInput();
	}

	private async onPromptSettled(result: Record<string, unknown>, failed: boolean): Promise<void> {
		const stop = typeof result.stopReason === "string" ? result.stopReason : failed ? "error" : "end_turn";
		const text = this.textChunks.join("");

		if (this.pendingSteer !== null && (stop === "cancelled" || stop === "canceled")) {
			const steered = this.pendingSteer;
			this.pendingSteer = null;
			this.textChunks = [];
			this.promptId = this.nextId;
			try {
				await this.request("session/prompt", {
					sessionId: this.sessionId,
					prompt: [{ type: "text", text: steered }],
				});
			} catch (err) {
				this.emitResult("error_during_execution", err instanceof Error ? err.message : String(err), true);
			}
			return;
		}

		if (this.pendingFollowUp !== null) {
			const follow = this.pendingFollowUp;
			this.pendingFollowUp = null;
			this.notify("session/prompt", {
				sessionId: this.sessionId ?? "",
				prompt: [{ type: "text", text: follow }],
			});
		}

		const subtype =
			stop === "end_turn"
				? "success"
				: stop === "max_tokens" || stop === "max_turn_requests"
					? "error_max_turns"
					: stop === "cancelled" || stop === "canceled"
						? "success"
						: "error_during_execution";
		this.emitResult(subtype, text, subtype !== "success");
	}
}

export const acpTransport: Transport = {
	name: "acp",
	acceptsMidRunMessages: true,

	async run(plan: RunPlan, ctx: CallContext, onEvent: (event: unknown) => void): Promise<RunResult> {
		const args = agentArgs(plan);
		let handle: GrokHandle | undefined;
		let client: AcpClient | undefined;

		const running = runGrok(args, plan.cwd, {
			token: ctx.token,
			timeoutMs: plan.timeoutMs,
			stdin: "pipe",
			gracefulStop: () => {
				if (client?.id)
					handle?.send({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: client.id } });
			},
			onStart: (grokHandle) => {
				handle = grokHandle;
				client = new AcpClient(grokHandle, onEvent, plan);
			},
			onEvent: (event) => {
				client?.handleLine(event);
			},
		}).finally(() => {
			client?.detachLive();
			client?.rejectAll("the grok process exited before replying");
		});

		try {
			if (!client || !handle) {
				const ready = await Promise.race([
					running.then(() => false),
					new Promise<boolean>((resolve) => {
						const check = (): void => {
							if (client && handle) resolve(true);
							else setTimeout(check, 5);
						};
						check();
					}),
				]);
				if (!ready || !client) {
					const result = await running;
					return { ...result, protocolError: "the grok process exited before the ACP handshake" };
				}
			}

			try {
				await waitFor(
					client.request("initialize", {
						protocolVersion: "1",
						clientInfo: { name: SERVER_INFO.name, version: SERVER_INFO.version },
						clientCapabilities: {},
					}),
					INIT_TIMEOUT_MS,
					"the initialize handshake",
				);
			} catch (err) {
				const detail = err instanceof Error ? err.message : String(err);
				throw new Error(`grok rejected the initialize handshake: ${detail}`);
			}

			const meta: Record<string, unknown> = {};
			if (plan.overrides.approval_mode === undefined || plan.overrides.approval_mode === "yolo") {
				meta.yoloMode = true;
			} else if (plan.overrides.approval_mode === "auto") {
				meta.autoMode = true;
			}
			if (plan.overrides.system_prompt_append) meta.rules = plan.overrides.system_prompt_append;

			let sessionId: string;
			if (plan.resume) {
				await waitFor(
					client.request("session/load", {
						sessionId: plan.sessionId,
						cwd: plan.cwd,
						mcpServers: [],
						_meta: meta,
					}),
					INIT_TIMEOUT_MS,
					"session/load",
				);
				sessionId = plan.sessionId;
			} else {
				const created = await waitFor(
					client.request("session/new", {
						cwd: plan.cwd,
						mcpServers: [],
						_meta: meta,
					}),
					INIT_TIMEOUT_MS,
					"session/new",
				);
				const reported = created.sessionId;
				if (typeof reported !== "string" || reported === "") {
					throw new Error("session/new did not return a sessionId");
				}
				sessionId = reported;
				plan.onSessionId?.(sessionId);
			}

			client.attachLive(sessionId);
			onEvent({
				type: "system",
				subtype: "init",
				session_id: sessionId,
				model: plan.overrides.model,
				cwd: plan.cwd,
			});

			if (plan.overrides.effort) {
				await client.request("session/set_config_option", {
					sessionId,
					configId: "reasoning_effort",
					value: { value: plan.overrides.effort },
				});
			}

			await client.startPrompt(plan.prompt);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			client?.rejectAll(message);
			handle?.kill("SIGTERM");
			const result = await running;
			return { ...result, protocolError: message, ...(client?.id ? { sessionId: client.id } : {}) };
		}

		const result = await running;
		return { ...result, ...(client?.id ? { sessionId: client.id } : {}) };
	},
};
