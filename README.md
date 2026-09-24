# mesh: borrow a teammate's machine, not their credentials

**Live site:** https://relay-production-8eef.up.railway.app/site  ·  **Demo film:** [`demo/render/mesh-demo-cleaned.mp4`](demo/render/mesh-demo-cleaned.mp4)

mesh lets a coding agent (Claude Code, Codex or Cursor) run a command or MCP tool on a **teammate's laptop** when it lacks
the tools or credentials itself. The teammate sees an approval prompt (`dev wants to run: figma-export … [Deny] [Approve]`),
clicks Approve, and the output streams back to the requesting agent. API keys and logins never leave the owner's machine.

Built at a hackathon in September 2026 by Dev Gadde, Tarush Garg and Abhiviraj G.

### Why
On a small team, one person has the Figma token, another has the Supabase login, a third has the Vercel deploy. Today
you either share secrets in Slack or wait for that person. mesh routes the *request* to the machine that already has the
access, and a human approves every call.

### What it does
- **One-line join.** `curl … | bash` downloads a single-file daemon, reads your existing Claude Code / Cursor MCP servers
  and offers their tools to the room. Nothing is shared until you approve it.
- **Human-in-the-loop approvals.** An always-on-top overlay (Document Picture-in-Picture) or the native OS dialog shows each
  request; no answer means denied.
- **Agent-to-agent messaging** and a shared live feed of what every teammate's agent is doing.
- **Edit awareness.** Before your agent edits a file a teammate touched in the last 10 minutes, a hook warns it to coordinate.
- **Claude Code plugin** (MCP server + hooks + in-session watcher), plus Codex and Cursor registration.

### How it works
```
agent ──MCP──▶ local daemon ──WebSocket──▶ relay (Railway) ──▶ teammate's daemon ──▶ [Approve?] ──▶ runs tool locally
                                                                                                   │
agent ◀──────────────── output streamed back through the relay ◀──────────────────────────────────┘
```
Rooms are gated by an HMAC-derived key in the share link; the relay only forwards frames and never holds tool credentials.

### Tech stack
TypeScript monorepo (pnpm workspaces) · Node 20 · WebSockets (`ws`) · Model Context Protocol SDK · Express · Electron
(tray app) · Docker on Railway · Claude Code plugin + hooks.

### Status
Hackathon project, working end to end. Verified Mac↔Mac and Mac↔Windows over the public relay (details under
[Verified](#verified-2026-09-12)). Not production-hardened; see [Known limits](#known-limits).

---

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

**Approvals.** On the room page click **Pop out overlay**: a small always-on-top window (Chrome/Edge
Document Picture-in-Picture, popup fallback) with pending requests + Approve/Deny, teammate messages with a reply box, and
the live feed. While it is open the daemon routes approvals there instead of the modal OS dialog; no answer in 120 s → the
OS dialog appears as fallback. Same path for Codex, Cursor and Claude Code users. Without the overlay: native OS dialog
(macOS, Windows message box, Linux zenity), no answer in 90 s = denied. Claude Code users additionally get requests and
messages delivered inside their session by the plugin monitor. `MESH_APPROVE=tty` (or `join` without `--background`)
approves in the terminal instead.

**Messages.** Arrive in the overlay, as an OS notification (Windows: a small message box), live in Claude Code, and via the
`inbox` tool. With `"codexWake": true` in your local `team.json`, each fresh teammate message also starts a separate,
hidden `codex exec` run automatically. It uses your normal Codex login, project instructions, and configured mesh MCP
server, runs messages one at a time, and shows its final status in a native Windows alert. Mesh approvals still belong to
you in the overlay or OS dialog; the background Codex run never decides them. This is opt-in because teammate messages
can cause Codex work and usage. `--no-codex-wake` disables it for one join. Codex/Cursor can also loop on
`wait_for_events` when asked to watch mesh. Manage the daemon with
`node ~/.mesh/mesh.mjs status | stop | log`.

**Awareness.** Every daemon reports which files its owner's agent is editing (`file_touched`): Claude Code via hooks, and
everyone else via the daemon's git watch (`git status` every 5 s inside a git repo; `--no-git-watch` to disable). Before a
Claude Code agent edits a file a teammate touched in the last 10 minutes, a `PreToolUse` hook drops one line into its
context — `mesh: abhi edited src/billing.ts 3 min ago — coordinate before changing it (send_message abhi)` — and never
blocks the edit. Owners can also publish **fixed command lines** as offers (`"command": "git diff HEAD"` → agents ask for
`git.diff` by name, the owner's exact line runs, nothing else matches), which is the safe way to mark a shell offer `always`.

## Quick start for developers of mesh (from the repo)
No build step for dev: `@mesh/protocol` is imported straight from `src/` by `tsx`.
```bash
pnpm install
pnpm -r typecheck                                        # all 4 packages

# 1. relay — one laptop, everyone else points at its URL
./scripts/tunnel-relay.sh                                # bundles the daemon, relay on :8090 + ngrok, prints the install one-liner
PORT=8090 pnpm -F relay start                            # local-only: ws://localhost:8090; builds the current daemon bundle before serving it
# Windows PowerShell: $env:PORT='8090'; corepack pnpm -F relay start
pnpm -F daemon bundle                                    # optional standalone rebuild of apps/daemon/dist/mesh.mjs

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

Tests: `pnpm -F daemon test`, `pnpm -F daemon exec tsx test/mcp.test.ts`, `pnpm -F daemon exec tsx test/gitwatch.test.ts`,
`pnpm -F daemon exec tsx test/touched.test.ts`, `pnpm -F relay test` (28 checks),
`RELAY_URL=ws://localhost:8090 pnpm -F relay soak` (relay must be running).

## Hosting the relay (the public link)
The relay serves everything: landing page, room pages, installers, the daemon bundle, the plugin, the overlay, and the file store.

**Permanent (Railway dashboard, no CLI, ~10 minutes):**
1. **Create.** Railway → New Project → Deploy from GitHub repo → `dg4329-hash/rho_hackathon` (authorize the Railway GitHub app if asked). Branch `main`. Leave root directory empty and don't set a start command: `railway.json` at the repo root selects `apps/relay/Dockerfile` and the `/health` healthcheck.
2. **Secret.** Service → Variables → New Variable `ROOM_SECRET` = output of `openssl rand -hex 32`. Put it in a password manager. **Never change or delete it**: every room key is HMAC(`ROOM_SECRET`, room), so changing it breaks every link ever shared. Don't set `MESH_REQUIRE_KEY` or `PORT` (Railway injects `PORT`). Optional: `MESH_REPO_URL`.
3. **Domain.** Settings → Networking → Public Networking → Generate Domain. If Railway asks for a port, it's the one the relay listens on (`$PORT`). You get `https://<name>.up.railway.app`.
4. **Wait.** Deployments → latest shows **Active** (build ~2–4 min; `/health` must pass).
5. **Verify** (`R=https://<name>.up.railway.app`):
   ```bash
   curl -s $R/health                                   # {"rooms":0,"connections":0}
   curl -sI $R/mesh.mjs | head -1                      # HTTP/2 200
   curl -s $R/plugin.tgz | tar -tz | head              # .claude-plugin/marketplace.json, plugin/…
   curl -s $R/install.sh | grep -m2 'wss://\|https://' # the Railway host, https/wss
   curl -s -XPOST $R/api/rooms                         # {"room":…,"key":…,"link":…}
   curl -s "$R/api/rooms/<room>?key=<key>"             # 200 JSON
   curl -s "$R/api/rooms/<room>"                       # 401 room key required
   ```
   Then open the `link` in a browser.
6. **Restart test.** Deployments → ⋯ → Restart. The same link still works (fixed `ROOM_SECRET`). Rooms and history live in memory: a restart/redeploy drops presence and history; daemons reconnect on their own.
7. **Share.** Landing page → "Start a session" gives `https://<domain>/r/<room>#k=<key>`; installers served from that host bake in https/wss. Then ask Tarush to update the relay URL line in `docs/PLAN.md`.
8. **Troubleshooting.**
   - `/plugin.tgz` 503 → image is missing `plugin/` (fixed in the Dockerfile; redeploy from current `main`).
   - Links stop working after a deploy → `ROOM_SECRET` changed or unset (logs show `! ROOM_SECRET not set`).
   - 429 → per-IP rate limit (below).
   - Daemon log repeats `relay error: user "<name>" is already connected` → two machines use the same name; re-join one with `--as <name>`.

**Relay limits (public URL; all env-tunable):**
- `POST /api/rooms`: 20 burst, then 20/min per IP → 429 + `Retry-After`.
- WebSocket connects: 60 burst, then 120/min per IP → error frame + close 1013. `MESH_RATE_LIMIT=0` disables both.
- Max 10 000 rooms (`MESH_MAX_ROOMS`) → 503 on create, close 1013 on connect.
- Empty rooms (no connections) are forgotten after 2 h idle (`MESH_ROOM_IDLE_MS`). Only history is lost; the link keeps working.
- Frames over 2 MiB close the socket (`MESH_MAX_FRAME_BYTES`).
- Per-room history ≤ 200 frames and ≤ 4 MiB (`MESH_HISTORY_MAX_BYTES`).
- A second daemon (with offers) under the same user name in a room is refused (close 4409), unless the existing one fails a ping within 3 s (`MESH_DUP_PROBE_MS`). `mesh ask` under your own name is unaffected.
- One replica only (`numReplicas: 1`): rooms live in process memory.

**Railway cost (let the relay sleep when nobody is using it):**
1. **Serverless.** Service → Settings → Deploy → Serverless → turn on "Enable Serverless", then redeploy (Deployments → ⋯ → Redeploy). It only applies to new containers.
2. **Replica limits.** Service → Settings → Deploy → Replica Limits → e.g. 0.5 vCPU / 512 MB. Railway bills what you use, not the limit, so this is a ceiling against runaway usage (the file store caps at 200 MB). Too low and the relay crashes.
3. **Usage limit.** On the workspace Usage page, set a soft limit (email alert) and optionally a hard limit (min $10; it takes the service offline when hit).

How it behaves:
- A service sleeps 5–10 minutes after it stops sending outbound traffic. While asleep it costs no CPU or RAM (all memory is freed, so rooms and history are gone; links keep working because keys are derived from `ROOM_SECRET`).
- Any open socket keeps it awake: the relay pings every connected daemon every 25 s. A room page or overlay left open polls every 2 s, which also keeps it awake. With zero sockets and no page polling, the relay sends nothing (its timers don't touch the network).
- So it sleeps once everyone leaves or the host ends the session (`end_session`, `mesh end`, or the room page button): that closes every socket, and daemons don't reconnect. Close room tabs and the overlay too.
- It wakes on the next inbound request: someone opening the web page, running the installer, or a daemon joining. The first request after sleep can be slow or return 502 (cold start: the container boots and runs `tsx`). Retry after a few seconds; daemons retry on their own.
- The `/health` healthcheck in `railway.json` runs only during a deploy, so it doesn't keep the relay awake. Keep it.

Docs: [Serverless](https://docs.railway.com/reference/app-sleeping), [Cost control](https://docs.railway.com/pricing/cost-control), [Healthchecks](https://docs.railway.com/reference/healthchecks).

**Stop-gap (any Mac with ngrok):** `ROOM_SECRET=<something> ./scripts/tunnel-relay.sh` prints the public URL. Free ngrok shows a one-time browser interstitial; the installers and daemon send the skip header automatically. Without `ROOM_SECRET` the relay makes a random one and all room links stop working when it restarts.

**Security model:** a room is reachable only with its link (`/r/<room>#k=<key>`); the key gates the WebSocket, the feed, files, and the overlay. Anyone you forward the link to is in. Approvals still gate what teammates can run. See `docs/ROOM-KEYS.md`.
The WebSocket URL carries `?key=` in the query string, so proxy access logs (e.g. Railway HTTP logs) may record it.

Vercel won't work: the relay needs a long-lived WebSocket server.

## Verified (2026-09-12)
Mac↔Mac and Mac↔Windows over the public relay: install one-liner (bash, and PowerShell on a real Windows box), shell
request → native dialog (macOS; Windows MessageBox) → output back, Windows message-box notifications, agent-to-agent
messages both ways, Codex registration with codex-cli 0.154, plugin auto-install during `mesh join` on Dev's Mac (which
imports and offers Playwright, 24 tools, + filesystem, 14). The overlay and `wait_for_events` have automated coverage;
the separate Codex wake path was tested through a live self-addressed mesh message on Windows.

## Known limits
- Anyone who has a room link (with its `#k=` key) can join the room; approvals still gate what they can run.
- Codex and Cursor agents get messages by pulling (`inbox`) or by looping on `wait_for_events`; only Claude Code has push
  delivery by default (plugin monitor + prompt hook). Codex also gets separate automatic runs when `codexWake` is enabled.
  Humans on any tool get messages in the overlay.
- The overlay needs Chrome/Edge for the always-on-top PiP window; other browsers get a plain popup.
- A separate Codex run successfully called mesh `list_teammates` on Windows; OAuth remote MCPs (official Figma, Linear) still can't be imported — use a shell offer.
- Agent sessions must restart once after registration (client tool-list caching; Claude Code: `/reload-plugins`).
