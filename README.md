# grok-cli-mcp

MCP server that delegates coding tasks to your **locally installed**
[Grok Build](https://x.ai/cli) CLI (`grok`).

It wraps the real `grok` binary instead of bundling its own copy of the agent, so every call
inherits your grok auth, models, MCP servers and settings. Nothing about your model stack is
duplicated here, and the server does not drift when you upgrade grok.

Sibling of [pi-cli-mcp](../pi-cli-mcp) and [qwen-cli-mcp](../qwen-cli-mcp) — same architecture,
same principles, grok behind the wheel.

Use it when your primary agent (Claude Code, Cursor, any MCP client) should hand work
to grok: a second opinion from a different model family, an investigation you want kept out of the
main context window, or parallel work.

## Install

Requires Node ≥ 22 and a working `grok` on `PATH`.

### Claude Code

From this directory:

```bash
npm install
npm run build

claude mcp add-json grok -s user "{
  \"type\": \"stdio\",
  \"command\": \"node\",
  \"args\": [\"$(pwd)/dist/index.js\"],
  \"timeout\": 3600000
}"
claude mcp list | grep '^grok:'    # expect: ✔ Connected
```

Or, after a global install:

```bash
claude mcp add-json grok -s user '{
  "type": "stdio",
  "command": "npx",
  "args": ["-y", "grok-cli-mcp"],
  "timeout": 3600000
}'
```

The generous `timeout` matters: the server applies no run deadline by default, and a real
delegated task can run for minutes.

### Any other MCP client

```json
{
  "mcpServers": {
    "grok": { "command": "node", "args": ["/abs/path/to/grok-cli-mcp/dist/index.js"] }
  }
}
```

Keep the server name short (`grok`): it becomes part of the tool names your model sees.

> **⚠️ Default approval mode is `yolo` (always-approve).** Delegation is only useful when the
> delegate can act, so this server starts grok with `--always-approve` by default — inside `cwd`,
> as your user. Narrow it with `GROK_MCP_APPROVAL_MODE`, per-call `approval_mode`, or
> `allowed_tools`. For analysis-only work pass `allowed_tools: "read_file,grep,list_dir"`.

## Tools

| Tool | Purpose |
|---|---|
| `grok` | Start a session. Returns `[session: <uuid>]`, the result, and stats. |
| `grok_reply` | Continue a finished or interrupted session — including one killed by a timeout. |
| `grok_models` | List models grok can actually reach right now (`grok models`). |
| `grok_send` | Deliver into a turn executing right now (`abort` / `steer` / `follow_up`). |
| `grok_running` | List turns executing right now that `grok_send` can reach. |
| `grok_sessions` | List known sessions, newest first, with their working directory. |

### `grok`

| Argument | Notes |
|---|---|
| `prompt` | Required. Must be self-contained — grok cannot see your conversation. |
| `cwd` | Absolute path; defaults to this server's cwd. |
| `model` | `-m` value. Defaults to grok's own settings; `grok_models` lists valid values. |
| `approval_mode` | `yolo` \| `default` \| `acceptEdits` \| `plan` \| `auto` \| `dontAsk` \| `bypassPermissions`. Server default: yolo. |
| `allowed_tools` | Comma-separated grok tool ids passed as `--tools` (e.g. `read_file,grep,list_dir`). |
| `effort` | `none` … `max` reasoning effort (`--effort`). |
| `system_prompt_append` | Appended to grok's system prompt (`--rules`). |
| `transport` | `acp` (default) or `print`. Usually omit. |
| `timeout_ms` | Wall clock for this run. Off unless you set it. |

```js
grok({
  prompt: "Map how retries are wired in src/http.rs. Report call sites only.",
  cwd: "/abs/path/to/repo",
  allowed_tools: "read_file,grep,list_dir"
})

// later, same conversation:
grok_reply({
  session: "<id from the prefix>",
  prompt: "Now check the error paths of those call sites."
})
```

## What comes back

Only grok's final result plus aggregate stats — never the transcript, tool arguments or raw stdout:

```
[session: 0927adc5-a840-4b68-93ca-5ca344c9fafb]

Refactored retry() in src/http.rs; all 12 tests pass.

---
grok: grok-4.6 · 6 turns · 5 tool calls: run_terminal_cmd×2, read_file×2, search_replace · 18k in / 310 out · 41s
grok wrote: src/http.rs
```

The answer is grok's final turn text plus aggregate stats. On the default `acp` transport that text
is assembled from ACP `agent_message_chunk` updates; on `print` it is the `result` envelope from
`--output-format streaming-messages-json`. An error envelope (`error_max_turns`,
`error_during_execution`, `error_max_structured_output_retries`) fails the call while keeping
everything grok managed to say, so the work stays resumable.

## Sessions

`grok` returns a session id; `grok_reply` resumes it with `session/load` (acp) or `--resume` (print).
The conversation lives in grok's own session store (`~/.grok`), so follow-ups keep working across
restarts of this server — the session → directory map is persisted in
`~/.local/state/grok-mcp/sessions.json`.

Concurrent replies to one session are serialized per server process. **Cross-process caveat:** if
you run two MCP clients against two server processes and both reply to the *same* session id at the
same time, nothing serializes them. In practice one client owns a session.

## Transports

| | `acp` (default) | `print` |
|---|---|---|
| command | `grok agent --always-approve stdio` | `grok --prompt-file … --output-format streaming-messages-json` |
| process | stays up, speaks ACP JSON-RPC | one process per turn, exits when done |
| mid-run delivery | `grok_send` (interrupt / steer / follow_up) | impossible |
| follow-up | `session/load` then `session/prompt` | `--resume <id>` |
| deadline / cancel | grok's `session/cancel` first, signals as fallback | SIGTERM, then SIGKILL |

`acp` is the default because it is a superset: the same answer, plus a running turn stays
reachable and an interrupted one is ended in-protocol. Pick `print` per call with `transport`,
or set `GROK_MCP_TRANSPORT=print`, when you want a process that cannot be talked to.

**This server never sends anything into grok on its own.** No automatic wrap-up before a deadline,
no injected instructions: `grok_send` fires only when the caller calls it.

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `GROK_MCP_BIN` | `grok` | Path to the grok binary. |
| `GROK_MCP_APPROVAL_MODE` | `yolo` | Default approval mode for every call. |
| `GROK_MCP_MODEL` | unset | Default model for every call. |
| `GROK_MCP_TRANSPORT` | `acp` | Default transport: `acp` or `print`. |
| `GROK_MCP_TIMEOUT_MS` | unset | Server-wide default wall clock; unset means no deadline. |
| `GROK_MCP_MAX_TIMEOUT_MS` | `86400000` | Ceiling on what `timeout_ms` may ask for. |
| `GROK_MCP_MAX_CONCURRENT` | `100` | Concurrent grok processes. |
| `GROK_MCP_MAX_OUTPUT` | unset | Cap on the answer. Unset means no truncation. |
| `GROK_MCP_STDERR_LIMIT` | `1500` | stderr tail included in the response. |
| `GROK_MCP_STDERR_KEEP_EVENTS` | unset | `1` forwards stderr verbatim, protocol lines included. |
| `GROK_MCP_MAX_CAPTURE` | `16000000` | Read-buffer guard against a runaway stream. |
| `GROK_MCP_MAX_LINE` | `8000000` | Longest single message line from grok before it is dropped. |
| `GROK_MCP_MAX_FRAME` | `8000000` | Longest single JSON-RPC frame from the client. |
| `GROK_MCP_MAX_SESSIONS` | `200` | Remembered sessions before the oldest is dropped. |
| `GROK_MCP_KILL_GRACE_MS` | `5000` | SIGTERM → SIGKILL grace period. |
| `GROK_MCP_INTERRUPT_GRACE_MS` | `5000` | How long `session/cancel` gets before signals (acp only). |
| `GROK_MCP_INIT_TIMEOUT_MS` | `15000` | Initialize-handshake timeout (acp only). |
| `GROK_MCP_MODELS_TIMEOUT_MS` | `60000` | Whole-run budget for the `grok_models` probe. |
| `GROK_MCP_STATE` | `~/.local/state/grok-mcp/sessions.json` | Session → cwd map. |
| `GROK_MCP_WRAP` | unset | Command prefix, e.g. a sandbox wrapper around grok. |

## Design

- **Process per call.** Grok's own session files are the source of truth, which is what makes
  follow-ups survive a restart of this server.
- **The wire contract is grok's own `streaming-messages-json`**, spoken directly. ACP updates are
  converted into the same shapes so answer selection is shared.
- **Fail closed on anything from grok.** An unknown result subtype, a failed handshake, a line that
  does not parse — reported as such, never normalized into success.
- **No process outlives its request.** Timeouts, cancellations and shutdown reap the whole grok
  process tree; nothing is left behind on any path.

## Development

TypeScript (native `tsc`), Biome, Vitest. Tests drive the real server binary over stdio against a
fixture that speaks grok's protocol; live tests against the installed `grok` are opt-in.

```bash
npm run hooks          # once per clone: git hooks from .githooks/
npm run build          # tsc -> dist/
npm test               # unit + type tests, no API access, no tokens
npm run test:live      # live tests against the real grok binary (spends tokens)
npm run check          # format + types + tests
npm run fix            # biome --write
```

## License

MIT
