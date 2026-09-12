# UX research — approvals and messages inside the coding tool

Written 2026-09-12. Goal: kill the separate daemon terminal. Approvals and teammate messages should
appear where the user already looks, and install should be 1-3 commands.

**Fetched and read in full** (authoritative): `code.claude.com/docs/en/{mcp,hooks,plugins,plugins-reference,discover-plugins,channels-reference,tools-reference,sub-agents}`
(several pulled as raw `.md` and grepped), `cursor.com/docs/{context/mcp,agent/hooks}`, `learn.chatgpt.com/docs/{hooks,extend/mcp}`,
GitHub `anthropics/claude-code#85442`, `openai/codex#17043`.
**Snippet-only (unverified)**: MCP spec 2026-07-28 MRTR/SEP-2260, Codex-version numbers, Cursor "full quit to
reload MCP", node-notifier action buttons.

## (a) Matrix

| | Claude Code | Codex CLI | Cursor |
|---|---|---|---|
| **Approval UI inside the tool** | ✅ native permission dialog on an un-allowlisted MCP tool call | ✅ same, via `default_tools_approval_mode` = `prompt`/`writes` | ✅ same (MCP tool approval) |
| **MCP elicitation (server → user dialog)** | ✅ stdio ("dialogs appear automatically", form + URL mode); ❌ **broken over streamable HTTP** (#85442, open, v2.1.226) | ✅ merged 2026-04-08 for custom servers; empty-schema elicitation renders as a **message-only approval prompt** | ✅ documented as supported ("Server-initiated requests for additional information from users") |
| **Elicitation outside a tool call** | ❌ | ❌ | ❌ — spec-level: server-initiated requests only while the server is processing a client request (SEP-2260) |
| **MCP sampling** | ❌ not documented anywhere in the MCP page | ❌ not documented | ❌ not listed |
| **Push a message mid-session, no user action** | ✅ **plugin monitors** (auto-start, every stdout line delivered to Claude as a notification) · ✅ **Monitor tool with a `ws://` source** (each text message = one event, `persistent`) · ⚠️ **channels** (`notifications/claude/channel`) but research-preview + `--dangerously-load-development-channels` | ⚠️ partial: `Stop` hook can continue the turn with a new prompt; `async` command hooks deliver output "at the next safe conversation point"; `SessionStart`/`UserPromptSubmit` `additionalContext` | ❌ none found. `sessionStart` + `beforeSubmitPrompt` `additional_context` only → prompt-time, not push |
| **Permission relay out to another device** | ✅ channels `claude/channel/permission` (relays *the owner's own* prompts — not a teammate's request) · ✅ Remote Control | ❌ | ❌ |
| **Hook can decide a permission** | ✅ `PermissionRequest` → `decision: allow/deny/ask`; `PreToolUse` → `permissionDecision`. **No hook can prompt the user.** | ✅ `PermissionRequest`, `PreToolUse` allow/deny/rewrite | ✅ `preToolUse`/`beforeMCPExecution`/`beforeShellExecution` → `allow/deny/ask` |
| **Restart-free MCP registration** | ✅ as a **plugin**: `/plugin install` activates in-session (v2.1.221+) and connects its MCP servers; `/reload-plugins` otherwise. Also `list_changed` for tool changes on a live server | ❌ open feature requests (#7767, #4955, #37628) | ❌ requires a full quit |
| **One-command install of everything** | ✅ one plugin = `.mcp.json` + `hooks/hooks.json` + `monitors/monitors.json` + `skills/` + `bin/` | ⚠️ `codex mcp add mesh --url …` + hooks.json written separately | ⚠️ write `.cursor/mcp.json` + `.cursor/hooks.json` |
| **OS notification with buttons** | n/a (tool-agnostic) — node-notifier `actions`/`reply` fire a callback in the daemon process, so a click routes back trivially; but terminal-notifier 2.x dropped action buttons and macOS needs notification permission for the helper bundle. **Partial / flaky.** |

## (b) Best path per tool

### Claude Code — plugin monitor + a deliberately un-allowlisted decision tool
This is the whole answer and needs no preview flags.

1. `monitors/monitors.json`: `[{ "name": "mesh", "command": "\"${CLAUDE_PLUGIN_ROOT}\"/bin/mesh watch", "description": "Teammate requests and messages" }]`
   — starts at session start, unsandboxed, same trust level as hooks. Every stdout line is delivered to
   Claude as a notification mid-conversation; "Claude interjects when an event arrives."
   `mesh watch` = the existing daemon's WS feed, one line per request/message (~20 lines of code, it is `mesh feed` filtered to me).
2. The line says: `dev wants to run figma-export 8fA… — why: needs the frame. Call mesh__approve_request with id=xyz to ask the user.`
3. Claude calls `mesh__approve_request({ id, requester, what, why })`. Because mesh tools are **not** in
   `permissions.allow`, Claude Code raises its own permission dialog showing the tool name and those args
   verbatim. **1 = yes → approve, 2 = no → deny**, and the tool returns the verdict to the daemon.
   Zero new UI: the approval is Claude Code's native prompt, in the window the owner is already in.
4. Same plugin ships `.mcp.json` (the eight mesh tools), `hooks/hooks.json` (the existing `emit.js` hooks),
   and `bin/mesh`. Install = `/plugin marketplace add <our-repo>` then `/plugin install mesh@mesh` — active
   in the current session, no restart.

Effort: `monitors.json` ~6 lines, `.mcp.json` ~8, plugin.json ~6, one new MCP tool ~40 lines, `mesh watch` ~20.
**Alternative with no plugin at all** (good demo fallback): a skill that tells Claude to call the `Monitor`
tool with `ws: { url: "wss://<relay>/?room=rho&user=dev&role=feed", persistent: true }`. One approval at the
start, then the relay's own frames land in the session. Note Monitor **denies private/link-local hosts**, so this
must be the public relay URL, never `localhost:7337`.
**Stretch, nicer UX**: once Claude is inside `mesh__approve_request`, the server is processing a client request,
so it may legally issue `elicitation/create` → a real form dialog ("Approve dev's request? yes/no"). Requires
switching the mesh server to **stdio** (a shim that proxies to the local daemon), because HTTP elicitation is
silently dropped (#85442).

### Codex CLI — MCP tool approval, or empty-schema elicitation
Keep `[mcp_servers.mesh] url = …` (already written by `register.ts`). Owner runs a `mesh_watch` tool that
long-polls; on an incoming request the server sends an **empty-schema elicitation** whose message is the
request — Codex renders that as a message-only approval prompt (PR #17043, merged 2026-04-08). If that proves
flaky, fall back to the same trick as Claude Code: `default_tools_approval_mode = "prompt"` and let Codex's own
"allow this tool call?" prompt be the approval. Push is the weak spot: use a `Stop` hook that appends pending
requests as the new prompt, plus `UserPromptSubmit` `additionalContext`. Effort ~1.5 h, unverified against a real binary.

### Cursor — elicitation, prompt-time injection
Cursor documents elicitation support, so the Codex design ports over. No push mechanism exists; `~/.cursor/hooks.json`
`sessionStart` and `beforeSubmitPrompt` with `additional_context` give the same pull-with-a-nudge we have today.
Cursor stays the known-limitation tool.

## (c) Recommendation for the next 6-8 hours

| rank | build | effort | why |
|---|---|---|---|
| 1 | **`mesh watch` line-stream + `approve_request` MCP tool** | 1.5 h | The whole in-tool approval story. Testable today with the `Monitor` tool alone — no plugin, no packaging. Demo becomes: Tarush never leaves Claude Code; the request appears in his session and he presses **1**. |
| 2 | **Ship as a Claude Code plugin** (`plugin.json` + `.mcp.json` + `hooks/hooks.json` + `monitors/monitors.json` + `bin/mesh`) | 1.5 h | Kills the restart *and* the separate terminal *and* the hook installer in one artifact. `/plugin install mesh@mesh` is the "1 command" in the pitch. Verified restart-free. |
| 3 | **Keep the TTY prompt as fallback** behind `mesh join --tty-approve` | 0.25 h | The stage safety net. `approval.ts` already auto-denies with `no tty`; make the in-tool path the default and the terminal the opt-in. |
| 4 | Stretch: stdio shim + real `elicitation/create` | 1.5 h | Prettier dialog, unlocks Codex and Cursor with the same code. Do not put it on the critical path. |
| 5 | Stretch: `node-notifier` with action buttons as a second surface | 1 h | Nice for "owner is in another app", but flaky on macOS 2026 and irrelevant on the projector. |

**Leave as known limitations** (say them on the honest-limitations slide): Cursor and Codex owners still get
pull-only messages; Codex/Cursor need a restart after registration; channels and Remote Control are the
*wrong* shape (they relay the owner's own prompts, not a teammate's request) and channels additionally need
`--dangerously-load-development-channels` and an Anthropic-curated allowlist for anything permanent; no MCP
client documents sampling, so sampling is not an option at all.

## (d) Risks and unknowns

- **Model-in-the-loop.** Monitor/channel events reach *Claude*, not the user. Claude must decide to call
  `approve_request`. If it ignores the line or paraphrases it, the owner never sees a prompt. Mitigate with an
  imperative line format, a `skills/` entry, and `instructions`. Test 3/3 before the demo.
- **Auto mode / `bypassPermissions` swallows the approval.** On Pro/Max, sessions start in auto mode, where a
  classifier decides instead of prompting. `approve_request` must be forced to prompt — put it in
  `permissions.ask` and verify, or the "y/n" beat silently self-approves. **Highest-risk unknown; test first.**
- **Latency while the owner is mid-task.** Channels queue notifications to the next turn; monitor lines interject
  but not necessarily instantly. mesh requests already expire after 30 s (`core.ts:151`). Raise that window.
- **#85442** makes HTTP elicitation a dead end today; anything elicitation-based needs the stdio shim.
- **Monitor tool unavailability**: disabled when `DISABLE_TELEMETRY` or `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`
  is set, and absent on Bedrock/Vertex/Foundry. Plugin monitors are also skipped in non-interactive sessions.
- **Version floors** we would be depending on: v2.1.221 for in-session plugin activation, v2.1.195 for the
  Monitor WebSocket source. Check `claude --version` on all three laptops at T-15.
- **Windows**: Tarush's risk #1 is unchanged — but the in-tool path actually *helps*, since it removes the raw-mode
  TTY requirement that `approval.ts:35` fails on under mintty.
- Unverified by me: that a plugin monitor's line reliably triggers a turn on a fully idle session; Codex
  empty-schema elicitation against a real binary; Cursor elicitation against a real binary.
