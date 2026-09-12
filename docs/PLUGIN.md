# mesh as a Claude Code plugin — approvals inside Claude Code

On `main` since 2026-09-12 (`b04b75b`). Implements the recommendation in `docs/UX-RESEARCH.md` §(b)/(c) ranks 1-3:
no separate daemon terminal, teammates' requests appear in your Claude Code session, and the yes/no is
Claude Code's own permission prompt. Installed automatically by `mesh join`; one `/reload-plugins` or session restart.

## Install

**Automatic (the default).** `mesh join` — and therefore the one-liner — downloads `<relay>/plugin.tgz` to `~/.mesh/plugin.tgz`,
unpacks it into `~/.mesh/marketplace`, then runs `claude plugin marketplace add ~/.mesh/marketplace` and
`claude plugin install mesh@mesh --scope project` in the join directory (`apps/daemon/src/register.ts`
`registerClaudePlugin`). Join banner: `✓ Claude Code plugin: registered  mesh@mesh (project scope) — approvals and
messages appear inside Claude Code`; on later joins `already registered`, and the `claude mcp add` / hooks rows read
`the mesh plugin provides …`. The relay builds `plugin.tgz` from `plugin/` + `.claude-plugin/` at start
(`apps/relay/src/index.ts`). Skipped when `claude` isn't on PATH; a failure is one line in the banner and the classic path
(`claude mcp add` + hook merge) runs instead. No extra commands for Claude Code users.

**Manual** (local checkout; what was first verified):

```bash
claude plugin marketplace add /path/to/rho_hackathon      # the repo root holds .claude-plugin/marketplace.json
claude plugin install mesh@mesh --scope project           # or --scope user; inside a session: /plugin install mesh@mesh
```

GitHub form (same manifest, untested):

```bash
claude plugin marketplace add dg4329-hash/rho_hackathon
claude plugin install mesh@mesh
```

Inside an interactive session `/plugin install mesh@mesh` activates the plugin in place (Claude Code ≥ 2.1.221;
2.1.270 was used here). After `claude plugin install` from a shell, run `/reload-plugins` in an open session or
start a new one.

The daemon still has to exist on the machine: the plugin's `bin/mesh` launcher finds it as `$MESH_BIN`,
`~/.mesh/mesh.mjs` (the relay's install one-liner), a repo checkout with `node_modules` (this repo when loaded
with `--plugin-dir ./plugin`, or the marketplace's install location), or `mesh` on `PATH`. Join once with
`mesh join <room-link> --background`; it writes `~/.mesh/config.json`, and from then on the plugin's
SessionStart hook restarts the daemon (`--no-register`) whenever it is not running.

Port: everything reads `MESH_PORT` (default 7337): `.mcp.json` uses `http://localhost:${MESH_PORT:-7337}/mcp`,
and the monitor / SessionStart hook pass `--port`.

## What the plugin contains (`plugin/`)

| file | role |
|---|---|
| `.claude-plugin/plugin.json` | manifest, name `mesh` → tools are `mcp__plugin_mesh_mesh__<tool>` |
| `.mcp.json` | the daemon's streamable-HTTP MCP server (10 tools incl. `approve_request` and `wait_for_events`) |
| `hooks/hooks.json` + `hooks/emit.js` | the four CONTRACT §4 hooks (copy of `hooks/emit.js`; keep in sync) and a SessionStart hook |
| `bin/mesh-session-start` | SessionStart: ensure the ask rule, `GET /health`, else restart from `~/.mesh/config.json` |
| `monitors/monitors.json` + `bin/mesh-watch` | background monitor running `mesh watch`; every stdout line (pending request, or a teammate message forwarded live) reaches Claude as a notification |
| `hooks/ensure-ask.js` | writes `permissions.ask` for `approve_request` into `<project>/.claude/settings.json` |
| `skills/mesh/SKILL.md` | tells Claude to act on the notification line and how the approve flow works |
| `bin/mesh` | launcher (see Install) |

`.claude-plugin/marketplace.json` at the repo root lists the plugin as `./plugin`.

## Approval flow

1. A teammate's daemon sends a `request` for something you offer with permission `ask`.
2. Your daemon picks the approval surface with `selectApprovalPath()` (`apps/daemon/src/pending.ts`), in this
   precedence: `MESH_APPROVE=tty|dialog` forces that surface → a **watcher** (a `GET /pending` long-poll seen in
   the last 60 s) → native OS dialog → terminal y/n. `MESH_APPROVE=watcher` forces the queue.
3. Watcher path: the request is parked in the pending queue (`GET /pending?wait=25` wakes), and `mesh watch`,
   run by the plugin monitor, prints one line:
   `mesh: bob wants to run \`date\` on this machine (why: …). Call approve_request({"id":"…","decision":"approved"}) now so the user gets the permission prompt; if they reject it, call it again with "decision":"denied".`
   The same watcher forwards teammate messages live (`GET /pending?wait=25&messages=1`, default consumer marks them read):
   `mesh: message from tarush: "…". Tell the user, and if a reply is needed use the mesh send_message tool (to: "tarush").`
4. Claude calls `mcp__plugin_mesh_mesh__approve_request`. That tool is never allowlisted; it declares
   `_meta["anthropic/requiresUserInteraction"]: true` (Claude Code ≥ 2.1.199 prompts on every call, in auto and
   bypassPermissions too, no "don't ask again") and both tool names are in the project's `permissions.ask` as a
   backstop. Claude Code's permission prompt shows the id and decision; **1/yes → approved** and the daemon runs
   the job; rejecting the prompt → Claude calls again with `denied` so the teammate hears back.
5. Nobody answers within 120 s, or the watcher stops polling (checked every 5 s): the daemon falls back to the
   native dialog / tty prompt exactly as before. `POST /decide {id, decision, reason?}` is the HTTP equivalent of
   the tool (used by the tests and by anything that is not Claude Code).
6. The room-page **overlay** (shipping tonight, `docs/OVERLAY-API.md`) is a second watcher on the same queue: it
   long-polls `/pending` with `consumer=overlay` and answers with `POST /decide`. Whichever surface answers first
   wins; the other sees the id vanish. It is the universal path for Codex/Cursor owners; Claude Code owners get both.

Daemon-side changes (all on this branch, `apps/daemon/src`): `pending.ts` (new), `approval.ts`, `api.ts`,
`core.ts`, `local-server.ts`, `cli.ts`, `register.ts`; plus `packages/protocol/src/index.ts`
(`ApproveRequestInput`, `PendingRequest`, `TOOL_DESCRIPTIONS.approve_request`). `mesh join` now also writes
`~/.mesh/config.json` and skips `claude mcp add` / hook install when the plugin is installed (no duplicate server
or hooks), while still writing the `permissions.ask` rule.

Tests: `pnpm -F daemon test` (run.ts + the new `test/pending.test.ts`: path selection, queue, watcher poll +
`/decide` end to end, no-watcher fallback, ask-rule writer) and `pnpm -F daemon exec tsx test/mcp.test.ts`
(9 tools, `_meta` flag, `approve_request`, `/pending`, `/decide`). All green on 2026-09-12.

## Verified on 2026-09-12 (Claude Code 2.1.270, local relay `PORT=8090`, isolated `$HOME`s)

- `claude plugin validate ./plugin` and `claude plugin validate .` (marketplace) pass.
- `claude plugin marketplace add <worktree>` + `claude plugin install mesh@mesh --scope project` into a scratch
  project: plugin copied to `~/.claude/plugins/cache/mesh/mesh/0.1.0`, `enabledPlugins` written.
- Daemon A (alice, `date` offered with `ask`, port 7437) + `plugin/bin/mesh-watch` (the exact monitor command)
  + daemon B `mesh ask alice date`: (i) `mesh watch` printed the one line above with the request id;
  (ii) `POST /decide {approved}` → A ran `date`, B's `mesh ask` printed the date and exited 0; the queue drained.
- (iii) `claude -p` in the scratch project with `MESH_PORT=7437`: Claude listed all nine
  `mcp__plugin_mesh_mesh__*` tools including `approve_request` (so `${MESH_PORT:-7337}` expands in a plugin
  `.mcp.json`); the SessionStart hook ran and wrote
  `permissions.ask: ["mcp__mesh__approve_request", "mcp__plugin_mesh_mesh__approve_request"]` into the scratch
  project's `.claude/settings.json` (auto-mode mitigation present).
- Calling `approve_request` from `claude -p` is refused by Claude Code with `<error>MCPTool requires permission.</error>`
  and appears under `permission_denials`: the tool is gated, never auto-approved.

## Not verified — needs a human in an interactive session

1. Open `claude` in a project with the plugin installed while the daemon runs (`mesh join … --background`), have
   a teammate `mesh ask you "date"`, and confirm the monitor line interjects mid-session and Claude calls
   `approve_request` on its own (UX-RESEARCH risk "model-in-the-loop"; the skill and the imperative line are the
   mitigation, test 3/3 before the demo).
2. Press **1 / Yes** on the resulting permission prompt and confirm the teammate's `mesh ask` completes; then
   repeat and press **No**, confirm Claude calls again with `denied` and the teammate sees `denied: …`.
3. Do (2) once with the session in **auto mode** to confirm the prompt still appears (docs say ask rules and
   `requiresUserInteraction` both force it; not exercised here).
4. `/plugin install mesh@mesh` inside a running session activates without restart (documented for ≥ 2.1.221; only
   the shell `claude plugin install` + new session was exercised).
5. The GitHub marketplace form (`dg4329-hash/rho_hackathon`) once the branch is merged.

## Facts that differ from `docs/UX-RESEARCH.md`

- Plugin MCP tools are named `mcp__plugin_<plugin>_<server>__<tool>`, so the tool is
  `mcp__plugin_mesh_mesh__approve_request`, not `mesh__approve_request`; hook matchers and permission rules must use
  that form.
- A plugin `settings.json` only supports `agent` and `subagentStatusLine`; plugins cannot ship permission rules.
  Hence the ask rule lives in the project's `.claude/settings.json` (written by `mesh join` and by the SessionStart
  hook).
- Better than an ask rule: `_meta["anthropic/requiresUserInteraction"]: true` on the tool makes Claude Code prompt
  in every mode including bypassPermissions, with no "don't ask again" (≥ 2.1.199). The daemon sets it; the ask
  rule is kept as a backstop for older versions.
- Monitors are auto-discovered from `monitors/monitors.json` (also `experimental.monitors` in the manifest), run
  in the session's working directory, are skipped in non-interactive sessions, and keep running until the session
  ends even if the plugin is disabled.
- A local-directory marketplace is referenced in place (`known_marketplaces.json` `installLocation` = the
  directory), while the plugin itself is copied to `~/.claude/plugins/cache/<marketplace>/<plugin>/<version>`;
  `bin/mesh` accounts for both when looking for a repo checkout.
