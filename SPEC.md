# grok-cli-mcp — Specification

MCP server that delegates coding tasks to a **locally installed** [Grok Build](https://x.ai/cli) CLI.
Sibling of `pi-cli-mcp` and `qwen-cli-mcp` (`~/ai/`): same architecture, same principles,
different agent behind the wheel.

Status: v1. Implementation: one package, zero runtime dependencies.

---

## 1. Identity

| | |
|---|---|
| package | `grok-code-mcp` |
| bin | `grok-cli-mcp` |
| MCP server name | `grok` |
| Tool prefix | `grok_` |
| License | MIT |
| Node | ≥ 22 |

## 2. Source material

**Architecture (port):** `~/ai/qwen-cli-mcp` and `~/ai/pi-cli-mcp`.

**Grok wire contract:**
- Headless: `grok -p` / `--prompt-file` with `--output-format streaming-messages-json`
  (`crates/codegen/xai-grok-pager/docs/user-guide/14-headless-mode.md`)
- Sessions: `--session-id` (new UUID), `--resume` (existing)
  (`…/17-sessions.md`)
- Agent/ACP: `grok agent --always-approve stdio`
  (`…/15-agent-mode.md`)
- Models: `grok models`
- Permissions: `--always-approve` / `--permission-mode`
  (`…/22-permissions-and-safety.md`)

## 3. House rules (inherited)

1. **This is an adapter.** It carries grok's capabilities across MCP and adds none of its own.
   No automatic messages into the agent. `grok_send` fires only when called.
2. **Zero runtime dependencies.** NDJSON JSON-RPC 2.0 is spoken directly.
3. **Fail closed on anything from grok.** Unknown `result.subtype`, missing fields, unparseable lines — report them.
4. **The answer is the contract.** Return grok's final result text plus aggregate stats. Never the transcript,
   tool arguments, or raw stdout.
5. **No process outlives its request.**
6. **Tests drive the real server.** The fake is grok, never our own code.

## 4. Transports

| Mode | Command | Mid-run |
|---|---|---|
| `acp` (default) | `grok agent --always-approve stdio` then ACP `initialize` / `session/new\|load` / `session/prompt` | `grok_send` via `session/cancel` |
| `print` | `grok --prompt-file <tmp> --output-format streaming-messages-json [--session-id\|--resume] …` | no |

ACP `session/update` notifications are converted into the same `assistant` / `result` shapes print mode emits.

## 5. Tools

`grok`, `grok_reply`, `grok_models`, `grok_send`, `grok_running`, `grok_sessions` — direct analogs of the qwen/pi tools.

## 6. Result subtypes

OK: `success`.
BAD: `error_max_turns`, `error_during_execution`, `error_max_structured_output_retries`.
Anything else: fail closed.
