// Two ways to drive grok, behind one interface.
//
// `acp` (default) runs `grok agent --always-approve stdio`: the process stays
// up and speaks JSON-RPC on stdin. That is what makes a running turn reachable
// — a message can be sent into it while it works — and it carries grok's own
// `session/cancel` on deadline or cancel.
//
// `print` runs `grok -p … --output-format streaming-messages-json`: one process
// per turn, grok exits when it is done. Simple, no stdin protocol. Follow-ups
// use `--resume`. Print cannot be reached mid-run.
//
// This adapter never decides to send anything on its own. It exposes grok's
// protocol and the caller chooses if and when to use it.
//
// Print emits grok's streaming-messages-json stream. ACP converts session/update
// notifications into the same message shapes, so everything downstream (the
// accumulator, result selection, the stats line, failure reporting) is shared.

import type { RunResult } from "../grok-process.ts";
import type { CallContext, RunOverrides } from "../types.ts";

export type TransportName = "print" | "acp";

export interface RunPlan {
	cwd: string;
	/**
	 * The conversation this turn belongs to. Print mode passes it as
	 * `--session-id` or `--resume`. ACP uses it for `session/load` on resume;
	 * a new ACP session takes grok's id from `session/new` and reports it via
	 * `onSessionId`.
	 */
	sessionId: string;
	resume?: boolean;
	prompt: string;
	overrides: RunOverrides;
	/**
	 * Hard wall clock: grok is killed at this point. Undefined means no deadline
	 * for this run.
	 */
	timeoutMs: number | undefined;
	/** ACP reports grok's session id as soon as `session/new` succeeds. */
	onSessionId?: (id: string) => void;
}

export interface Transport {
	readonly name: TransportName;
	/** True when a message can be sent into a turn that is already running. */
	readonly acceptsMidRunMessages: boolean;
	run(plan: RunPlan, ctx: CallContext, onEvent: (event: unknown) => void): Promise<RunResult>;
}
