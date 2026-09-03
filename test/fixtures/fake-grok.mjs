#!/usr/bin/env node

// A stand-in for the grok binary. Speaks:
//   - `--output-format streaming-messages-json` (print / headless)
//   - `grok agent … stdio` ACP JSON-RPC
//   - `grok models` text catalog
//
// Controlled by env (same vocabulary as qwen-cli-mcp's fake, so the suite ports):
//   FAKE_MODE=answer         (default) system init -> narration + tool_use -> final + result
//   FAKE_MODE=error_exec     ... -> result error_during_execution
//   FAKE_MODE=max_turns      ... -> result error_max_turns
//   FAKE_MODE=unknown_result ... -> result subtype "exploded"
//   FAKE_MODE=no_result      assistant text, then exit 0 with no result envelope
//   FAKE_MODE=no_newline     result envelope is EOF-terminated, not \n-terminated
//   FAKE_MODE=garbage        stdout is not JSON at all
//   FAKE_MODE=noisy_stderr   protocol messages dumped on stderr + one diagnostic
//   FAKE_MODE=denied         result success carrying one permission denial
//   FAKE_MODE=big            one huge result text, size from FAKE_SIZE
//   FAKE_MODE=slow           settles after FAKE_DELAY_MS
//   FAKE_MODE=hang           never settles; spawns a marked child (tree tests)
//   FAKE_MODE=wait           acp only: holds the turn open until steered / aborted
//   FAKE_MODE=overlap        lockfile detector for concurrent runs on one session
//   FAKE_MODE=models_fail    `grok models` exits non-zero
//   FAKE_ERROR_TEXT          error.message for error_exec
//   FAKE_TURNS               num_turns on the result envelope (default 2)
//   FAKE_SIZE                size of the big answer (default 200000)
//   FAKE_DELAY_MS            delay for slow/overlap (default 300)
//   FAKE_EXIT=<code>         exit code (default 0)
//   FAKE_STARTED_FILE        appended with one pid per invocation
//   FAKE_ARGV_LOG            appended with one JSON argv array per invocation
//   FAKE_STDIN_LOG           acp mode: every stdin line appended verbatim
//   FAKE_INIT_FAIL=1         initialize handshake -> JSON-RPC error
//   FAKE_LOCK_FILE           overlap lockfile
//   FAKE_CHILD_TAG           command-line tag of the spawned grandchild
//   FAKE_SESSION_ID          session id returned by session/new (else a uuid)

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, unlinkSync, writeFileSync } from "node:fs";

const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
const mode = process.env.FAKE_MODE ?? "answer";
const exitCode = Number(process.env.FAKE_EXIT ?? 0);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const USAGE_RESULT = { input_tokens: 1500, output_tokens: 400 };
const argv = process.argv.slice(2);

if (process.env.FAKE_STARTED_FILE) {
	appendFileSync(process.env.FAKE_STARTED_FILE, `${process.pid}\n`);
}
if (process.env.FAKE_ARGV_LOG) {
	appendFileSync(process.env.FAKE_ARGV_LOG, `${JSON.stringify(argv)}\n`);
}

function argValue(flag) {
	const index = argv.indexOf(flag);
	return index === -1 ? undefined : argv[index + 1];
}

const sessionId = () => process.env.FAKE_SESSION_ID ?? argValue("--session-id") ?? argValue("--resume") ?? randomUUID();

function spawnMarkedChild() {
	const tag = process.env.FAKE_CHILD_TAG ?? "grok-cli-mcp-child";
	// Stay in this process group so a tree-kill reaps it, but unref so the fake
	// can still exit after writing its result.
	const child = spawn("sh", ["-c", `sleep 120; true # ${tag}`], { stdio: "ignore" });
	child.unref();
}

// --- message builders (streaming-messages-json) ---------------------------

const systemInit = () =>
	out({
		type: "system",
		subtype: "init",
		uuid: randomUUID(),
		session_id: sessionId(),
		cwd: process.cwd(),
		model: "fake-model-1",
		tools: ["read_file", "search_replace", "run_terminal_cmd", "list_dir", "grep"],
		permissionMode: "bypassPermissions",
	});

const assistantMessage = (blocks, usage) =>
	out({
		type: "assistant",
		uuid: randomUUID(),
		session_id: sessionId(),
		parent_tool_use_id: null,
		message: {
			id: `msg_${randomUUID().slice(0, 8)}`,
			type: "message",
			role: "assistant",
			model: "fake-model-1",
			content: blocks,
			usage,
		},
	});

const userEcho = () =>
	out({
		type: "user",
		session_id: sessionId(),
		message: {
			role: "user",
			content: [{ type: "tool_result", tool_use_id: "c1", content: "tool ran" }],
		},
		parent_tool_use_id: null,
	});

const resultOk = (text) =>
	out({
		type: "result",
		subtype: "success",
		uuid: randomUUID(),
		session_id: sessionId(),
		is_error: false,
		duration_ms: 4200,
		duration_api_ms: 3900,
		num_turns: Number(process.env.FAKE_TURNS ?? 2),
		result: text,
		usage: USAGE_RESULT,
		permission_denials: [],
	});

const resultError = (subtype, message) =>
	out({
		type: "result",
		subtype,
		uuid: randomUUID(),
		session_id: sessionId(),
		is_error: true,
		duration_ms: 4200,
		duration_api_ms: 0,
		num_turns: Number(process.env.FAKE_TURNS ?? 2),
		usage: USAGE_RESULT,
		permission_denials: [],
		...(message === undefined ? {} : { error: { message } }),
	});

function envelopeSkeleton() {
	return {
		type: "result",
		subtype: "success",
		uuid: randomUUID(),
		session_id: sessionId(),
		is_error: false,
		duration_ms: 4200,
		duration_api_ms: 3900,
		num_turns: Number(process.env.FAKE_TURNS ?? 2),
		usage: USAGE_RESULT,
		permission_denials: [],
	};
}

function happyStream(answerText = "FINAL ANSWER") {
	systemInit();
	assistantMessage(
		[
			{ type: "text", text: "NARRATION: I'll check that for you." },
			{ type: "tool_use", id: "c1", name: "search_replace", input: { path: "note.md", content: "hi" } },
		],
		{ input_tokens: 10, output_tokens: 2 },
	);
	userEcho();
	assistantMessage([{ type: "text", text: answerText }], { input_tokens: 20, output_tokens: 5 });
	resultOk(answerText);
}

async function playScenario() {
	switch (mode) {
		case "error_exec":
			systemInit();
			assistantMessage([{ type: "text", text: "PARTIAL: 43 tests pass, now showing the failure" }], {
				input_tokens: 10,
				output_tokens: 2,
			});
			resultError("error_during_execution", process.env.FAKE_ERROR_TEXT ?? "EXEC FAILED: tests broke");
			return "done";
		case "max_turns":
			systemInit();
			assistantMessage([{ type: "text", text: "PARTIAL: half the refactor is done" }], {
				input_tokens: 10,
				output_tokens: 2,
			});
			resultError("error_max_turns");
			return "done";
		case "unknown_result":
			systemInit();
			resultError("exploded");
			return "done";
		case "denied": {
			systemInit();
			assistantMessage([{ type: "text", text: "I cannot write there under this approval mode." }], {
				input_tokens: 5,
				output_tokens: 1,
			});
			out({
				...envelopeSkeleton(),
				result: "CANNOT WRITE",
				permission_denials: [{ tool_name: "search_replace", tool_use_id: "c1", tool_input: {} }],
			});
			return "done";
		}
		case "no_result":
			systemInit();
			assistantMessage([{ type: "text", text: "UNREPORTED WORK DONE" }], { input_tokens: 10, output_tokens: 2 });
			return "done";
		case "no_newline":
			systemInit();
			process.stdout.write(JSON.stringify({ ...envelopeSkeleton(), result: "EOF TERMINATED ANSWER" }));
			return "done";
		case "garbage":
			process.stdout.write("this is not json\nneither is this\n");
			return "done";
		case "noisy_stderr":
			process.stderr.write(
				`${JSON.stringify({ type: "message_start", message: { role: "user", content: "SECRET_PROMPT_BODY" } })}\n`,
			);
			process.stderr.write(
				`${JSON.stringify({ type: "message_start", message: { role: "assistant", content: "SECRET echoed" } })}\n`,
			);
			process.stderr.write(`${JSON.stringify({ type: "message_end" })}\n`);
			process.stderr.write("Error: upstream refused the request\n");
			happyStream();
			return "done";
		case "big": {
			systemInit();
			const text = "X".repeat(Number(process.env.FAKE_SIZE ?? 200_000));
			assistantMessage([{ type: "text", text: "here it comes" }], { input_tokens: 10, output_tokens: 2 });
			resultOk(text);
			return "done";
		}
		case "slow":
			systemInit();
			await sleep(Number(process.env.FAKE_DELAY_MS ?? 1500));
			happyStream("SLOW ANSWER");
			return "done";
		case "hang":
			systemInit();
			spawnMarkedChild();
			return "held";
		case "child_then_answer":
			spawnMarkedChild();
			happyStream("ANSWERED WITH CHILD LEFT");
			return "done";
		case "overlap": {
			const lock = process.env.FAKE_LOCK_FILE;
			const held = Boolean(lock && existsSync(lock));
			if (lock && !held) writeFileSync(lock, String(process.pid));
			systemInit();
			await sleep(Number(process.env.FAKE_DELAY_MS ?? 300));
			resultOk(held ? "OVERLAP DETECTED" : "EXCLUSIVE");
			if (lock && !held) unlinkSync(lock);
			return "done";
		}
		default:
			happyStream();
			return "done";
	}
}

// --- models subcommand ----------------------------------------------------

if (argv[0] === "models") {
	if (mode === "models_fail") {
		process.stderr.write("model catalog unavailable\n");
		process.exit(1);
	}
	process.stdout.write("You are logged in with grok.com.\n\n");
	process.stdout.write("Default model: fake-model-1\n\n");
	process.stdout.write("Available models:\n");
	process.stdout.write("  * fake-model-1 (default)\n");
	process.stdout.write("  - fake-coder-max\n");
	process.stdout.write("  - grok-4.6\n");
	process.exit(0);
}

// --- ACP agent stdio ------------------------------------------------------

if (argv.includes("agent")) {
	await runAcp();
} else {
	const outcome = await playScenario();
	if (outcome === "held") {
		setInterval(() => {}, 1000);
	} else {
		process.exitCode = exitCode;
	}
}

async function runAcp() {
	const stdinLog = process.env.FAKE_STDIN_LOG;
	let sid = process.env.FAKE_SESSION_ID ?? randomUUID();
	let holding = false;
	let holdInterval;
	let abortTimer;
	let promptId = null;
	let promptCount = 0;
	const chunks = [];

	const rpc = (id, result) => out({ jsonrpc: "2.0", id, result });
	const rpcError = (id, message) => out({ jsonrpc: "2.0", id, error: { code: -32000, message } });
	const notify = (method, params) => out({ jsonrpc: "2.0", method, params });

	const emitChunk = (text) => {
		chunks.push(text);
		notify("session/update", {
			sessionId: sid,
			update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
		});
	};

	const emitTool = () => {
		notify("session/update", {
			sessionId: sid,
			update: {
				sessionUpdate: "tool_call",
				toolCallId: "c1",
				title: "Edit",
				kind: "edit",
				status: "completed",
				toolName: "search_replace",
				rawInput: { path: "note.md", content: "hi" },
			},
		});
	};

	const settlePrompt = (id, text, stopReason = "end_turn") => {
		if (abortTimer) clearTimeout(abortTimer);
		holding = false;
		if (holdInterval) {
			clearInterval(holdInterval);
			holdInterval = undefined;
		}
		if (text) emitChunk(text);
		rpc(id, { stopReason });
		promptId = null;
		setTimeout(() => process.exit(exitCode), 3000).unref();
	};

	const playAcpScenario = async (id) => {
		switch (mode) {
			case "error_exec":
				emitChunk("PARTIAL: 43 tests pass, now showing the failure");
				rpc(id, { stopReason: "refusal" });
				setTimeout(() => process.exit(exitCode), 50).unref();
				return;
			case "max_turns":
				emitChunk("PARTIAL: half the refactor is done");
				rpc(id, { stopReason: "max_turn_requests" });
				setTimeout(() => process.exit(exitCode), 50).unref();
				return;
			case "hang":
				spawnMarkedChild();
				holding = true;
				holdInterval = setInterval(() => {}, 1000);
				return;
			case "slow":
				await sleep(Number(process.env.FAKE_DELAY_MS ?? 1500));
				emitChunk("NARRATION: I'll check that for you.");
				emitTool();
				settlePrompt(id, "SLOW ANSWER");
				return;
			case "wait":
				holding = true;
				holdInterval = setInterval(() => {}, 1000);
				promptId = id;
				return;
			case "overlap": {
				const lock = process.env.FAKE_LOCK_FILE;
				const held = Boolean(lock && existsSync(lock));
				if (lock && !held) writeFileSync(lock, String(process.pid));
				await sleep(Number(process.env.FAKE_DELAY_MS ?? 300));
				settlePrompt(id, held ? "OVERLAP DETECTED" : "EXCLUSIVE");
				if (lock && !held) unlinkSync(lock);
				return;
			}
			case "no_result":
				emitChunk("UNREPORTED WORK DONE");
				// Drop the prompt response — contract-broken ACP.
				setTimeout(() => process.exit(exitCode), 50).unref();
				return;
			case "child_then_answer":
				spawnMarkedChild();
				emitTool();
				settlePrompt(id, "ANSWERED WITH CHILD LEFT");
				return;
			default:
				emitTool();
				settlePrompt(id, "FINAL ANSWER");
		}
	};

	let buffer = "";
	process.stdin.setEncoding("utf8");
	process.stdin.on("data", (chunk) => {
		buffer += chunk;
		let newline = buffer.indexOf("\n");
		while (newline !== -1) {
			const line = buffer.slice(0, newline).trim();
			buffer = buffer.slice(newline + 1);
			newline = buffer.indexOf("\n");
			if (!line) continue;
			void ingest(line);
		}
	});
	process.stdin.on("end", () => {
		if (holding) return;
		process.exitCode = exitCode;
	});

	async function ingest(line) {
		if (stdinLog) appendFileSync(stdinLog, `${line}\n`);
		let msg;
		try {
			msg = JSON.parse(line);
		} catch {
			return;
		}

		if (msg.method === "initialize") {
			if (process.env.FAKE_INIT_FAIL === "1") rpcError(msg.id, "init refused by fake");
			else rpc(msg.id, { protocolVersion: "1", agentCapabilities: { loadSession: true } });
			return;
		}
		if (msg.method === "session/new") {
			sid = process.env.FAKE_SESSION_ID ?? randomUUID();
			rpc(msg.id, { sessionId: sid, configOptions: [] });
			return;
		}
		if (msg.method === "session/load") {
			sid = msg.params?.sessionId ?? sid;
			rpc(msg.id, { sessionId: sid, configOptions: [] });
			return;
		}
		if (msg.method === "session/set_config_option") {
			rpc(msg.id, { configOptions: [] });
			return;
		}
		if (msg.method === "session/cancel") {
			if (mode === "wait" && promptId !== null) {
				clearTimeout(abortTimer);
				abortTimer = setTimeout(() => settlePrompt(promptId, "ABORTED AFTER INTERRUPT", "cancelled"), 150);
			}
			return;
		}
		if (msg.method === "session/prompt") {
			promptCount += 1;
			const text = Array.isArray(msg.params?.prompt) ? msg.params.prompt.map((b) => b.text ?? "").join("") : "";
			if (mode === "wait") {
				if (promptCount > 1) {
					clearTimeout(abortTimer);
					settlePrompt(msg.id, `QUEUED TURN ANSWER: ${text}`);
					return;
				}
				await playAcpScenario(msg.id);
				return;
			}
			await playAcpScenario(msg.id);
		}
	}
}
