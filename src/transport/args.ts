// Argument assembly shared by the transports.

import type { ApprovalMode } from "../types.ts";
import type { RunPlan } from "./types.ts";

/**
 * Map our approval_mode onto grok's CLI flags.
 *
 * `yolo` is the product name for always-approve. Everything else is
 * `--permission-mode <mode>` using grok's own identifiers.
 */
export function approvalArgs(mode: ApprovalMode | undefined): string[] {
	if (mode === undefined || mode === "yolo") return ["--always-approve"];
	if (mode === "bypassPermissions") return ["--permission-mode", "bypassPermissions"];
	return ["--permission-mode", mode];
}

/**
 * Flags carrying model / permission / prompt overrides for headless (`print`)
 * mode. Session identity is included: `--session-id` for a new run, `--resume`
 * for a follow-up.
 */
export function overrideArgs(plan: RunPlan): string[] {
	const { overrides } = plan;
	const args: string[] = [];
	if (overrides.model) args.push("--model", overrides.model);
	args.push(...approvalArgs(overrides.approval_mode));
	if (overrides.allowed_tools) args.push("--tools", overrides.allowed_tools);
	if (overrides.system_prompt_append) args.push("--rules", overrides.system_prompt_append);
	if (overrides.effort) args.push("--effort", overrides.effort);
	args.push("--cwd", plan.cwd);
	if (plan.resume) args.push("--resume", plan.sessionId);
	else args.push("--session-id", plan.sessionId);
	return args;
}

/**
 * Flags that apply to `grok agent … stdio`. Session identity and the prompt
 * travel on the JSON-RPC channel, not argv.
 */
export function agentArgs(plan: RunPlan): string[] {
	const { overrides } = plan;
	const args: string[] = ["agent"];
	args.push(...approvalArgs(overrides.approval_mode));
	if (overrides.model) args.push("--model", overrides.model);
	args.push("stdio");
	return args;
}
