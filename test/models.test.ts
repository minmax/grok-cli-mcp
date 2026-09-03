// grok_models: a live probe of `grok models`. Formatting on success, honesty
// on every failure path.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, makeWorkspace, type Workspace } from "./helpers/client.ts";

let ws: Workspace;

beforeAll(() => {
	ws = makeWorkspace();
});
afterAll(() => ws.cleanup());

describe("models probe", () => {
	it("formats the catalog grok actually reported", async () => {
		const client = new Client(ws.env, ws.dir);
		await client.handshake();
		const res = await client.tool("grok_models");
		client.close();

		expect(res.isError).toBe(false);
		expect(res.text).toContain("3 model(s):");
		expect(res.text).toContain("- fake-model-1 · default");
		expect(res.text).toContain("- fake-coder-max");
		expect(res.text).toContain("- grok-4.6");
	});

	it("filters by search", async () => {
		const client = new Client(ws.env, ws.dir);
		await client.handshake();
		const res = await client.tool("grok_models", { search: "coder" });
		const none = await client.tool("grok_models", { search: "zzz" });
		client.close();

		expect(res.isError).toBe(false);
		expect(res.text).toContain("fake-coder-max");
		expect(res.text).not.toContain("grok-4.6");

		expect(none.isError).toBe(true);
		expect(none.text).toContain('No grok models match "zzz"');
	});

	it("reports a catalog refusal honestly", async () => {
		const client = new Client({ ...ws.env, FAKE_MODE: "models_fail" }, ws.dir);
		await client.handshake();
		const res = await client.tool("grok_models");
		client.close();

		expect(res.isError).toBe(true);
		expect(res.text).toContain("could not read the model catalog");
		expect(res.text).toContain("model catalog unavailable");
	});

	it("fails fast when the grok binary cannot start, instead of hanging", async () => {
		const client = new Client({ ...ws.env, GROK_MCP_BIN: "/nonexistent/grok-binary" }, ws.dir);
		await client.handshake();
		const started = Date.now();
		const res = await client.tool("grok_models");
		client.close();
		expect(Date.now() - started).toBeLessThan(5_000);
		expect(res.isError).toBe(true);
	});
});
