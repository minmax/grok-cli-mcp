// Spawning grok, and the lifecycle guarantees around it: timeouts, cancellation,
// and never leaving a process behind.

import { spawn } from "node:child_process";
import {
	GROK_BIN,
	GROK_WRAP,
	INTERRUPT_GRACE_MS,
	KILL_GRACE_MS,
	MAX_CAPTURE,
	MAX_CONCURRENT,
	MAX_LINE,
	TIMEOUT_MS,
} from "./config.ts";
import type { CancelToken } from "./types.ts";

export interface RunResult {
	code: number;
	stdout: string;
	stderr: string;
	timedOut?: boolean;
	cancelled?: boolean;
	/**
	 * How an interrupted run actually ended: `interrupt` means the transport
	 * closed the turn in-protocol and grok exited on its own, `signal` means it
	 * had to be killed. Only set when the run was interrupted.
	 */
	endedBy?: "interrupt" | "signal";
	/**
	 * A protocol-level failure the transport detected outside the message stream —
	 * a failed or timed-out initialize handshake, for example. The run is reported
	 * as failed even if the process exits 0.
	 */
	protocolError?: string;
	/**
	 * Session id grok reported (ACP `session/new`), when it differs from the id
	 * the caller generated. Print mode uses the caller-chosen `--session-id`.
	 */
	sessionId?: string;
}

/** Writing side of a running grok process, for transports that talk back. */
export interface GrokHandle {
	/** Send one JSONL message on stdin. No-op once the process is gone. */
	send(message: unknown): void;
	/** Close stdin, which is how grok's bidirectional mode is asked to shut down. */
	endInput(): void;
	/**
	 * Signal the whole process group directly — the escape hatch for failures the
	 * wall clock should not have to wait out, like a handshake that never lands.
	 */
	kill(signal: NodeJS.Signals): void;
}

export interface RunOptions {
	/** Called for each parsed JSON line of grok's stdout stream. */
	onEvent?: (event: unknown) => void;
	token?: CancelToken | undefined;
	/** Overrides the default wall clock for this run. */
	timeoutMs?: number | undefined;
	/**
	 * Open stdin as a pipe and hand the caller a writer. Print mode leaves stdin
	 * closed; acp mode needs it to send JSON-RPC.
	 */
	onStart?: (handle: GrokHandle) => void;
	stdin?: "ignore" | "pipe";
	/**
	 * Asked first when a run has to end early, before any signal is sent.
	 *
	 * A transport that can end the turn in-protocol gets INTERRUPT_GRACE_MS to do
	 * so; signals follow either way. Signalling straight away can cost the tail of
	 * the stream — possibly the result envelope grok was in the middle of writing.
	 */
	gracefulStop?: (reason: "timeout" | "cancelled") => void;
}

/**
 * Live children, so shutdown can take their whole process groups with it.
 * Detached children do not die with this process on their own.
 */
const liveTrees = new Set<(signal: NodeJS.Signals) => void>();

export function treeCount(): number {
	return liveTrees.size;
}

export function killAllTrees(signal: NodeJS.Signals): void {
	for (const tree of [...liveTrees]) tree(signal);
}

export function makeCancelToken(): CancelToken {
	const listeners = new Set<() => void>();
	let cancelled = false;
	return {
		get cancelled() {
			return cancelled;
		},
		subscribe(fn: () => void) {
			if (cancelled) {
				fn();
				return () => {};
			}
			listeners.add(fn);
			return () => {
				listeners.delete(fn);
			};
		},
		cancel() {
			if (cancelled) return;
			cancelled = true;
			for (const fn of listeners) {
				try {
					fn();
				} catch (err) {
					process.stderr.write(`grok-mcp: cancel listener failed: ${(err as Error).message}\n`);
				}
			}
			listeners.clear();
		},
	};
}

// --- concurrency ----------------------------------------------------------

let running = 0;
const waiting: (() => void)[] = [];

/** Grok runs are heavy and the client may fan out, so cap how many run at once. */
export async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
	if (running >= MAX_CONCURRENT) {
		await new Promise<void>((resolve) => {
			waiting.push(resolve);
		});
	} else {
		running += 1;
	}
	try {
		return await fn();
	} finally {
		const next = waiting.shift();
		if (next) next();
		else running -= 1;
	}
}

// --- running grok -----------------------------------------------------------

function buildCommand(args: string[]): { command: string; argv: string[] } {
	if (!GROK_WRAP) return { command: GROK_BIN, argv: args };
	const parts = GROK_WRAP.split(/\s+/);
	const [command, ...prefix] = parts;
	return { command: command ?? GROK_BIN, argv: [...prefix, GROK_BIN, ...args] };
}

function appendCapped(current: string, chunk: string): string {
	if (current.length >= MAX_CAPTURE) return current;
	return current + chunk.slice(0, MAX_CAPTURE - current.length);
}

/**
 * Runs grok, streaming NDJSON lines to onEvent.
 * Resolves with the raw capture plus exit status; never rejects.
 */
export function runGrok(args: string[], cwd: string, options: RunOptions = {}): Promise<RunResult> {
	const { onEvent, token } = options;
	const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;

	return new Promise<RunResult>((resolve) => {
		if (token?.cancelled) {
			resolve({ code: -1, stdout: "", stderr: "", cancelled: true });
			return;
		}

		const { command, argv } = buildCommand(args);
		let child: ReturnType<typeof spawn>;
		try {
			child = spawn(command, argv, {
				cwd,
				stdio: [options.stdin ?? "ignore", "pipe", "pipe"],
				env: process.env,
				detached: true,
			});
		} catch (err) {
			resolve({ code: -1, stdout: "", stderr: `failed to spawn ${command}: ${(err as Error).message}` });
			return;
		}

		let stdout = "";
		let stderr = "";
		let pending = "";
		let timedOut = false;
		let cancelled = false;
		let killTimer: NodeJS.Timeout | undefined;
		let gracefulTimer: NodeJS.Timeout | undefined;
		let endedBy: "interrupt" | "signal" | undefined;

		const signalTree = (signal: NodeJS.Signals): void => {
			try {
				if (child.pid !== undefined) process.kill(-child.pid, signal);
			} catch {
				try {
					child.kill(signal);
				} catch {
					// Already dead — nothing to do.
				}
			}
		};

		const hardStop = (): void => {
			endedBy = "signal";
			signalTree("SIGTERM");
			killTimer ??= setTimeout(() => signalTree("SIGKILL"), KILL_GRACE_MS);
		};

		let stopping = false;
		const stop = (reason: "timeout" | "cancelled"): void => {
			if (stopping) return;
			stopping = true;
			if (reason === "timeout") timedOut = true;
			if (reason === "cancelled") cancelled = true;

			if (options.gracefulStop) {
				endedBy = "interrupt";
				options.gracefulStop(reason);
				gracefulTimer = setTimeout(hardStop, INTERRUPT_GRACE_MS);
				return;
			}
			hardStop();
		};

		liveTrees.add(signalTree);
		const timer = timeoutMs === undefined ? undefined : setTimeout(() => stop("timeout"), timeoutMs);
		const unsubscribe = token?.subscribe(() => stop("cancelled")) ?? ((): void => {});

		if (options.onStart) {
			options.onStart({
				send: (payload: unknown) => {
					if (child.stdin === null || child.stdin.destroyed || child.stdin.writableEnded) return;
					child.stdin.write(`${JSON.stringify(payload)}\n`, (err) => {
						if (err) process.stderr.write(`grok-mcp: could not write to grok stdin: ${err.message}\n`);
					});
				},
				endInput: () => {
					if (child.stdin === null || child.stdin.writableEnded) return;
					child.stdin.end();
				},
				kill: (signal) => {
					signalTree(signal);
				},
			});
		}

		const consumeLine = (line: string): void => {
			const trimmed = line.trim();
			if (!trimmed || !onEvent) return;
			try {
				onEvent(JSON.parse(trimmed));
			} catch {
				// Not a JSON message line — the raw capture keeps it for diagnostics.
			}
		};

		child.stdout?.setEncoding("utf8");
		child.stderr?.setEncoding("utf8");

		child.stdout?.on("data", (chunk: string) => {
			stdout = appendCapped(stdout, chunk);
			if (!onEvent) return;
			pending += chunk;
			let newline = pending.indexOf("\n");
			while (newline !== -1) {
				consumeLine(pending.slice(0, newline));
				pending = pending.slice(newline + 1);
				newline = pending.indexOf("\n");
			}
			if (pending.length > MAX_LINE) {
				process.stderr.write(
					`grok-mcp: dropping an over-long message line (${pending.length} > ${MAX_LINE} chars)\n`,
				);
				pending = "";
			}
		});

		child.stderr?.on("data", (chunk: string) => {
			stderr = appendCapped(stderr, chunk);
		});

		const finish = (result: RunResult): void => {
			clearTimeout(timer);
			if (killTimer) clearTimeout(killTimer);
			if (gracefulTimer) clearTimeout(gracefulTimer);
			liveTrees.delete(signalTree);
			unsubscribe();
			signalTree("SIGTERM");
			if (pending) {
				consumeLine(pending);
				pending = "";
			}
			resolve(result);
		};

		child.on("error", (err: Error) => {
			finish({ code: -1, stdout, stderr: `${stderr}\n${command}: ${err.message}`.trim() });
		});
		child.on("close", (code: number | null) => {
			finish({ code: code ?? -1, stdout, stderr, timedOut, cancelled, ...(endedBy ? { endedBy } : {}) });
		});
	});
}
