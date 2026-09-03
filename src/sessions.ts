// Grok owns the conversation on disk (`--session-id` / `--resume` / ACP
// session/load); this only remembers which directory a session belongs to, so
// `grok_reply` resumes in the right project.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { MAX_SESSIONS, STATE_FILE } from "./config.ts";
import { asRecord } from "./parse.ts";
import type { ApprovalMode, EffortLevel, SessionRecord } from "./types.ts";
import { isApprovalMode, isEffortLevel } from "./types.ts";

const sessions = new Map<string, SessionRecord>();

function readRecord(value: unknown): SessionRecord | null {
	const entry = asRecord(value);
	if (entry === null || typeof entry.cwd !== "string") return null;
	const record: SessionRecord = {
		cwd: entry.cwd,
		lastAccessed: typeof entry.lastAccessed === "number" ? entry.lastAccessed : 0,
	};
	if (typeof entry.model === "string") record.model = entry.model;
	if (isApprovalMode(entry.approval_mode)) record.approval_mode = entry.approval_mode;
	if (isEffortLevel(entry.effort)) record.effort = entry.effort;
	return record;
}

function readStateFile(): Map<string, SessionRecord> {
	const found = new Map<string, SessionRecord>();
	try {
		const parsed = asRecord(JSON.parse(readFileSync(STATE_FILE, "utf8")));
		if (parsed?.version !== 1) return found;
		const stored = asRecord(parsed.sessions);
		if (stored === null) return found;
		for (const [id, value] of Object.entries(stored)) {
			const record = readRecord(value);
			if (record !== null) found.set(id, record);
		}
	} catch {
		// No state yet, or it is unreadable — start empty rather than fail.
	}
	return found;
}

export function loadSessions(): void {
	sessions.clear();
	for (const [id, record] of readStateFile()) sessions.set(id, record);
	prune();
}

function prune(): void {
	if (sessions.size <= MAX_SESSIONS) return;
	const ordered = [...sessions.entries()].sort((a, b) => a[1].lastAccessed - b[1].lastAccessed);
	for (const [id] of ordered.slice(0, sessions.size - MAX_SESSIONS)) sessions.delete(id);
}

/**
 * Re-read before writing: another server process may own sessions this one has
 * never seen, and a blind snapshot write would delete them. tmp+rename only buys
 * atomicity of a single write, not read-modify-write safety.
 */
function save(): void {
	try {
		mkdirSync(dirname(STATE_FILE), { recursive: true });
		const merged = readStateFile();
		for (const [id, record] of sessions) merged.set(id, record);

		const ordered = [...merged.entries()].sort((a, b) => b[1].lastAccessed - a[1].lastAccessed);
		const payload = { version: 1, sessions: Object.fromEntries(ordered.slice(0, MAX_SESSIONS)) };
		const tmp = `${STATE_FILE}.${process.pid}.tmp`;
		writeFileSync(tmp, JSON.stringify(payload), { mode: 0o600 });
		renameSync(tmp, STATE_FILE);
	} catch (err) {
		process.stderr.write(`grok-mcp: could not persist sessions: ${(err as Error).message}\n`);
	}
}

export function getSession(id: string): SessionRecord | undefined {
	return sessions.get(id);
}

export function listSessions(): [string, SessionRecord][] {
	return [...sessions.entries()].sort((a, b) => b[1].lastAccessed - a[1].lastAccessed);
}

export interface RememberOptions {
	model?: string | undefined;
	approval_mode?: ApprovalMode | undefined;
	effort?: EffortLevel | undefined;
}

/**
 * Only overwrite what was actually supplied: spreading `{model: undefined}` over
 * the previous entry would erase a remembered choice, and the next reply would
 * silently fall back to the default model.
 */
export function rememberSession(id: string, cwd: string, extra: RememberOptions = {}): void {
	const prev = sessions.get(id);
	const next: SessionRecord = { ...prev, cwd, lastAccessed: Date.now() };
	if (extra.model !== undefined) next.model = extra.model;
	if (extra.approval_mode !== undefined) next.approval_mode = extra.approval_mode;
	if (extra.effort !== undefined) next.effort = extra.effort;
	sessions.set(id, next);
	prune();
	save();
}

// --- per-session mutex ----------------------------------------------------

/**
 * Two grok processes writing one session would race its history. Process-local
 * only — see README for the cross-process caveat.
 */
const sessionLocks = new Map<string, { tail: Promise<unknown> }>();

export async function withSessionLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
	const previous = sessionLocks.get(id)?.tail ?? Promise.resolve();
	let release!: () => void;
	const current = new Promise<void>((resolve) => {
		release = resolve;
	});
	const handle = { tail: previous.then(() => current) };
	sessionLocks.set(id, handle);
	await previous;
	try {
		return await fn();
	} finally {
		release();
		void Promise.resolve().then(() => {
			if (sessionLocks.get(id) === handle) sessionLocks.delete(id);
		});
	}
}

/** Test seam: how many locks are still held. */
export function lockCount(): number {
	return sessionLocks.size;
}
