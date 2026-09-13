# mesh — borrow a teammate's machine, not their credentials

> Working name. Rename freely; nothing depends on it.

Your coding agent (Claude Code, Codex, Cursor) can ask a teammate's laptop to run a command or an MCP tool
it doesn't have the tools or credentials for. The teammate sees `dev wants to run: figma-export … [Deny] [Approve]` in the
mesh overlay (a small always-on-top window popped out of the room page; system dialog as fallback), clicks **Approve**,
and the output streams back to your agent. Credentials never leave the
owner's machine. Agents can also message each other, and every terminal in the room sees what every agent is doing.

## Layout
```
apps/relay      WebSocket relay + web front door + installers + overlay
apps/daemon     `mesh join` + local MCP server + approvals
apps/feed       `mesh feed`, hooks, demo
packages/protocol   shared TS types for every message/tool (source of truth)       — Dev writes, everyone imports
scripts/        figma-export.sh, tunnel-relay.sh
plugin/         Claude Code plugin (MCP server, hooks, watcher); relay serves it as /plugin.tgz
docs/
```

## Working in this repo
See `AGENTS.md`: contract-first, suites green before every push, small commits on `main`.

## Quick start for teammates (one command, no clone)
Open the room link someone shared (`https://<relay>/r/<room>`) and run the command it shows, or:
```bash
# macOS / Linux
curl -fsSL https://<relay>/install.sh | bash -s -- <room> [--as <you>]
```
```powershell
# Windows PowerShell
& ([scriptblock]::Create((irm -Headers @{'ngrok-skip-browser-warning'='1'} https://<relay>/install.ps1))) <room> [--as <you>]
```
Needs Node 20+ and nothing else: no clone, no pnpm, no npm account, no `team.json`. It downloads the single-file
daemon (`~/.mesh/mesh.mjs`, ~2.5 MB, served by the relay at `/mesh.mjs`) plus the hook emitter (`~/.mesh/emit.js`)
and runs `mesh join <room> --background`. That:
- picks your handle from `git config user.name` (override with `--as`);
- imports every MCP server in your Claude Code / Cursor configs and offers its tools to the room (permission **ask**);
- Claude Code: installs the mesh **plugin** from `<relay>/plugin.tgz` (`claude plugin marketplace add` + `claude plugin install
  mesh@mesh`, project scope) — MCP server, hooks and the in-session watcher in one step, no extra commands; falls back to
  `claude mcp add` + a hook merge into `.claude/settings.json` if the plugin can't be installed;
- registers the mesh MCP server with Codex (`codex mcp add`) and Cursor (`.cursor/mcp.json`, if a `.cursor` dir exists);
- stays running in the background. **Restart your agent session once** (Claude Code: or `/reload-plugins`) so it picks up the mesh tools.

Re-running the one-liner updates the bundle and stops + restarts a running daemon. Prefer a file? The room page offers
`mesh-join-<room>.cmd` (Windows, double-click) and `mesh-join-<room>.command` (Mac, right-click → Open).

**Approvals.** On the room page click **Pop out overlay** (shipping tonight): a small always-on-top window (Chrome/Edge
Document Picture-in-Picture, popup fallback) with pending requests + Approve/Deny, teammate messages with a reply box, and
the live feed. While it is open the daemon routes approvals there instead of the modal OS dialog; no answer in 120 s → the
OS dialog appears as fallback. Same path for Codex, Cursor and Claude Code users. Without the overlay: native OS dialog
(macOS, Windows message box, Linux zenity), no answer in 90 s = denied. Claude Code users additionally get requests and
messages delivered inside their session by the plugin monitor. `MESH_APPROVE=tty` (or `join` without `--background`)
approves in the terminal instead.

**Messages.** Arrive in the overlay, as an OS notification (Windows: a small message box), live in Claude Code, and via the
`inbox` tool. Codex/Cursor: *"Codex, watch mesh for the next 10 minutes"* makes the agent loop on `wait_for_events`
(shipping tonight) and report each message or request as it lands; approvals stay with you. Manage the daemon with
`node ~/.mesh/mesh.mjs status | stop | log`.

## Quick start for developers of mesh (from the repo)
No build step for dev: `@mesh/protocol` is imported straight from `src/` by `tsx`.
```bash
pnpm install
pnpm -r typecheck                                        # all 4 packages

# 1. relay — one laptop, everyone else points at its URL
./scripts/tunnel-relay.sh                                # bundles the daemon, relay on :8090 + ngrok, prints the install one-liner
PORT=8090 pnpm -F relay start                            # or local-only: ws://localhost:8090 (warns if the bundle is missing)
pnpm -F daemon bundle                                    # apps/daemon/dist/mesh.mjs (esbuild); the relay serves it at /mesh.mjs

# 2. daemon — every laptop. Room name or room link; team.json optional
pnpm -F daemon start join https://<host>/r/<room>        # zero-config: handle from git, imports your MCPs, registers agents + hooks
pnpm -F daemon start join <room> --as dev --relay wss://<host> [--config /abs/team.json] [--port 7337] [--no-register] [--background]

# 3. feed — the projector pane
pnpm -F feed start <room> --relay wss://<host>

# 4. hooks — installed by `mesh join`; the manual installer still works
hooks/install.sh /path/to/your/repo                      # writes .claude/settings.json (jq required)
```
Do not write `pnpm -F daemon start -- join …`: pnpm 10 passes the `--` through and commander stops parsing.
`--config ./team.json` resolves against `apps/daemon/`; pass an absolute path.

Tests: `pnpm -F daemon test`, `pnpm -F daemon exec tsx test/mcp.test.ts`, `pnpm -F relay test` (28 checks),
`RELAY_URL=ws://localhost:8090 pnpm -F relay soak` (relay must be running).

## Hosting the relay (the public link)
The relay serves the web front door on the same port: `/` starts a session, `/r/<room>` is the room page with the join
command, who's online, and a live feed; `/api/rooms` backs it; `/overlay?room=&port=` is the pop-out approval window
(shipping tonight). The same port serves the one-command join: `/install.sh`, `/install.ps1`, `/join.cmd`, `/join.command`,
`/mesh.mjs` (the daemon bundle), `/emit.js` and `/plugin.tgz` (the Claude Code plugin, built from `plugin/` at relay start). The install scripts bake in the relay's public origin from
the request's `Host` / `X-Forwarded-Proto` headers, so they work behind ngrok and Railway without configuration.

**Now:** `./scripts/tunnel-relay.sh` on Dev's Mac (relay `:8090` + ngrok). The hostname has been stable for this ngrok
account across launches; `NGROK_DOMAIN=…` pins it. Free ngrok shows a one-time "visit site" interstitial in browsers;
the installers send `ngrok-skip-browser-warning: 1` and the daemon's WebSocket is unaffected. Always `pkill -x ngrok` first.

**Permanent (Railway, ~5 min, still to do):** New Project → Deploy from GitHub repo → pick `dg4329-hash/rho_hackathon`
(repo root; `railway.json` points at `apps/relay/Dockerfile`, which runs `pnpm -F daemon bundle` so the image serves
`/mesh.mjs`) → Settings → Networking → Generate Domain. The service reads `PORT`. Health check is `/health`. Vercel won't
work: the relay needs a long-lived WebSocket server.

## Verified (2026-09-12)
Mac↔Mac and Mac↔Windows over the public relay: install one-liner (bash, and PowerShell on a real Windows box), shell
request → native dialog (macOS; Windows MessageBox) → output back, Windows message-box notifications, agent-to-agent
messages both ways, Codex registration with codex-cli 0.154, plugin auto-install during `mesh join` on Dev's Mac (which
imports and offers Playwright, 24 tools, + filesystem, 14). Overlay and `wait_for_events`: shipping tonight, not yet verified.

## Known limits
- Room name is the only auth.
- Codex and Cursor agents get messages by pulling (`inbox`) or by looping on `wait_for_events`; only Claude Code has push
  delivery (plugin monitor + prompt hook). Humans on any tool get them in the overlay.
- The overlay needs Chrome/Edge for the always-on-top PiP window; other browsers get a plain popup.
- Codex tool calls not exercised (no login); OAuth remote MCPs (official Figma, Linear) can't be imported — use a shell offer.
- Agent sessions must restart once after registration (client tool-list caching; Claude Code: `/reload-plugins`).
