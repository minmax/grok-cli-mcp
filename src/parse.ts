// Narrowing for data that crosses a process boundary.
//
// src/types.ts describes what grok promises to send. What actually arrives is a
// parsed JSON value from another process: fields can be missing, retyped, or
// new. Everything here turns `unknown` into a value that is safe to read — or
// into null, never into a guess.

import type { GrokContentBlock, GrokMessage, GrokToolUseBlock, GrokUsage } from "./types.ts";
import { isResultBad, isResultOk } from "./types.ts";

export function asRecord(value: unknown): Record<string, unknown> | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
	return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function asFiniteNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** A grok message, if the value at least carries a `type` tag. */
export function asGrokMessage(value: unknown): (GrokMessage & { type: string }) | null {
	const record = asRecord(value);
	if (record === null || typeof record.type !== "string") return null;
	return record as unknown as GrokMessage & { type: string };
}

// --- assistant messages ----------------------------------------------------

export interface ParsedUsage {
	input: number;
	output: number;
}

export function readUsage(value: unknown): ParsedUsage {
	const usage = asRecord(value) as Partial<GrokUsage> | null;
	return {
		input: asFiniteNumber(usage?.input_tokens) ?? 0,
		output: asFiniteNumber(usage?.output_tokens) ?? 0,
	};
}

export interface ParsedToolCall {
	name: string;
	/** The written path, when this call targets one. */
	path: string | undefined;
}

export interface ParsedAssistantMessage {
	model: string | undefined;
	/** Text blocks of this message, joined; empty when it carried none. */
	text: string;
	toolCalls: ParsedToolCall[];
	usage: ParsedUsage;
}

/**
 * Read the inner API message of an `assistant` envelope. Returns null for
 * anything that is not shaped like one — none of that can be the answer.
 */
export function readAssistantMessage(value: unknown): ParsedAssistantMessage | null {
	const envelope = asRecord(value);
	if (envelope === null || envelope.type !== "assistant") return null;
	const inner = asRecord(envelope.message);
	if (inner === null || inner.role !== "assistant") return null;

	const texts: string[] = [];
	const toolCalls: ParsedToolCall[] = [];
	const blocks = Array.isArray(inner.content) ? (inner.content as GrokContentBlock[]) : [];

	for (const raw of blocks) {
		const block = asRecord(raw);
		if (block === null || typeof block.type !== "string") continue;

		if (block.type === "text") {
			const text = asString(block.text)?.trim();
			if (text) texts.push(text);
			continue;
		}
		if (block.type === "tool_use") {
			const call = block as unknown as Partial<GrokToolUseBlock>;
			const name = asString(call.name);
			if (!name) continue;
			const args = asRecord(call.input);
			toolCalls.push({
				name,
				path: asString(args?.file_path) ?? asString(args?.path) ?? asString(args?.target_file),
			});
		}
	}

	return {
		model: asString(inner.model),
		text: texts.join("\n\n"),
		toolCalls,
		usage: readUsage(inner.usage),
	};
}

// --- result envelope -------------------------------------------------------

export type ParsedResult =
	| { kind: "ok"; text: string; usage: ParsedUsage; numTurns: number; durationMs: number; denials: number }
	| {
			kind: "bad";
			subtype: string;
			message: string;
			usage: ParsedUsage;
			numTurns: number;
			durationMs: number;
			denials: number;
	  }
	| { kind: "unknown"; subtype: string };

/** Tool calls the approval mode refused, when the envelope says. */
function readDenials(value: unknown): number {
	return Array.isArray(value) ? value.length : 0;
}

/**
 * Read a `result` envelope. The subtype decides everything: known-good carries
 * the answer text, known-bad carries a failure reason, anything else is a
 * contract violation the caller must see rather than a guess to normalize.
 */
export function readResultMessage(value: unknown): ParsedResult | null {
	const record = asRecord(value);
	if (record === null || record.type !== "result") return null;
	const subtype = asString(record.subtype);
	if (subtype === undefined) return null;

	if (isResultOk(subtype)) {
		return {
			kind: "ok",
			text: asString(record.result) ?? "",
			usage: readUsage(record.usage),
			numTurns: asFiniteNumber(record.num_turns) ?? 0,
			durationMs: asFiniteNumber(record.duration_ms) ?? 0,
			denials: readDenials(record.permission_denials),
		};
	}
	if (isResultBad(subtype)) {
		const error = asRecord(record.error);
		return {
			kind: "bad",
			subtype,
			message: asString(error?.message) ?? `grok reported ${subtype} without an error message`,
			usage: readUsage(record.usage),
			numTurns: asFiniteNumber(record.num_turns) ?? 0,
			durationMs: asFiniteNumber(record.duration_ms) ?? 0,
			denials: readDenials(record.permission_denials),
		};
	}
	return { kind: "unknown", subtype };
}

// --- system init -----------------------------------------------------------

/** Model reported by the `system` init message, used when no assistant message named one. */
export function readSystemModel(value: unknown): string | undefined {
	const record = asRecord(value);
	if (record === null || record.type !== "system") return undefined;
	return asString(record.model);
}

// --- ACP JSON-RPC ---------------------------------------------------------

export function asJsonRpc(value: unknown): Record<string, unknown> | null {
	const record = asRecord(value);
	if (record === null || record.jsonrpc !== "2.0") return null;
	return record;
}
