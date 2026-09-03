// A minimal MCP client that drives the real server over stdio, plus the fake
// grok binary the tests point it at.

import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const SERVER = join(here, "..", "..", "src", "index.ts");
export const FAKE_GROK = join(here, "..", "fixtures", "fake-grok.mjs");

/**
 * Node 22 needs a flag to run TypeScript; from 23 onwards type stripping is on
 * by default and the flag is deprecated. The flag is added only where required.
 */
const NODE_TS_FLAGS = Number(process.versions.node.split(".")[0] ?? 0) >= 23 ? [] : ["--experimental-strip-types"];

export interface JsonRpcResponse {
	id?: unknown;
	result?: any;
	error?: { code: number; message: string };
	method?: string;
	params?: any;
}

export interface PendingCall {
	id: number;
	promise: Promise<JsonRpcResponse>;
}

export class Client {
	readonly child: ChildProcessWithoutNullStreams;
	readonly notifications: JsonRpcResponse[] = [];
	private readonly pending = new Map<number, (msg: JsonRpcResponse) => void>();
	private buffer = "";
	private nextId = 1;

	constructor(env: Record<string, string> = {}, cwd: string = process.cwd()) {
		this.child = spawn(process.execPath, [...NODE_TS_FLAGS, SERVER], {
			cwd,
			env: { ...process.env, ...env },
			stdio: ["pipe", "pipe", "pipe"],
		}) as ChildProcessWithoutNullStreams;
		this.child.stdout.setEncoding("utf8");
		this.child.stdout.on("data", (chunk: string) => this.ingest(chunk));
	}

	private ingest(chunk: string): void {
		this.buffer += chunk;
		let newline = this.buffer.indexOf("\n");
		while (newline !== -1) {
			const line = this.buffer.slice(0, newline).trim();
			this.buffer = this.buffer.slice(newline + 1);
			newline = this.buffer.indexOf("\n");
			if (!line) continue;
			const msg = JSON.parse(line) as JsonRpcResponse;
			const resolver = typeof msg.id === "number" ? this.pending.get(msg.id) : undefined;
			if (resolver) {
				this.pending.delete(msg.id as number);
				resolver(msg);
			} else {
				this.notifications.push(msg);
			}
		}
	}

	send(msg: unknown): void {
		this.child.stdin.write(`${JSON.stringify(msg)}\n`);
	}

	raw(line: string): void {
		this.child.stdin.write(line);
	}

	request(method: string, params?: unknown): PendingCall {
		const id = this.nextId++;
		const promise = new Promise<JsonRpcResponse>((resolve) => this.pending.set(id, resolve));
		this.send({ jsonrpc: "2.0", id, method, params });
		return { id, promise };
	}

	async call(method: string, params?: unknown): Promise<JsonRpcResponse> {
		return this.request(method, params).promise;
	}

	async handshake(): Promise<JsonRpcResponse> {
		const init = await this.call("initialize", {
			protocolVersion: "2025-06-18",
			capabilities: {},
			clientInfo: { name: "test", version: "1" },
		});
		this.send({ jsonrpc: "2.0", method: "notifications/initialized" });
		return init;
	}

	async tool(name: string, args: unknown = {}, meta?: unknown): Promise<{ text: string; isError: boolean }> {
		const params: Record<string, unknown> = { name, arguments: args };
		if (meta !== undefined) params._meta = meta;
		const res = await this.call("tools/call", params);
		return { text: res.result?.content?.[0]?.text ?? "", isError: res.result?.isError === true };
	}

	progressNotes(): string[] {
		return this.notifications
			.filter((n) => n.method === "notifications/progress")
			.map((n) => String(n.params?.message ?? ""));
	}

	close(): void {
		this.child.stdin.end();
		this.child.kill();
	}
}

/** A shell shim, because the server spawns its grok binary as a plain command. */
export function makeFakeBin(dir: string): string {
	const bin = join(dir, "grok");
	writeFileSync(bin, `#!/bin/sh\nexec ${process.execPath} ${FAKE_GROK} "$@"\n`);
	chmodSync(bin, 0o755);
	return bin;
}

export interface Workspace {
	dir: string;
	bin: string;
	env: Record<string, string>;
	stateFile: string;
	cleanup: () => void;
}

export function makeWorkspace(env: Record<string, string> = {}): Workspace {
	const dir = mkdtempSync(join(tmpdir(), "grok-cli-mcp-test-"));
	const bin = makeFakeBin(dir);
	const stateFile = join(dir, "sessions.json");
	return {
		dir,
		bin,
		stateFile,
		env: { GROK_MCP_BIN: bin, GROK_MCP_STATE: stateFile, ...env },
		cleanup: () => rmSync(dir, { recursive: true, force: true }),
	};
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function waitFor(
	label: string,
	predicate: () => boolean,
	{ timeoutMs = 10_000, everyMs = 50 }: { timeoutMs?: number; everyMs?: number } = {},
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await sleep(everyMs);
	}
	throw new Error(`timed out after ${timeoutMs}ms waiting for: ${label}`);
}

export function sessionIdOf(text: string): string {
	const match = text.match(/\[session: ([0-9a-f-]{36})\]/);
	if (!match?.[1]) throw new Error(`no session id in: ${text.slice(0, 120)}`);
	return match[1];
}

/** Parsed stdin lines of the fake, for protocol-order assertions. */
export function readStdinLog(path: string): Array<Record<string, any>> {
	return readFileSync(path, "utf8")
		.split("\n")
		.filter((line) => line.trim())
		.map((line) => JSON.parse(line) as Record<string, any>);
}
