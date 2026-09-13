# Plan & Product Design (v2 — daemon + relay)

Supersedes v1 (hosted server + sidecars). Decisions here are final for the hackathon; see "Decisions" at the bottom.

## 1. Pitch

**One-liner:** *Borrow a teammate's machine, not their credentials.*

**Longer:** Every developer's agent is single-player: their tools, their keys, their terminal. But the team owns far more than any one person. `mesh` reads the MCP servers each teammate already has configured (Supabase, Figma, Linear, GitHub, Vercel, anything) and lets any teammate's agent use them, through the owner's machine, with the owner's approval. The requesting agent gets the real tool descriptions, schemas, and the owner's notes, so it uses them as well as its own. The output streams back and the whole room watches it happen. No cloud workspace, no shared vault, no migration. One `npx` per laptop.

**Universal by construction:** we don't integrate with Figma or Supabase. We import whatever MCP servers are in `~/.claude.json` / `.cursor/mcp.json` and re-offer their tools. Anything not an MCP (or an OAuth-only remote MCP) is offered as a shell command instead.

**Judge Q: "Isn't this Superconductor / Cursor cloud / Zed Delta?"**
Those move your team into a hosted sandbox and pool credentials in a vault. We connect the laptops you already use, and every request needs the owner's yes. See `docs/RESEARCH.md` §3.

**Words to use:** peer-to-peer, local-first, approval, borrow, capability. **Words to avoid as the name:** "multiplayer" (crowded: Superconductor, AQ.dev, Zed Delta, Forklane). Fine as a hook line.

## 2. What it is (three processes, one you barely write)

**Public relay URL:** Dev runs `./scripts/tunnel-relay.sh` on his Mac (bundles the daemon, relay on `:8090` + ngrok) and it prints `https://<host>.ngrok-free.dev` plus the install one-liners; the hostname has been stable for this ngrok account (`NGROK_DOMAIN=…` pins it). Teammates join from the room page `https://<host>/r/<room>`; nothing needs to be pasted into a config. Local dev: `ws://localhost:8090`. Railway (`railway.json` → `apps/relay/Dockerfile`, deploy from GitHub in the dashboard, no CLI needed) is still to do; once deployed, replace this line with the permanent host.

```
 Dev's laptop                                Tarush's laptop
 ┌────────────────────┐                      ┌────────────────────┐
 │ Claude Code        │                      │ Cursor / Codex     │
 │   │ MCP http://localhost:7337/mcp         │   │ MCP             │
 │ ┌─▼──────────────┐ │      WebSocket       │ ┌─▼──────────────┐ │
 │ │ daemon         │◄├─────────┐  ┌─────────┤►│ daemon         │ │
 │ │ (~/.mesh)      │ │         │  │         │ │ imported MCPs  │ │
 │ └────────────────┘ │       ┌─▼──▼─┐       │ └───────┬────────┘ │
 └────────────────────┘       │relay │       │  OS dialog │ spawn │
                              │rooms │       │  Approve   │ figma-export
                              │ /r/… │       └────────────────────┘
                              └──▲───┘
                                 │
                    Abhi: `mesh feed` + the room page (everything in the room)
```

1. **relay** (`apps/relay`) — one Node process. WebSocket server with rooms, fan-out of every frame, last 200 frames replayed to late joiners. Same port serves the web front door (`/`, `/r/<room>` room page with the join command, who's online, live feed) the installers (`/install.sh`, `/install.ps1`, downloadable `/join.cmd` / `/join.command`, `/mesh.mjs`, `/emit.js`, `/plugin.tgz`) and the pop-out approval **overlay** (`/overlay`, shipping tonight). No auth: the room name is the secret, and we say so on stage.
2. **daemon** (`apps/daemon`) — one command per laptop: `curl -fsSL https://<relay>/install.sh | bash -s -- <room>` (PowerShell equivalent on Windows) downloads a single 2.5 MB bundle to `~/.mesh` and runs `mesh join <room> --background`. Zero-config: handle from `git user.name`, no `team.json` needed (honoured if present). It **imports the owner's MCP servers as an MCP client** (Claude Code / Cursor configs, `tools/list`) and announces every tool as an *offer* with its description and schema (permission `ask`), plus any shell offers. It **registers itself**: Claude Code gets the mesh **plugin** auto-installed from `<relay>/plugin.tgz` (MCP server + hooks + in-session watcher; `claude mcp add` + hooks as fallback), Codex `codex mcp add`, Cursor `.cursor/mcp.json`; one session restart later the agent has the tools. On an incoming request the owner answers in the **overlay** (always-on-top window popped out of the room page, shipping tonight; 120 s → fallback) or, if it isn't open, a **native OS dialog** (`dev wants to run: figma-export … [Deny] [Approve]`, 90 s → denied; terminal `[y/n]` when there's no dialog); Claude Code owners can also press **1** in their session. Then the daemon calls the tool on the owner's server or spawns the shell command and streams the result back. Messages between agents land in the overlay, as notifications (Windows: message box), live in Claude Code, and via `inbox` / `wait_for_events`. `mesh status` / `stop` / `log` / `watch` manage the background daemon. Same process hosts a **local MCP server** (streamable HTTP on `localhost:7337`) exposing ten static tools: `list_teammates`, `describe_capability`, `ask_teammate`, `check_job`, `post_event`, `team_activity`, `send_message`, `inbox`, `approve_request`, `wait_for_events`.
3. **feed** (`apps/feed`) — `mesh feed <room>`. Joins the room read-only and pretty-prints every event: presence, prompts, tool calls, files touched, requests, approvals, streamed output, messages. This is what's on the projector (the relay's room page shows the same in a browser). Plus the Claude Code hook scripts (`hooks/emit.js`, installed by `mesh join`) that emit prompt/file events and inject unread messages + team activity into every prompt.

Teammates' tools never appear as first-class tools in the requester's client (that's where client caching and `list_changed` bugs live). They come back as *data* from our static tools, two-level: one line per tool from `list_teammates`, full schema + owner notes from `describe_capability` only when the agent decides to use one.

On main: the Claude Code plugin (`docs/PLUGIN.md`) delivers requests and messages into the owner's Claude Code session; `mesh join` installs it. Shipping tonight: the overlay (`docs/OVERLAY-API.md`) — the universal, non-interrupting approval surface for every coding tool — and `wait_for_events`, so a Codex/Cursor agent can be told *"watch mesh for the next 10 minutes"*.

## 3. Build order (each step has an acceptance test; do not skip ahead)

Status as of 2026-09-12 (night, `main` @ `c5e4cdc`): cross-laptop proven over the public relay, Mac↔Mac and Mac↔Windows (real Windows: PowerShell one-liner, dialog, message box), one-command install, plugin auto-install, agent-to-agent messages both ways. Overlay + `wait_for_events` shipping tonight.

| step | what | owner | status | acceptance test |
|---|---|---|---|---|
| 0 | `packages/protocol` types + CONTRACT.md | Dev | done (10 tools, `message` event, `PendingRequest`) | `pnpm -r typecheck` passes; others can import |
| 1 | Relay + two terminals echoing | Tarush | done (28/28 contract checks, soak OK); + web front door, room page, installers; public via ngrok on Dev's Mac; **Railway not done** | two `wscat` clients in room `x` see each other's `event` messages |
| 2 | Daemon: join, offers, approve, spawn, stream | Dev | done; **cross-laptop with two humans, Mac↔Mac and Mac↔Windows** (Git `bash.exe`); native dialog verified on macOS and on a real Windows box (MessageBox); chained commands never inherit `always` | Tarush's daemon runs `echo hi` requested from Dev's laptop, stdout appears on both |
| 2b | One-command install, zero-config join, auto-registration, background mode | Dev | done (`install.sh` verified macOS + Git Bash; `claude mcp add`, hooks, `codex mcp add` with codex-cli 0.154, `.cursor/mcp.json`; PowerShell installer verified on real Windows; `.cmd`/`.command` downloads; installers stop + restart a running daemon; Claude Code plugin auto-installed from `/plugin.tgz`); one restart (or `/reload-plugins`) still required | fresh laptop: one-liner → `mesh status` shows running → agent lists mesh tools after restart |
| 3 | Local MCP server in the daemon | Dev | done; called from live Claude Code; **Codex tool calls not exercised (no login)** | Claude Code on Dev's laptop calls `ask_teammate` and gets stdout back in the tool result |
| 3b | Import owner's MCP servers as offers; `describe_capability`; mcp-form `ask_teammate` | Dev | done (real Claude Code / Cursor configs imported by default; self-import excluded); **no keyed server (Supabase/GitHub) borrowed yet**; OAuth remotes can't be imported | Dev's Claude Code lists, describes, calls a tool imported on Tarush's laptop, gets the tool result |
| 3c | Agent-to-agent messages (`send_message` / `inbox`, prompt-hook injection, notifications) | Dev | done cross-laptop both ways; live in Claude Code via the plugin watcher; Codex/Cursor via `inbox` / `wait_for_events` (tonight); overlay reply box (tonight) | message sent from Dev's agent shows in Tarush's terminal + notification, and in his agent's next prompt / `inbox` |
| 4 | Broadcast + `mesh feed` (+ room page) | Abhi | done (real relay + daemons); **not yet on the projector** | third laptop running `mesh feed` shows request → approval → output live |
| 5 | Hooks: prompts, files touched | Abhi | done; installed automatically by `mesh join`; **prompt → feed not yet timed from live Claude Code on two laptops** | typing a prompt in Claude Code on any laptop shows up in everyone's feed within 2 s |
| 6 | Real MCPs on Tarush's laptop + Figma shell script | Tarush | partial: `figma-export.sh` supports name lookup (`"Onboarding/Step 2"`, `FIGMA_FILE_KEY`), dry-verified against a mock; **no live `FIGMA_TOKEN` run; no keyed MCP server configured** | each imports cleanly on `mesh join`; `describe_capability` reads well; `figma-export.sh "<frame>"` returns in < 5 s |
| 7 | End-to-end demo rehearsal | all | not done | the script in §5 runs clean twice in a row |
| S1 | `check_job` for long commands | Tarush | done (`sleep 70` → running → `check_job` → done; relay soak OK) | `ask_teammate` on `sleep 70` returns a jobId; `check_job` returns exit 0 |
| S2 | Deny path + `never` permission shown in demo | Dev | done in tests and once by hand; **never on stage** | denied request returns a clear error to the agent |
| S3 | Web dashboard | Abhi | superseded by the relay's room page (`/r/<room>`) | — |
| P | Claude Code plugin (in-session approvals + messages) | Dev | on main, auto-installed by `mesh join`; headless flow verified; interactive 3/3 pending | `mesh join` → `/mcp` lists the plugin's tools; a teammate's request appears in the session, **1** approves |
| O | Overlay: pop-out approval window from the room page | Dev | **shipping tonight** — the demo's approval surface | `Pop out overlay` → request card → **Approve** → output back; close it → OS dialog fallback |
| W | `wait_for_events` for Codex/Cursor | Dev | **shipping tonight** | *"Codex, watch mesh for the next 10 minutes"* → agent reports the next message/request without approving |

Steps 1-2 are a working product with zero AI in it. If step 3 fights you, demo 1-2 plus the feed.

## 4. Demo script (target)

Three laptops. Projector shows Abhi's `mesh feed` full-screen (or the room page); Dev's and Tarush's screens on the side. Full run of show in `docs/DEMO.md`.

0. (Optional opener, 20 s) Tarush's laptop is fresh: he pastes the one-liner from the room page, a dialog-capable daemon is up in the background, his MCP servers appear in presence.
1. Abhi: "Every one of us has a coding agent. None of them can talk to each other. Dev's agent has no Figma. Tarush's does."
2. Dev types into Claude Code: *"Implement onboarding step 2 to match the Figma frame `Onboarding/Step 2`."*
3. Feed shows: `dev 💬 prompt: Implement onboarding step 2…` then `dev ──▶ tarush $ figma-export.sh "Onboarding/Step 2"  (why: need the frame to match)`.
4. Tarush's screen: the overlay card `dev wants to run figma-export.sh "Onboarding/Step 2" · why: …  [Deny] [Approve]` (OS dialog if the overlay isn't open) → **Approve**. Feed: `tarush ✅ approved`. Output streams. Feed: `tarush ✔ exit 0 in 2.1s`.
5. Dev's agent continues coding from the outline. Dev did not stop. Tarush did not stop.
6. Abhi: "Now the part nobody else does." Dev's agent asks Tarush for `vercel --prod`. Tarush clicks **Deny**. Feed: `tarush ❌ denied (owner declined)`. Dev's agent says so and moves on. *"Credentials never moved. Every request needed a yes."*
7. (If time) Dev's agent `send_message`s Tarush's agent what it changed; it shows in Tarush's overlay with a reply box and — because he told Codex *"watch mesh for the next 10 minutes"* — his agent reports it (`wait_for_events`).
8. Close: "One command per laptop, nothing to install. No cloud workspace, no shared vault, no new IDE. Your team's machines become your agent's tools."

## 5. Decisions (don't re-open)

- **Daemon + dumb relay, not hosted server + sidecars.** Local MCP server per laptop; relay is fan-out only.
- **Universal via MCP-client import, not per-integration code.** The daemon imports the owner's MCP servers and re-offers their tools with verbatim descriptions/schemas + owner notes. Teammates' tools are *data* from ten static tools, never first-class tools in the requester's client. Shell offers cover non-MCP and OAuth-only cases.
- **Own job table in the daemon; no MCP Tasks extension.**
- **Room name is the only auth.** Say it out loud.
- **Feed shows observable events only** (prompts, tool calls, files, requests, output). Never hidden reasoning.
- **No web dashboard.** The CLI feed, the room page and the pop-out overlay are the UI.
- **Positioning:** "Borrow a teammate's machine, not their credentials." Not "multiplayer X".
