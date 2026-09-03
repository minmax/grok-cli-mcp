// Transports: what reaches grok's argv and stdin, when, and in what order.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, makeWorkspace, readStdinLog, sessionIdOf, type Workspace, waitFor } from "./helpers/client.ts";

async function sessionIdOfRunning(client: Client): Promise<string> {
	const running = await client.tool("grok_running");
	const match = running.text.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/);
	if (!match?.[1]) throw new Error(`no running session in: ${running.text.slice(0, 200)}`);
	return match[1];
}

let ws: Workspace;

beforeAll(() => {
	ws = makeWorkspace();
});
afterAll(() => ws.cleanup());

describe("print transport", () => {
	it("starts new runs with --session-id and replies with --resume", async () => {
		const argvLog = join(ws.dir, `argv-${Date.now()}-${Math.random().toString(36).slice(2)}.log`);
		const client = new Client({ ...ws.env, FAKE_ARGV_LOG: argvLog }, ws.dir);
		await client.handshake();
		const first = await client.tool("grok", { prompt: "go", cwd: ws.dir, transport: "print" });
		const id = sessionIdOf(first.text);
		await client.tool("grok_reply", { session: id, prompt: "again", cwd: ws.dir, transport: "print" });
		client.close();

		const argvs = readFileSync(argvLog, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as string[]);
		expect(argvs.length).toBe(2);
		const firstRun = argvs[0] ?? [];
		const replyArgv = argvs[1] ?? [];
		expect(firstRun).toContain("--session-id");
		expect(firstRun).toContain("--output-format");
		expect(firstRun).toContain("streaming-messages-json");
		expect(firstRun).toContain("--always-approve");
		expect(firstRun).toContain("--prompt-file");
		expect(replyArgv.includes("--resume")).toBe(true);
		expect(replyArgv.at(replyArgv.indexOf("--resume") + 1)).toBe(id);
	});

	it("passes effort and model on argv", async () => {
		const argvLog = join(ws.dir, `argv-${Date.now()}-${Math.random().toString(36).slice(2)}.log`);
		const client = new Client({ ...ws.env, FAKE_ARGV_LOG: argvLog }, ws.dir);
		await client.handshake();
		const res = await client.tool("grok", {
			prompt: "go",
			cwd: ws.dir,
			effort: "high",
			model: "grok-4.6",
			transport: "print",
		});
		client.close();
		expect(res.isError).toBe(false);
		const firstRun = JSON.parse(readFileSync(argvLog, "utf8").trim().split("\n")[0] ?? "[]") as string[];
		expect(firstRun).toContain("--effort");
		expect(firstRun.at(firstRun.indexOf("--effort") + 1)).toBe("high");
		expect(firstRun).toContain("--model");
		expect(firstRun.at(firstRun.indexOf("--model") + 1)).toBe("grok-4.6");
	});

	it("delivers long prompts via --prompt-file", async () => {
		const bigPrompt = "x".repeat(150_000);
		const client = new Client(ws.env, ws.dir);
		await client.handshake();
		const res = await client.tool("grok", { prompt: bigPrompt, cwd: ws.dir, transport: "print" });
		client.close();
		expect(res.isError).toBe(false);
		expect(res.text).toContain("FINAL ANSWER");
	});
});

describe("acp transport protocol", () => {
	it("initializes before creating a session and sending the first prompt", async () => {
		const logFile = join(ws.dir, `stdin-${Date.now()}-${Math.random().toString(36).slice(2)}.log`);
		const client = new Client({ ...ws.env, FAKE_STDIN_LOG: logFile }, ws.dir);
		await client.handshake();
		const res = await client.tool("grok", { prompt: "go", cwd: ws.dir });
		client.close();

		expect(res.isError).toBe(false);
		expect(res.text).toContain("FINAL ANSWER");
		const lines = readStdinLog(logFile);
		const initIndex = lines.findIndex((m) => m.method === "initialize");
		const newIndex = lines.findIndex((m) => m.method === "session/new");
		const promptIndex = lines.findIndex((m) => m.method === "session/prompt");
		expect(initIndex).toBeGreaterThanOrEqual(0);
		expect(newIndex).toBeGreaterThan(initIndex);
		expect(promptIndex).toBeGreaterThan(newIndex);
		expect(lines[promptIndex]?.params?.prompt?.[0]?.text).toBe("go");
	});

	it("loads an existing session on grok_reply", async () => {
		const logFile = join(ws.dir, `stdin-reply-${Date.now()}.log`);
		const client = new Client({ ...ws.env, FAKE_STDIN_LOG: logFile }, ws.dir);
		await client.handshake();
		const first = await client.tool("grok", { prompt: "go", cwd: ws.dir });
		const id = sessionIdOf(first.text);
		await client.tool("grok_reply", { session: id, prompt: "again", cwd: ws.dir });
		client.close();

		const lines = readStdinLog(logFile);
		const load = lines.find((m) => m.method === "session/load");
		expect(load?.params?.sessionId).toBe(id);
	});
});

describe("mid-run delivery", () => {
	interface Harness {
		client: Client;
		logFile: string;
		pending: ReturnType<Client["request"]>;
	}

	async function startWaitingRun(): Promise<Harness> {
		const logFile = join(ws.dir, `stdin-${Date.now()}-${Math.random().toString(36).slice(2)}.log`);
		const client = new Client({ ...ws.env, FAKE_MODE: "wait", FAKE_STDIN_LOG: logFile }, ws.dir);
		await client.handshake();
		const pending = client.request("tools/call", {
			name: "grok",
			arguments: { prompt: "start working", cwd: ws.dir },
		});
		await waitFor("the first prompt to reach grok", () => {
			try {
				return readStdinLog(logFile).some((m) => m.method === "session/prompt");
			} catch {
				return false;
			}
		});
		return { client, logFile, pending };
	}

	it("aborts a running turn via session/cancel", async () => {
		const { client, logFile, pending } = await startWaitingRun();
		const id = await sessionIdOfRunning(client);
		const sent = await client.tool("grok_send", { session: id, command: "abort" });
		expect(sent.isError).toBe(false);
		expect(sent.text).toContain("Sent abort");

		const res = await pending.promise;
		client.close();
		expect(res.result?.isError).toBeFalsy();
		expect(res.result?.content?.[0]?.text).toContain("ABORTED AFTER INTERRUPT");
		expect(readStdinLog(logFile).some((m) => m.method === "session/cancel")).toBe(true);
	});

	it("steers a running turn", async () => {
		const { client, pending } = await startWaitingRun();
		const id = await sessionIdOfRunning(client);
		const sent = await client.tool("grok_send", { session: id, command: "steer", message: "stop and report" });
		expect(sent.isError).toBe(false);

		const res = await pending.promise;
		client.close();
		expect(res.result.content[0].text).toContain("QUEUED TURN ANSWER: stop and report");
	});

	it("refuses grok_send on a print-mode run", async () => {
		const client = new Client({ ...ws.env, FAKE_MODE: "slow", FAKE_DELAY_MS: "2000" }, ws.dir);
		await client.handshake();
		const pending = client.request("tools/call", {
			name: "grok",
			arguments: { prompt: "go", cwd: ws.dir, transport: "print" },
		});
		const sent = await client.tool("grok_send", { session: "anything", command: "abort" });
		expect(sent.isError).toBe(true);
		expect(sent.text).toContain("not currently running");
		client.close();
		await pending.promise.catch(() => {});
	});
});
