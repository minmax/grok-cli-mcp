import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type ApprovalMode, isApprovalMode } from "./types.ts";

function numEnv(name: string, fallback: number, min: number): number {
	const raw = process.env[name];
	if (raw === undefined || raw === "") return fallback;
	const value = Number(raw);
	if (!Number.isFinite(value) || value < min) {
		process.stderr.write(`grok-mcp: ignoring invalid ${name}=${raw}, using ${fallback}\n`);
		return fallback;
	}
	return value;
}

/** Like numEnv, but an absent variable means "no limit" rather than a number. */
function numEnvOrUndefined(name: string, min: number): number | undefined {
	const raw = process.env[name];
	if (raw === undefined || raw === "") return undefined;
	const value = Number(raw);
	if (!Number.isFinite(value) || value < min) {
		process.stderr.write(`grok-mcp: ignoring invalid ${name}=${raw}, using no limit\n`);
		return undefined;
	}
	return value;
}

export const GROK_BIN = process.env.GROK_MCP_BIN ?? "grok";

/**
 * Optional command prefix, e.g. GROK_MCP_WRAP="sandbox-exec -f /path/profile.sb".
 * Lets you jail grok without this server knowing anything about the sandbox.
 */
export const GROK_WRAP = (process.env.GROK_MCP_WRAP ?? "").trim();

/**
 * Server-wide wall clock for one run. Off by default: only the caller knows how
 * long its own task may take, so the right deadline is a property of the task,
 * not of the server. Set GROK_MCP_TIMEOUT_MS to install a default; a caller can
 * still raise or lower it per call with `timeout_ms`.
 */
export const TIMEOUT_MS = numEnvOrUndefined("GROK_MCP_TIMEOUT_MS", 1_000);
/** Hard ceiling on what a per-call `timeout_ms` may ask for. 24h by default. */
export const MAX_TIMEOUT_MS = numEnv("GROK_MCP_MAX_TIMEOUT_MS", 86_400_000, 1_000);
export const KILL_GRACE_MS = numEnv("GROK_MCP_KILL_GRACE_MS", 5_000, 0);

/**
 * How long the acp transport — which can end a turn in-protocol with grok's
 * own `session/cancel` — gets to do so before signals are sent.
 */
export const INTERRUPT_GRACE_MS = numEnv("GROK_MCP_INTERRUPT_GRACE_MS", 5_000, 0);

/**
 * How long the ACP initialize handshake may take after spawn, before the run
 * is failed and the process is signalled.
 */
export const INIT_TIMEOUT_MS = numEnv("GROK_MCP_INIT_TIMEOUT_MS", 15_000, 1_000);

/**
 * Wall clock for one `grok_models` probe (`grok models`). A hung CLI must not
 * hang the tool forever.
 */
export const MODELS_TIMEOUT_MS = numEnv("GROK_MCP_MODELS_TIMEOUT_MS", 60_000, 1_000);

/**
 * The answer is what the caller asked for, so it is NOT truncated by default.
 * Set GROK_MCP_MAX_OUTPUT to opt into a cap. MAX_CAPTURE below is the only
 * backstop, and it bounds the read buffer so a runaway stream cannot exhaust
 * memory — a process guard, not an editorial limit on the answer.
 */
export const MAX_OUTPUT = process.env.GROK_MCP_MAX_OUTPUT
	? numEnv("GROK_MCP_MAX_OUTPUT", 4_000_000, 1_000)
	: Number.POSITIVE_INFINITY;

/** stderr is diagnostics, not the deliverable: keep only a small tail. */
export const STDERR_LIMIT = numEnv("GROK_MCP_STDERR_LIMIT", 1_500, 200);

/**
 * Forward stderr verbatim, including lines that parse as protocol messages.
 * The strict reading of the protocol is that messages belong on stdout, so such
 * a line is a channel violation; dropping it is a guard on top, and this switch
 * turns the guard off.
 */
export const KEEP_STDERR_EVENTS = process.env.GROK_MCP_STDERR_KEEP_EVENTS === "1";

export const MAX_CAPTURE = numEnv("GROK_MCP_MAX_CAPTURE", 16_000_000, 100_000);

/**
 * Bounds on a single unterminated line: one from grok's message stream, one from
 * the client's JSON-RPC stream. Without them a stream that never sends a newline
 * grows until the process dies, taking every pending response with it.
 */
export const MAX_LINE = numEnv("GROK_MCP_MAX_LINE", 8_000_000, 100_000);
export const MAX_FRAME = numEnv("GROK_MCP_MAX_FRAME", 8_000_000, 100_000);

export const MAX_SESSIONS = numEnv("GROK_MCP_MAX_SESSIONS", 200, 1);
export const MAX_CONCURRENT = numEnv("GROK_MCP_MAX_CONCURRENT", 100, 1);

export const STATE_FILE = process.env.GROK_MCP_STATE ?? join(homedir(), ".local", "state", "grok-mcp", "sessions.json");

export const DEFAULT_MODEL = process.env.GROK_MCP_MODEL ?? null;

/**
 * The server delegates tasks, and a delegation the agent cannot act on is
 * useless — so the default is grok's always-approve mode, loudly. Set
 * GROK_MCP_APPROVAL_MODE to something narrower for the whole server; per-call
 * `approval_mode` narrows further. An invalid env value falls back to yolo too,
 * with a warning — silently downgrading to a mode that blocks every tool would
 * break every delegation in ways callers would read as the agent being broken.
 */
function defaultApprovalMode(): ApprovalMode {
	const raw = process.env.GROK_MCP_APPROVAL_MODE;
	if (raw === undefined || raw === "") return "yolo";
	if (!isApprovalMode(raw)) {
		process.stderr.write(`grok-mcp: ignoring invalid GROK_MCP_APPROVAL_MODE=${raw}, using yolo\n`);
		return "yolo";
	}
	return raw;
}
export const DEFAULT_APPROVAL_MODE: ApprovalMode = defaultApprovalMode();

/**
 * Which way to drive grok when a call does not say.
 *
 * `acp` by default: it is a superset of what `print` can do. Same answer
 * contract, plus a running turn stays reachable via grok_send — and an
 * interrupted one is ended with grok's own `session/cancel`, which keeps the
 * tail of the stream that a signal would cost. `print` (`grok -p … --output-format
 * streaming-messages-json`, one process per turn) remains for anything that
 * prefers a process that cannot be talked to.
 */
export const DEFAULT_TRANSPORT = process.env.GROK_MCP_TRANSPORT === "print" ? "print" : "acp";

export const MAX_PROMPT = 2_000_000;

function readVersion(): string {
	try {
		const manifest = readFileSync(new URL("../package.json", import.meta.url), "utf8");
		const version = (JSON.parse(manifest) as { version?: unknown }).version;
		if (typeof version === "string") return version;
	} catch {
		// Unreadable manifest is not worth failing a handshake over.
	}
	return "0.0.0";
}

export const SERVER_INFO = { name: "grok", version: readVersion() } as const;
export const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"] as const;
export const FALLBACK_PROTOCOL = "2025-06-18";
