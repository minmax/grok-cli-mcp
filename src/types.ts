// Grok's wire shapes for `--output-format streaming-messages-json` and ACP.
// There is no published SDK to `import type` from, so these types describe what
// grok's own docs promise. Everything arriving from the grok process is still
// untrusted JSON: parse.ts verifies each value before it is used as one of them.

/** One NDJSON line from `--output-format streaming-messages-json`. */
export interface GrokMessage {
	type: string;
	subtype?: string;
	session_id?: string;
	uuid?: string;
	model?: string;
	message?: {
		id?: string;
		role?: string;
		model?: string;
		content?: unknown;
		stop_reason?: string | null;
		usage?: GrokUsage;
	};
	result?: string;
	is_error?: boolean;
	duration_ms?: number;
	duration_api_ms?: number;
	num_turns?: number;
	usage?: GrokUsage;
	permission_denials?: unknown;
	error?: { message?: string };
	parent_tool_use_id?: string | null;
}

export interface GrokUsage {
	input_tokens?: number;
	output_tokens?: number;
	cache_read_input_tokens?: number;
	cache_creation_input_tokens?: number;
	reasoning_tokens?: number;
}

export interface GrokContentBlock {
	type: string;
	text?: string;
	id?: string;
	name?: string;
	input?: unknown;
}

export interface GrokToolUseBlock {
	type: "tool_use";
	id?: string;
	name: string;
	input?: unknown;
}

// --- result subtype classification -----------------------------------------

// Grok's vocabulary (from headless streaming-messages-json docs):
// success | error_max_turns | error_during_execution | error_max_structured_output_retries.
// The schema's error_max_budget_usd is never emitted.

/** A finished answer. */
export const RESULT_OK = ["success"] as const;
/** The turn failed — out of turns, died mid-execution, or structured-output retries exhausted. */
export const RESULT_BAD = ["error_max_turns", "error_during_execution", "error_max_structured_output_retries"] as const;

export type ResultOk = (typeof RESULT_OK)[number];
export type ResultBad = (typeof RESULT_BAD)[number];

const RESULT_OK_SET: ReadonlySet<string> = new Set(RESULT_OK);
const RESULT_BAD_SET: ReadonlySet<string> = new Set(RESULT_BAD);

export function isResultOk(subtype: string): subtype is ResultOk {
	return RESULT_OK_SET.has(subtype);
}

export function isResultBad(subtype: string): subtype is ResultBad {
	return RESULT_BAD_SET.has(subtype);
}

// --- run configuration -----------------------------------------------------

/**
 * Permission modes grok actually accepts. `yolo` is the product name for
 * always-approve (`--always-approve` / `--yolo` / `bypassPermissions`).
 */
export const APPROVAL_MODES = [
	"yolo",
	"default",
	"acceptEdits",
	"plan",
	"auto",
	"dontAsk",
	"bypassPermissions",
] as const;
export type ApprovalMode = (typeof APPROVAL_MODES)[number];

export function isApprovalMode(value: unknown): value is ApprovalMode {
	return typeof value === "string" && (APPROVAL_MODES as readonly string[]).includes(value);
}

/**
 * Reasoning effort tiers. Grok has a CLI flag (`--effort` / `--reasoning-effort`)
 * so this works on both transports.
 */
export const EFFORT_LEVELS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number];

export function isEffortLevel(value: unknown): value is EffortLevel {
	return typeof value === "string" && (EFFORT_LEVELS as readonly string[]).includes(value);
}

/** What a grok run is allowed to override, once validated. */
export interface RunOverrides {
	model?: string;
	approval_mode?: ApprovalMode;
	allowed_tools?: string;
	system_prompt_append?: string;
	effort?: EffortLevel;
}

export interface SessionRecord {
	cwd: string;
	lastAccessed: number;
	model?: string;
	approval_mode?: ApprovalMode;
	effort?: EffortLevel;
}

// --- MCP / JSON-RPC -------------------------------------------------------

export type JsonRpcId = string | number | null;

export interface JsonRpcMessage {
	jsonrpc?: unknown;
	id?: JsonRpcId;
	method?: unknown;
	params?: Record<string, unknown>;
}

export interface ToolTextContent {
	type: "text";
	text: string;
}

export interface ToolResult {
	content: ToolTextContent[];
	isError?: boolean;
}

export interface ToolDefinition {
	name: string;
	description: string;
	inputSchema: Record<string, unknown>;
}

/** Cooperative cancellation: one token per in-flight request. */
export interface CancelToken {
	readonly cancelled: boolean;
	subscribe(fn: () => void): () => void;
	cancel(): void;
}

export interface CallContext {
	token: CancelToken;
	progress?: (message: string) => void;
}
