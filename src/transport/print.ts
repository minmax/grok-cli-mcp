// `grok -p … --output-format streaming-messages-json`: one process per turn,
// grok exits when the turn is done.
//
// Prompts go through `--prompt-file` so argv size and dash-leading text are
// never a problem. Grok has this flag; qwen did not.

import { randomUUID } from "node:crypto";
import { unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunResult } from "../grok-process.ts";
import { runGrok } from "../grok-process.ts";
import type { CallContext } from "../types.ts";
import { overrideArgs } from "./args.ts";
import type { RunPlan, Transport } from "./types.ts";

export const printTransport: Transport = {
	name: "print",
	acceptsMidRunMessages: false,

	async run(plan: RunPlan, ctx: CallContext, onEvent: (event: unknown) => void): Promise<RunResult> {
		const promptFile = join(tmpdir(), `grok-mcp-prompt-${randomUUID()}.txt`);
		writeFileSync(promptFile, plan.prompt);
		try {
			const args = [
				"--prompt-file",
				promptFile,
				"--output-format",
				"streaming-messages-json",
				...overrideArgs(plan),
			];
			return await runGrok(args, plan.cwd, {
				token: ctx.token,
				timeoutMs: plan.timeoutMs,
				onEvent,
			});
		} finally {
			try {
				unlinkSync(promptFile);
			} catch {
				// Temp file cleanup is best-effort.
			}
		}
	},
};
