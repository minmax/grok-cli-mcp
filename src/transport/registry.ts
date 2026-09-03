// Sessions that are running right now under the acp transport, and therefore
// reachable: grok's agent stdio reads JSON-RPC from stdin while it works.
//
// This is a directory, not a policy. Nothing here decides to send anything.

import type { GrokHandle } from "../grok-process.ts";

export type MidRunCommand = "abort" | "steer" | "follow_up";

export interface LiveRun {
	sessionId: string;
	cwd: string;
	startedAt: number;
	handle: GrokHandle;
	/** ACP-only: deliver abort / steer / follow_up into the live turn. */
	deliver?: (command: MidRunCommand, message?: string) => void;
	/** Messages the caller sent into this run, for the record. */
	sent: { at: number; type: string }[];
}

const live = new Map<string, LiveRun>();

export function registerRun(run: Omit<LiveRun, "sent">): () => void {
	const entry: LiveRun = { ...run, sent: [] };
	live.set(run.sessionId, entry);
	return () => {
		if (live.get(run.sessionId) === entry) live.delete(run.sessionId);
	};
}

export function getRun(sessionId: string): LiveRun | undefined {
	return live.get(sessionId);
}

export function listRuns(): LiveRun[] {
	return [...live.values()].sort((a, b) => a.startedAt - b.startedAt);
}
