// Session bookkeeping and the per-session mutex: one writer per session.

import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, makeWorkspace, sessionIdOf, type Workspace } from "./helpers/client.ts";

let ws: Workspace;

beforeAll(() => {
	ws = makeWorkspace();
});
afterAll(() => ws.cleanup());

describe("session map", () => {
	it("survives a restart of this server via the state file", async () => {
		const first = new Client(ws.env, ws.dir);
		await first.handshake();
		const res = await first.tool("grok", { prompt: "go", cwd: ws.dir });
		const id = sessionIdOf(res.text);
		first.close();

		const second = new Client(ws.env, ws.dir);
		await second.handshake();
		const sessions = await second.tool("grok_sessions");
		second.close();
		expect(sessions.text).toContain(id);
		expect(sessions.text).toContain(ws.dir);
	});

	it("reports an empty map before any session exists", async () => {
		const fresh = makeWorkspace();
		try {
			const client = new Client(fresh.env, fresh.dir);
			await client.handshake();
			const sessions = await client.tool("grok_sessions");
			client.close();
			expect(sessions.text).toContain("No grok sessions recorded yet");
		} finally {
			fresh.cleanup();
		}
	});
});

describe("per-session serialization", () => {
	it("never runs two grok processes on one session at once", async () => {
		const lockFile = join(ws.dir, "overlap.lock");
		const client = new Client(
			{ ...ws.env, FAKE_MODE: "overlap", FAKE_LOCK_FILE: lockFile, FAKE_DELAY_MS: "250" },
			ws.dir,
		);
		await client.handshake();

		const session = "11111111-2222-4333-8444-555555555555";
		const [first, second] = await Promise.all([
			client.tool("grok_reply", { session, prompt: "first", cwd: ws.dir }),
			client.tool("grok_reply", { session, prompt: "second", cwd: ws.dir }),
		]);
		client.close();

		expect(first.isError).toBe(false);
		expect(second.isError).toBe(false);
		expect(first.text).toContain("EXCLUSIVE");
		expect(second.text).toContain("EXCLUSIVE");
		expect(first.text).not.toContain("OVERLAP");
		expect(second.text).not.toContain("OVERLAP");
	});
});
