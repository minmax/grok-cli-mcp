// Tool schemas and their implementations.

import { randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import type { Accumulator } from "./answer.ts";
import {
	accumulate,
	answerProblem,
	clip,
	describeBrokenRun,
	newAccumulator,
	renderFailure,
	selectAnswer,
	summarize,
	tailStderr,
} from "./answer.ts";
import {
	DEFAULT_APPROVAL_MODE,
	DEFAULT_MODEL,
	MAX_PROMPT,
	MAX_TIMEOUT_MS,
	MODELS_TIMEOUT_MS,
	TIMEOUT_MS,
} from "./config.ts";
import type { RunResult } from "./grok-process.ts";
import { runGrok, withSlot } from "./grok-process.ts";
import { getSession, listSessions, rememberSession, withSessionLock } from "./sessions.ts";
import type { RunPlan, Transport } from "./transport/index.ts";
import { getRun, listRuns, resolveTransport, TRANSPORT_NAMES } from "./transport/index.ts";
import type { ApprovalMode, CallContext, EffortLevel, RunOverrides, ToolDefinition, ToolResult } from "./types.ts";
import { APPROVAL_MODES, EFFORT_LEVELS, isApprovalMode, isEffortLevel } from "./types.ts";

// --- schemas --------------------------------------------------------------

const SHARED_PROPS = {
	model: {
		type: "string",
		description:
			"Model id, e.g. 'grok-4.6'. Defaults to grok's own settings. grok_models lists what this install can reach.",
	},
	approval_mode: {
		type: "string",
		enum: [...APPROVAL_MODES],
		description:
			"How grok approves tool use: 'yolo' / 'bypassPermissions' (always-approve), 'default' (ask — unusable " +
			"headless, tools get denied), 'acceptEdits', 'plan', 'auto', 'dontAsk'. Defaults to the server's " +
			"GROK_MCP_APPROVAL_MODE (itself defaulting to yolo): delegation is the point of this server. Restrict " +
			"instead with allowed_tools when it matters.",
	},
	effort: {
		type: "string",
		enum: [...EFFORT_LEVELS],
		description:
			"Reasoning effort: 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'. Passed as grok's " +
			"`--effort` flag (print) or `session/set_config_option` (acp).",
	},
	transport: {
		type: "string",
		enum: TRANSPORT_NAMES,
		description:
			"Usually omit. The default 'acp' keeps grok up (`grok agent stdio`) so a running turn can be steered " +
			"or aborted with grok_send. 'print' is grok -p with streaming-messages-json: one process per turn " +
			"that cannot be reached while it works.",
	},
	timeout_ms: {
		type: "integer",
		minimum: 1000,
		description:
			"Usually omit — the server default is generous. Override only when the task's real size " +
			"demands it. A run killed at the deadline is not lost: it still returns its session id and is " +
			"resumable with grok_reply.",
	},
} as const;

export const TOOLS: ToolDefinition[] = [
	{
		name: "grok",
		description:
			"Start a NEW task in the local Grok Build agent — a separate CLI coding agent with its own " +
			"file/shell tools and its own context window. Blocks until grok settles, then returns only its " +
			"final result plus stats, prefixed [session: <id>]; continue that session later with grok_reply.\n" +
			"Good for: a second opinion from a different model, work kept out of this context, or parallel " +
			"investigation.\n" +
			"Caution: with approval_mode 'yolo' (the server default) grok edits files and runs shell commands " +
			"as your user inside `cwd` without asking. For analysis-only work pass an allowed_tools list.",
		inputSchema: {
			type: "object",
			properties: {
				prompt: {
					type: "string",
					description:
						"The complete task. grok cannot see this conversation, so include everything it needs: " +
						"file paths, goal, constraints, expected output format.",
				},
				cwd: {
					type: "string",
					description:
						"Usually omit to use this server's cwd. If set, must be an absolute path (relative is " +
						"rejected). grok works and edits here, and reads AGENTS.md / project rules from here.",
				},
				...SHARED_PROPS,
				allowed_tools: {
					type: "string",
					description:
						"Comma-separated allowlist of grok tool ids, e.g. 'read_file,grep,list_dir' for a " +
						"read-only run. Internal ids (the shell tool is run_terminal_cmd, not bash).",
				},
				system_prompt_append: {
					type: "string",
					description: "Extra text appended to grok's system prompt for this run (`--rules`).",
				},
			},
			required: ["prompt"],
			additionalProperties: false,
		},
	},
	{
		name: "grok_reply",
		description:
			"Send a new turn to an existing grok session that is not executing right now — including one " +
			"that timed out or was cancelled: the session survives in grok's own store, so resume it here " +
			"instead of restarting with `grok`. grok still has its prior turns (but never this conversation), " +
			"so the follow-up can be short. Survives restarts of this server. For a turn still running under " +
			"'acp', use grok_send instead.",
		inputSchema: {
			type: "object",
			properties: {
				session: {
					type: "string",
					description: "Session id from a [session: <id>] prefix, or from grok_sessions.",
				},
				prompt: { type: "string", description: "Follow-up message for this session." },
				cwd: {
					type: "string",
					description: "Absolute path override. Defaults to the directory where the session started.",
				},
				...SHARED_PROPS,
				system_prompt_append: {
					type: "string",
					description: "Extra text appended to grok's system prompt for this run.",
				},
				allowed_tools: {
					type: "string",
					description: "Comma-separated allowlist of grok tool ids to keep for this run.",
				},
			},
			required: ["session", "prompt"],
			additionalProperties: false,
		},
	},
	{
		name: "grok_models",
		description:
			"List the models this grok installation can actually reach right now — read live from `grok models`. " +
			"Use it to pick a `model` value for `grok` / `grok_reply`. Starts no task.",
		inputSchema: {
			type: "object",
			properties: {
				search: {
					type: "string",
					description: "Optional substring filter on model id, e.g. 'grok-4', '4.6'.",
				},
			},
			additionalProperties: false,
		},
	},
	{
		name: "grok_send",
		description:
			"Deliver a message into a grok turn that is executing right now. The default transport 'acp' " +
			"keeps the turn reachable; 'print' runs cannot be reached, and a session that already finished " +
			"takes grok_reply, not grok_send. Returns immediately; grok's reaction appears in the answer of " +
			"the grok/grok_reply call still waiting on that turn. `grok_running` lists reachable sessions.\n" +
			"Note: the adapter reports the first result envelope; a follow_up queued behind the current turn " +
			"is delivered but its answer is not awaited by the original call.",
		inputSchema: {
			type: "object",
			properties: {
				session: {
					type: "string",
					description: "Session id of the running turn (see grok_running).",
				},
				message: {
					type: "string",
					description: "Text to deliver. Required for 'steer' and 'follow_up', ignored by 'abort'.",
				},
				command: {
					type: "string",
					enum: ["steer", "follow_up", "abort"],
					description:
						"'abort' (default) cancels the current turn via ACP session/cancel; 'steer' " +
						"cancels and immediately submits the message as a new user turn; 'follow_up' queues the " +
						"message without interrupting.",
				},
			},
			required: ["session"],
			additionalProperties: false,
		},
	},
	{
		name: "grok_running",
		description:
			"List grok turns executing at this moment — the ones grok_send can reach — with session id, " +
			"working directory, elapsed time, and messages already sent in. Only acp-transport runs " +
			"appear; 'print' runs are unreachable mid-run. For past sessions use grok_sessions.",
		inputSchema: { type: "object", properties: {}, additionalProperties: false },
	},
	{
		name: "grok_sessions",
		description:
			"List all grok sessions started through this server, newest first, with their working " +
			"directory — running or finished, including runs that timed out. Use it to recover an id for " +
			"grok_reply. For turns still executing (grok_send targets), use grok_running.",
		inputSchema: { type: "object", properties: {}, additionalProperties: false },
	},
];

// --- helpers --------------------------------------------------------------

export function toolResult(text: string, isError = false): ToolResult {
	return { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) };
}

function resolveCwd(requested: unknown): string {
	if (requested === undefined || requested === null || requested === "") return process.cwd();
	if (typeof requested !== "string") throw new Error("cwd must be a string");
	if (!requested.startsWith("/")) throw new Error(`cwd must be an absolute path: ${requested}`);
	if (!existsSync(requested) || !statSync(requested).isDirectory()) {
		throw new Error(`cwd does not exist or is not a directory: ${requested}`);
	}
	return requested;
}

function readTimeout(value: unknown): number | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "number" || !Number.isFinite(value) || value < 1000) {
		throw new Error("timeout_ms must be a number of milliseconds, at least 1000");
	}
	if (value > MAX_TIMEOUT_MS) {
		throw new Error(`timeout_ms ${value} exceeds the server ceiling of ${MAX_TIMEOUT_MS} ms`);
	}
	return value;
}

function readOverrides(input: Record<string, unknown>): RunOverrides {
	const overrides: RunOverrides = {};
	const model = input.model ?? DEFAULT_MODEL;
	if (model !== undefined && model !== null) {
		if (typeof model !== "string") throw new Error("model must be a string");
		overrides.model = model;
	}
	const approval = input.approval_mode ?? DEFAULT_APPROVAL_MODE;
	if (approval !== undefined && approval !== null) {
		if (!isApprovalMode(approval)) {
			throw new Error(`invalid approval_mode "${String(approval)}"; expected one of ${APPROVAL_MODES.join(", ")}`);
		}
		overrides.approval_mode = approval;
	}
	const effort = input.effort;
	if (effort !== undefined && effort !== null) {
		if (!isEffortLevel(effort)) {
			throw new Error(`invalid effort "${String(effort)}"; expected one of ${EFFORT_LEVELS.join(", ")}`);
		}
		overrides.effort = effort;
	}
	if (input.allowed_tools !== undefined && input.allowed_tools !== null) {
		if (typeof input.allowed_tools !== "string") throw new Error("allowed_tools must be a comma-separated string");
		overrides.allowed_tools = input.allowed_tools;
	}
	if (input.system_prompt_append !== undefined && input.system_prompt_append !== null) {
		if (typeof input.system_prompt_append !== "string") {
			throw new Error("system_prompt_append must be a string");
		}
		overrides.system_prompt_append = input.system_prompt_append;
	}
	return overrides;
}

function readPrompt(value: unknown, tool: string): string {
	if (typeof value !== "string" || value.trim() === "") {
		throw new Error(`${tool}: \`prompt\` is required and must be a non-empty string.`);
	}
	if (value.length > MAX_PROMPT) {
		throw new Error(
			`${tool}: prompt is ${value.length} chars, over the ${MAX_PROMPT} limit. ` +
				"Split the task or point grok at files instead.",
		);
	}
	return value;
}

interface Outcome {
	acc: Accumulator;
	result: RunResult;
	elapsedMs: number;
}

async function invokeGrok(transport: Transport, plan: RunPlan, ctx: CallContext): Promise<Outcome> {
	const acc = newAccumulator();
	const started = Date.now();
	const result = await transport.run(plan, ctx, (event) => {
		const note = accumulate(acc, event);
		if (note && ctx.progress) ctx.progress(note);
	});
	acc.capturedBytes = result.stdout.length;
	return { acc, result, elapsedMs: Date.now() - started };
}

/** True when the run ended outside the normal result path. */
function failedRun(outcome: Outcome): boolean {
	const { result } = outcome;
	return result.code !== 0 || Boolean(result.timedOut) || Boolean(result.cancelled) || Boolean(result.protocolError);
}

function renderSuccess(outcome: Outcome, prefix: string | null): ToolResult {
	const { acc, result, elapsedMs } = outcome;
	const answer = selectAnswer(acc);
	const problem = answerProblem(answer, acc);
	const warnings = tailStderr(result.stderr);
	const parts: string[] = [];
	if (prefix) parts.push(prefix);
	if (problem) parts.push(`[warning: ${problem}]`);
	if (warnings) parts.push(`[grok stderr: ${warnings}]`);

	if (answer.text) {
		parts.push(clip(answer.text));
	} else {
		parts.push(
			"grok returned no usable answer text: its message stream did not match the expected " +
				"`--output-format streaming-messages-json` contract.\n" +
				describeBrokenRun(acc),
		);
	}

	if (answer.source === "result-error") {
		const lastSaid = acc.assistantTexts[acc.assistantTexts.length - 1];
		if (lastSaid !== undefined && lastSaid !== answer.text) parts.push(`last thing grok said:\n${clip(lastSaid)}`);
	}

	parts.push(`---\n${summarize(acc, elapsedMs)}`);
	return toolResult(parts.join("\n\n"), Boolean(problem));
}

// --- tools ----------------------------------------------------------------

export async function callGrok(input: Record<string, unknown>, ctx: CallContext): Promise<ToolResult> {
	let prompt: string;
	let cwd: string;
	let overrides: RunOverrides;
	let timeoutMs: number | undefined;
	let transport: Transport;
	try {
		prompt = readPrompt(input.prompt, "grok");
		cwd = resolveCwd(input.cwd);
		overrides = readOverrides(input);
		timeoutMs = readTimeout(input.timeout_ms);
		transport = resolveTransport(input.transport);
	} catch (err) {
		return toolResult(`grok: ${(err as Error).message}`, true);
	}

	let sessionId: string = randomUUID();
	// Print chooses the id up front (`--session-id`). ACP learns grok's id from
	// `session/new` and reports it through onSessionId — remembering the
	// placeholder would list a session grok never created.
	if (transport.name !== "acp") rememberSession(sessionId, cwd, overrides);

	const plan: RunPlan = {
		cwd,
		sessionId,
		prompt,
		overrides,
		timeoutMs: timeoutMs ?? TIMEOUT_MS,
		onSessionId: (id) => {
			sessionId = id;
			rememberSession(id, cwd, overrides);
		},
	};
	const outcome = await withSlot(() => invokeGrok(transport, plan, ctx));
	if (outcome.result.sessionId) sessionId = outcome.result.sessionId;

	if (failedRun(outcome)) {
		return toolResult(
			renderFailure(outcome.acc, outcome.result, outcome.elapsedMs, {
				id: sessionId,
				tool: "grok",
				timeoutMs: timeoutMs ?? TIMEOUT_MS,
			}),
			true,
		);
	}

	const answerSource = selectAnswer(outcome.acc).source;
	const brokenAnswer = answerSource === "broken" || answerSource === "cut-off" || answerSource === "none";
	return renderSuccess(
		outcome,
		brokenAnswer
			? `note: session ${sessionId} never produced a result envelope; it stays listed by grok_sessions`
			: `[session: ${sessionId}]`,
	);
}

export async function callGrokReply(input: Record<string, unknown>, ctx: CallContext): Promise<ToolResult> {
	const session = input.session;
	if (typeof session !== "string" || session.trim() === "") {
		return toolResult("grok_reply: `session` is required.", true);
	}

	const known = getSession(session);
	let prompt: string;
	let cwd: string;
	let overrides: RunOverrides;
	let timeoutMs: number | undefined;
	let transport: Transport;
	try {
		prompt = readPrompt(input.prompt, "grok_reply");
		cwd = resolveCwd(input.cwd ?? known?.cwd);
		overrides = readOverrides({
			...input,
			model: input.model ?? known?.model,
			approval_mode: input.approval_mode ?? known?.approval_mode,
			effort: input.effort ?? known?.effort,
		});
		timeoutMs = readTimeout(input.timeout_ms);
		transport = resolveTransport(input.transport);
	} catch (err) {
		return toolResult(`grok_reply: ${(err as Error).message}`, true);
	}

	const plan: RunPlan = {
		cwd,
		sessionId: session,
		resume: true,
		prompt,
		overrides,
		timeoutMs: timeoutMs ?? TIMEOUT_MS,
	};
	const outcome = await withSessionLock(session, () => withSlot(() => invokeGrok(transport, plan, ctx)));

	if (failedRun(outcome)) {
		rememberSession(session, cwd, {});
		return toolResult(
			renderFailure(outcome.acc, outcome.result, outcome.elapsedMs, {
				id: session,
				tool: "grok_reply",
				timeoutMs: timeoutMs ?? TIMEOUT_MS,
			}),
			true,
		);
	}

	const remembered: { model?: string; approval_mode?: ApprovalMode; effort?: EffortLevel } = {};
	if (input.model !== undefined && overrides.model !== undefined) remembered.model = overrides.model;
	if (input.approval_mode !== undefined && overrides.approval_mode !== undefined) {
		remembered.approval_mode = overrides.approval_mode;
	}
	if (input.effort !== undefined && overrides.effort !== undefined) remembered.effort = overrides.effort;
	rememberSession(session, cwd, remembered);

	const isNew =
		/session does not exist/i.test(outcome.result.stderr) ||
		/Couldn't (start|resume) session/i.test(outcome.result.stderr) ||
		/No saved session/i.test(outcome.result.stderr);
	const prefix = isNew
		? `[warning: no existing session ${session} in ${cwd} — grok started a new one, so there is no prior context]`
		: null;
	return renderSuccess(outcome, prefix);
}

/**
 * Utility probe, not an agent run: `grok models` and parse the text catalog.
 * The reply is whatever grok prints — never fabricated. A probe that fails
 * reports why honestly.
 */
export async function callGrokModels(input: Record<string, unknown>, ctx: CallContext): Promise<ToolResult> {
	const search = input.search;
	if (search !== undefined && typeof search !== "string") {
		return toolResult("grok_models: `search` must be a string.", true);
	}

	const result = await withSlot(() =>
		runGrok(["models"], process.cwd(), {
			token: ctx.token,
			timeoutMs: MODELS_TIMEOUT_MS,
		}),
	);

	if (result.cancelled) return toolResult("grok_models was cancelled.", true);

	if (result.code !== 0) {
		return toolResult(
			`grok_models could not read the model catalog from grok (exit code ${result.code}).` +
				(result.stderr
					? `\n\n${tailStderr(result.stderr)}`
					: result.stdout
						? `\n\n${tailStderr(result.stdout)}`
						: ""),
			true,
		);
	}

	const rows: { id: string; def: boolean }[] = [];
	for (const raw of result.stdout.split("\n")) {
		const match = /^\s*[*+-]\s+(\S+)/.exec(raw);
		if (!match?.[1]) continue;
		rows.push({ id: match[1], def: /\(default\)/.test(raw) || raw.trim().startsWith("*") });
	}

	const needle = search?.toLowerCase();
	const visible = rows.filter((m) => !needle || m.id.toLowerCase().includes(needle));

	if (visible.length === 0) {
		if (rows.length === 0) {
			return toolResult(
				`grok_models could not parse the model catalog from grok.` +
					(result.stdout.trim() ? `\n\n${tailStderr(result.stdout)}` : " grok printed nothing."),
				true,
			);
		}
		return toolResult(search ? `No grok models match "${search}".` : "grok reported no available models.", true);
	}

	const seen = new Set<string>();
	const unique = visible.filter((m) => {
		if (seen.has(m.id)) return false;
		seen.add(m.id);
		return true;
	});

	const lines = unique.map((m) => `- ${m.id}${m.def ? " · default" : ""}`);
	return toolResult(`${unique.length} model(s):\n\n${lines.join("\n")}`);
}

export function callGrokSend(input: Record<string, unknown>): ToolResult {
	const session = input.session;
	if (typeof session !== "string" || session.trim() === "") {
		return toolResult("grok_send: `session` is required.", true);
	}

	const command = input.command ?? "abort";
	if (command !== "steer" && command !== "follow_up" && command !== "abort") {
		return toolResult(`grok_send: \`command\` must be steer, follow_up, or abort (got ${String(command)}).`, true);
	}

	const message = input.message;
	if (command !== "abort" && (typeof message !== "string" || message.trim() === "")) {
		return toolResult(`grok_send: \`message\` is required for ${command}.`, true);
	}
	if (message !== undefined && typeof message !== "string") {
		return toolResult("grok_send: `message` must be a string.", true);
	}

	const run = getRun(session);
	if (run === undefined) {
		const alive = listRuns();
		const hint =
			alive.length === 0
				? "No grok turn is running under the acp transport right now."
				: `Running sessions: ${alive.map((r) => r.sessionId).join(", ")}.`;
		return toolResult(
			`grok_send: session ${session} is not currently running, so there is nothing to send to. ${hint}\n` +
				"A finished session is continued with grok_reply instead. Only runs started with " +
				"transport 'acp' can be reached mid-run.",
			true,
		);
	}

	if (run.deliver) {
		run.deliver(command, typeof message === "string" ? message : undefined);
	} else {
		return toolResult("grok_send: this run has no delivery channel.", true);
	}
	run.sent.push({ at: Date.now(), type: String(command) });

	const elapsed = ((Date.now() - run.startedAt) / 1000).toFixed(1);
	const effect =
		command === "abort"
			? "The interrupted turn's report appears in the answer of the call that is waiting on it."
			: "grok decides when to act on it; the reaction appears in the answer of the call that is still " +
				"waiting on this turn.";
	return toolResult(`Sent ${command} to session ${session} (running for ${elapsed}s).\n${effect}`);
}

export function callGrokRunning(): ToolResult {
	const runs = listRuns();
	if (runs.length === 0) {
		return toolResult(
			"No grok turn is running under the acp transport. Runs started with transport 'print' do not " +
				"appear here — grok reads nothing while it works in that mode.",
		);
	}
	const rows = runs.map((run) => {
		const elapsed = ((Date.now() - run.startedAt) / 1000).toFixed(1);
		const sent = run.sent.length > 0 ? ` sent: ${run.sent.map((s) => s.type).join(",")}` : "";
		return `${run.sessionId}  ${elapsed}s  ${run.cwd}${sent}`;
	});
	return toolResult(`${rows.length} running:\n\n${rows.join("\n")}`);
}

export function callGrokSessions(): ToolResult {
	const rows = listSessions().map(([id, entry]) => {
		const when = entry.lastAccessed ? new Date(entry.lastAccessed).toISOString() : "unknown";
		return `${id}  ${when}  ${entry.cwd}`;
	});
	if (rows.length === 0) {
		return toolResult("No grok sessions recorded yet. Start one with the `grok` tool.");
	}
	return toolResult(`${rows.length} session(s), newest first:\n\n${rows.join("\n")}`);
}
