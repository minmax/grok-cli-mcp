// Runs against the real grok binary. Opt-in, because it spends tokens and needs
// a working login: GROK_CLI_MCP_LIVE=1 npm test

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, sessionIdOf } from "./helpers/client.ts";

const live = process.env.GROK_CLI_MCP_LIVE === "1";
let dir: string;

beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), "grok-cli-mcp-live-"));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe.runIf(live)("real grok", () => {
	it("answers a prompt end to end", async () => {
		const client = new Client({ GROK_MCP_STATE: join(dir, "state.json") }, dir);
		await client.handshake();
		const res = await client.tool("grok", {
			prompt: "Reply with exactly: LIVE_OK",
			allowed_tools: "read_file,grep,list_dir",
		});
		client.close();
		expect(res.isError).toBe(false);
		expect(res.text).toContain("LIVE_OK");
		expect(res.text).toMatch(/\ngrok: .+ · \d+ turns? ·/);
	});

	it("keeps context across a reply", async () => {
		const client = new Client({ GROK_MCP_STATE: join(dir, "state.json") }, dir);
		await client.handshake();
		const first = await client.tool("grok", {
			prompt: "Remember the codeword ZULU-9. Reply with exactly: ZULU-9",
			allowed_tools: "read_file,grep,list_dir",
		});
		const id = sessionIdOf(first.text);
		const reply = await client.tool("grok_reply", {
			session: id,
			prompt: "What codeword did I give you? Reply with only it.",
			allowed_tools: "read_file,grep,list_dir",
		});
		client.close();
		expect(reply.isError).toBe(false);
		expect(reply.text).toContain("ZULU-9");
	});

	it("lists real models", async () => {
		const client = new Client({ GROK_MCP_STATE: join(dir, "state.json") }, dir);
		await client.handshake();
		const res = await client.tool("grok_models");
		client.close();
		if (res.isError) {
			expect(res.text).toContain("could not");
		} else {
			expect(res.text.trim().length).toBeGreaterThan(0);
		}
	});
});
