# mesh — borrow a teammate's machine, not their credentials

> Working name. Rename freely; nothing depends on it.

Your coding agent (Claude Code, Codex, Cursor) can ask a teammate's laptop to run a command or an MCP tool
it doesn't have the tools or credentials for. The teammate gets a system dialog `dev wants to run: figma-export …
[Deny] [Approve]`, clicks **Approve**, and the output streams back to your agent. Credentials never leave the
owner's machine. Agents can also message each other, and every terminal in the room sees what every agent is doing.

## Assignments
| person | role | task file |
|---|---|---|
| **Dev** | `packages/protocol`, `apps/daemon` (join, approvals, MCP import, local MCP server, installers) | [docs/tasks/DEV.md](docs/tasks/DEV.md) |
| **Tarush** | `apps/relay`, deploy, real MCP servers on his laptop, `scripts/figma-export.sh` | [docs/tasks/TARUSH.md](docs/tasks/TARUSH.md) |
| **Abhi** | `apps/feed`, `hooks/`, `docs/DEMO.md`, pitch | [docs/tasks/ABHI.md](docs/tasks/ABHI.md) |

Agents: read `AGENTS.md` first. It tells you which files you may touch.

**Read in this order:**
1. `docs/PLAN.md` — pitch, architecture, build order, checkpoints, demo script
2. `docs/CONTRACT.md` — the wire protocol, MCP tools, CLI, and `team.json`. Everyone codes against this.
3. `docs/NEXT.md` — what is done, what is left, in priority order
4. Your task file: `docs/tasks/DEV.md`, `docs/tasks/TARUSH.md`, `docs/tasks/ABHI.md`
5. `docs/RESEARCH.md` — competitors and why we're different (read before the pitch); `docs/UX-RESEARCH.md` — in-tool approvals, the plugin path (in progress on `dev/plugin`)

## Layout
```
apps/relay      WebSocket relay + web front door + installers    — Tarush
apps/daemon     `mesh join` + local MCP server + approvals       — Dev
apps/feed       `mesh feed`, hooks, demo                          — Abhi
packages/protocol   shared TS types for every message/tool       — Dev writes, everyone imports
scripts/        figma-export.sh, tunnel-relay.sh                  — Tarush
docs/
```

## Rules that keep three agents from colliding
- Only edit your own `apps/<yours>` dir, `scripts/` (Tarush), and `docs/tasks/<YOU>.md`.
- `packages/protocol` and `docs/CONTRACT.md` change only by editing CONTRACT.md **and telling the other two**.
- Commit small, push often, `git pull --rebase` before push. Work on `main` (the plugin is the one exception, on `dev/plugin`).
- Each step in PLAN.md has an acceptance test. Don't move on until it passes.

## Quick start for teammates (one command, no clone)
Open the room link someone shared (`https://<relay>/r/<room>`) and run the command it shows, or:
```bash
# macOS / Linux
curl -fsSL https://<relay>/install.sh | bash -s -- <room> [--as <you>]
```
```powershell
# Windows PowerShell
& ([scriptblock]::Create((irm https://<relay>/install.ps1))) <room> [--as <you>]
```
Needs Node 20+ and nothing else: no clone, no pnpm, no npm account, no `team.json`. It downloads the single-file
daemon (`~/.mesh/mesh.mjs`, ~2.5 MB, served by the relay at `/mesh.mjs`) plus the hook emitter (`~/.mesh/emit.js`)
and runs `mesh join <room> --background`. That:
- picks your handle from `git config user.name` (override with `--as`);
- imports every MCP server in your Claude Code / Cursor configs and offers its tools to the room (permission **ask**);
- registers the mesh MCP server with Claude Code (`claude mcp add`, project scope), Codex (`codex mcp add`), and
  Cursor (`.cursor/mcp.json`, if a `.cursor` dir exists), and installs the Claude Code hooks into `.claude/settings.json`;
- stays running in the background. **Restart your agent session once** so it picks up the mesh tools (tool lists are cached).

Approvals pop up as a native OS dialog (macOS, Windows, Linux with zenity); no answer in 90 s = denied. Messages from
teammates arrive as a notification. Manage the daemon with `node ~/.mesh/mesh.mjs status | stop | log`; re-run the
one-liner to update. Run `join` without `--background` (or with `MESH_APPROVE=tty`) to approve in the terminal instead.

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
command, who's online, and a live feed; `/api/rooms` backs it. The same port serves the one-command join: `/install.sh`,
`/install.ps1`, `/mesh.mjs` (the daemon bundle) and `/emit.js`. The install scripts bake in the relay's public origin from
the request's `Host` / `X-Forwarded-Proto` headers, so they work behind ngrok and Railway without configuration.

**Now:** `./scripts/tunnel-relay.sh` on Dev's Mac (relay `:8090` + ngrok). The hostname has been stable for this ngrok
account across launches; `NGROK_DOMAIN=…` pins it. Free ngrok shows a one-time "visit site" interstitial in browsers;
the installers send `ngrok-skip-browser-warning: 1` and the daemon's WebSocket is unaffected. Always `pkill -x ngrok` first.

**Permanent (Railway, ~5 min, still to do):** New Project → Deploy from GitHub repo → pick `dg4329-hash/rho_hackathon`
(repo root; `railway.json` points at `apps/relay/Dockerfile`, which runs `pnpm -F daemon bundle` so the image serves
`/mesh.mjs`) → Settings → Networking → Generate Domain. The service reads `PORT`. Health check is `/health`. Vercel won't
work: the relay needs a long-lived WebSocket server.

## Verified (2026-09-12)
Mac↔Mac and Mac↔Windows (Git `bash.exe` for shell offers) over the public relay: install one-liner, shell request →
native dialog → output back, agent-to-agent messages both ways, Codex registration with codex-cli 0.154.

## Known limits
- Room name is the only auth.
- Codex and Cursor owners get messages pull-only (`inbox` tool); only Claude Code has the prompt hook that injects them.
- Windows PowerShell installer and the Windows dialog are untested on a real Windows box (the Mac↔Windows run used Git Bash).
- Codex tool calls not exercised (no login); OAuth remote MCPs (official Figma, Linear) can't be imported — use a shell offer.
- Agent sessions must restart once after registration (client tool-list caching). The Claude Code plugin path
  (`docs/UX-RESEARCH.md`, branch `dev/plugin`) is in progress and removes that.
