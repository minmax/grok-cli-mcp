// The answer is the contract: what comes back, how it is shaped, and what never
// leaks into it.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, makeWorkspace, sessionIdOf, type Workspace } from "./helpers/client.ts";

let ws: Workspace;

beforeAll(() => {
	ws = makeWorkspace();
});
afterAll(() => ws.cleanup());

describe("happy path", () => {
	it("returns the result text, session prefix, stats and written files", async () => {
		const client = new Client(ws.env, ws.dir);
		await client.handshake();
		const res = await client.tool("grok", { prompt: "go", cwd: ws.dir });
		client.close();

		expect(res.isError).toBe(false);
		const id = sessionIdOf(res.text);
		expect(res.text).toContain(`[session: ${id}]`);
		expect(res.text).toContain("FINAL ANSWER");
		expect(res.text).not.toContain("NARRATION");

		const stats = res.text.split("---\n")[1];
		expect(stats).toContain("search_replace");
		expect(stats).toContain("grok wrote: note.md");
	});

	it("keeps the streaming-messages-json stats contract on print", async () => {
		const client = new Client(ws.env, ws.dir);
		await client.handshake();
		const res = await client.tool("grok", { prompt: "go", cwd: ws.dir, transport: "print" });
		client.close();

		expect(res.isError).toBe(false);
		expect(res.text).toContain("FINAL ANSWER");
		expect(res.text).not.toContain("NARRATION");
		const stats = res.text.split("---\n")[1];
		expect(stats).toMatch(/^grok: fake-model-1 · 2 turns · 1 tool call: search_replace · 1\.5k in \/ 400 out/m);
		expect(stats).toMatch(/4\.2s grok-side/);
		expect(stats).toContain("grok wrote: note.md");
	});

	it("forwards progress notes for tool calls", async () => {
		const client = new Client(ws.env, ws.dir);
		await client.handshake();
		await client.tool("grok", { prompt: "go", cwd: ws.dir }, { progressToken: "p1" });
		client.close();
		expect(client.progressNotes()).toContain("running search_replace");
	});

	it("keeps a completed session in grok_sessions", async () => {
		const client = new Client({ ...ws.env, FAKE_MODE: "slow", FAKE_DELAY_MS: "100" }, ws.dir);
		await client.handshake();
		const res = await client.tool("grok", { prompt: "go", cwd: ws.dir });
		const id = sessionIdOf(res.text);

		const sessions = await client.tool("grok_sessions");
		client.close();
		expect(sessions.text).toContain(id);
		expect(sessions.text).toContain(ws.dir);
	});
});

describe("error envelopes", () => {
	it("surfaces error_during_execution with the last thing grok said", async () => {
		const client = new Client({ ...ws.env, FAKE_MODE: "error_exec" }, ws.dir);
		await client.handshake();
		const res = await client.tool("grok", { prompt: "go", cwd: ws.dir, transport: "print" });
		client.close();

		expect(res.isError).toBe(true);
		expect(res.text).toContain("[warning: grok ended with error_during_execution instead of an answer]");
		expect(res.text).toContain("EXEC FAILED: tests broke");
		expect(res.text).toContain("last thing grok said:");
		expect(res.text).toContain("PARTIAL: 43 tests pass, now showing the failure");
	});

	it("states a fallback when error_max_turns carries no message", async () => {
		const client = new Client({ ...ws.env, FAKE_MODE: "max_turns" }, ws.dir);
		await client.handshake();
		const res = await client.tool("grok", { prompt: "go", cwd: ws.dir, transport: "print" });
		client.close();

		expect(res.isError).toBe(true);
		expect(res.text).toContain("[warning: grok ended with error_max_turns instead of an answer]");
		expect(res.text).toContain("grok reported error_max_turns without an error message");
		expect(res.text).toContain("half the refactor is done");
	});

	it("fails closed on an unknown result subtype without leaking content", async () => {
		const client = new Client({ ...ws.env, FAKE_MODE: "unknown_result" }, ws.dir);
		await client.handshake();
		const res = await client.tool("grok", { prompt: "go", cwd: ws.dir, transport: "print" });
		client.close();

		expect(res.isError).toBe(true);
		expect(res.text).toContain("unrecognized result subtype=exploded");
		expect(res.text).toContain("grok messages seen:");
		expect(res.text).not.toContain("SECRET");
	});
});

describe("broken streams", () => {
	it("labels last assistant text when grok exits 0 with no result", async () => {
		const client = new Client({ ...ws.env, FAKE_MODE: "no_result" }, ws.dir);
		await client.handshake();
		const res = await client.tool("grok", { prompt: "go", cwd: ws.dir, transport: "print" });
		client.close();

		expect(res.isError).toBe(true);
		expect(res.text).toContain("produced no result envelope");
		expect(res.text).toContain("UNREPORTED WORK DONE");
	});

	it("still reads a result envelope that ends at EOF without a newline", async () => {
		const client = new Client({ ...ws.env, FAKE_MODE: "no_newline" }, ws.dir);
		await client.handshake();
		const res = await client.tool("grok", { prompt: "go", cwd: ws.dir, transport: "print" });
		client.close();
		expect(res.isError).toBe(false);
		expect(res.text).toContain("EOF TERMINATED ANSWER");
	});

	it("does not return raw stdout as an answer", async () => {
		const client = new Client({ ...ws.env, FAKE_MODE: "garbage" }, ws.dir);
		await client.handshake();
		const res = await client.tool("grok", { prompt: "go", cwd: ws.dir, transport: "print" });
		client.close();
		expect(res.isError).toBe(true);
		expect(res.text).toContain("did not match the expected");
		expect(res.text).not.toContain("this is not json");
	});
});

describe("output cap", () => {
	it("passes a huge answer through uncapped by default", async () => {
		const client = new Client({ ...ws.env, FAKE_MODE: "big", FAKE_SIZE: "50000" }, ws.dir);
		await client.handshake();
		const res = await client.tool("grok", { prompt: "go", cwd: ws.dir, transport: "print" });
		client.close();
		expect(res.isError).toBe(false);
		expect(res.text).toContain("X".repeat(50_000));
		expect(res.text).not.toContain("truncated");
	});

	it("honors GROK_MCP_MAX_OUTPUT when set", async () => {
		const client = new Client(
			{ ...ws.env, FAKE_MODE: "big", FAKE_SIZE: "50000", GROK_MCP_MAX_OUTPUT: "1000" },
			ws.dir,
		);
		await client.handshake();
		const res = await client.tool("grok", { prompt: "go", cwd: ws.dir, transport: "print" });
		client.close();
		expect(res.text).toContain("truncated at 1000");
		expect(res.text).not.toContain("X".repeat(2000));
	});
});
