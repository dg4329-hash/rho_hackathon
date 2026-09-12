# Plan & Product Design (v2 — daemon + relay)

Supersedes v1 (hosted server + sidecars). Decisions here are final for the hackathon; see "Decisions" at the bottom.

## 1. Pitch

**One-liner:** *Borrow a teammate's machine, not their credentials.*

**Longer:** Every developer's agent is single-player: their tools, their keys, their terminal. But the team owns far more than any one person. `mesh` lets your agent ask a teammate's laptop to run something it can't (Figma export, Vercel deploy, a script only they have set up). The teammate approves with one keypress, the output streams back, and the whole room watches it happen. No cloud workspace, no shared vault, no migration. One `npx` per laptop.

**Judge Q: "Isn't this Superconductor / Cursor cloud / Zed Delta?"**
Those move your team into a hosted sandbox and pool credentials in a vault. We connect the laptops you already use, and every request needs the owner's yes. See `docs/RESEARCH.md` §3.

**Words to use:** peer-to-peer, local-first, approval, borrow, capability. **Words to avoid as the name:** "multiplayer" (crowded: Superconductor, AQ.dev, Zed Delta, Forklane). Fine as a hook line.

## 2. What it is (three processes, one you barely write)

```
 Dev's laptop                        Tarush's laptop
 ┌──────────────┐                    ┌──────────────┐
 │ Claude Code  │                    │ Cursor       │
 │   │ MCP (http localhost:7337)     │   │ MCP       │
 │ ┌─▼────────┐ │      WebSocket     │ ┌─▼────────┐ │
 │ │ daemon   │◄├────────┐  ┌────────┤►│ daemon   │ │
 │ │ team.json│ │        │  │        │ │ team.json│ │
 │ └──────────┘ │      ┌─▼──▼─┐      │ └────┬─────┘ │
 └──────────────┘      │relay │      │  y/n │ spawn │
                       │rooms │      │  figma-export│
                       └──▲───┘      └──────────────┘
                          │
                    Abhi: `mesh feed` (prints everything in the room)
```

1. **relay** (`apps/relay`) — one Node file. WebSocket server. Rooms keyed by string. Fan-out of every message to room members. Keeps last 200 events per room for late joiners. No auth: the room name is the secret, and we say so on stage.
2. **daemon** (`apps/daemon`) — `mesh join <room> --as <name>`. Connects to relay, announces the commands it *offers* from `team.json`, prints `<who> wants to run: <cmd>  [y/n]` on incoming requests, spawns the command with `child_process.spawn`, streams stdout/stderr back. Same process hosts a **local MCP server** (streamable HTTP on `localhost:7337`) exposing `list_teammates`, `ask_teammate`, `check_job`, `post_event`, `team_activity`.
3. **feed** (`apps/feed`) — `mesh feed <room>`. Joins the room read-only and pretty-prints every event: presence, prompts, tool calls, files touched, requests, approvals, streamed output. This is what's on the projector. Plus the Claude Code hook scripts that emit prompt/file events.

Not mirroring MCP servers. Not doing dynamic tool discovery. Every tool we care about is already a shell command or a 20-line script.

## 3. Build order (each step has an acceptance test; do not skip ahead)

| step | what | owner | acceptance test |
|---|---|---|---|
| 0 | `packages/protocol` types + CONTRACT.md | Dev | `pnpm -r typecheck` passes; others can import |
| 1 | Relay + two terminals echoing | Tarush | two `wscat` clients in room `x` see each other's `event` messages |
| 2 | Daemon: join, offers, y/n, spawn, stream | Dev | Tarush's daemon runs `echo hi` requested from Dev's daemon CLI (`mesh ask tarush "echo hi"`), stdout appears on both |
| 3 | MCP wrapper inside daemon | Dev | Claude Code on Dev's laptop calls `ask_teammate` and gets stdout back in the tool result |
| 4 | Broadcast + `mesh feed` | Abhi | third laptop running `mesh feed` shows request → approval → output live |
| 5 | Hooks: prompts, files touched | Abhi | typing a prompt in Claude Code on any laptop shows up in everyone's feed within 2s |
| 6 | Figma export script offered by Tarush | Tarush | `./scripts/figma-export.sh <fileKey> <nodeId>` prints a PNG path/URL locally |
| 7 | End-to-end demo rehearsal | all | the script in §5 runs clean twice in a row |
| S1 | `check_job` for long commands | Tarush | `ask_teammate` on `sleep 70` returns a jobId; `check_job` returns exit 0 |
| S2 | Deny path + `never` permission shown in demo | Dev | denied request returns a clear error to the agent |
| S3 | Web dashboard | Abhi | only if 4-7 are done and rehearsed |

Steps 1-2 are a working product with zero AI in it. If step 3 fights you, demo 1-2 plus the feed.

## 4. Work split

| person | subscription | owns | start with |
|---|---|---|---|
| **Dev** | Claude Max 20x | `packages/protocol`, `apps/daemon` (join, approvals, spawn, MCP server) | step 0, then 2, then 3 |
| **Tarush** | Cursor Pro (assumed; swap with Abhi if reversed) | `apps/relay`, deploy, `team.json` schema + validator, `scripts/figma-export.sh`, S1 | step 1 (should be done in ~1h), then 6, then S1 |
| **Abhi** | Claude Pro (assumed) | `apps/feed`, `hooks/`, `docs/DEMO.md`, pitch deck notes, S3 | step 4 against Tarush's relay with fake events, then 5 |

Detailed specs: `docs/tasks/DEV.md`, `docs/tasks/TARUSH.md`, `docs/tasks/ABHI.md`.

## 5. Demo script (target)

Three laptops. Projector shows Abhi's `mesh feed` full-screen; Dev's and Tarush's terminals on the side.

1. Abhi: "Every one of us has a coding agent. None of them can talk to each other. Dev's agent has no Figma. Tarush's does."
2. Dev types into Claude Code: *"Implement onboarding step 2 to match the Figma frame `Onboarding/Step 2`."*
3. Feed shows: `dev › prompt: Implement onboarding step 2…` then `dev › ask tarush: figma-export 8fA… 12:34  (why: need the frame to match)`.
4. Tarush's terminal: `dev wants to run: figma-export 8fA… 12:34  [y/n]` → **y**. Feed: `tarush › approved`. Output streams. Feed: `tarush › done (exit 0, 2.1s)`.
5. Dev's agent continues coding with the description/PNG. Dev did not stop. Tarush did not stop.
6. Abhi: "Now the part nobody else does." Dev's agent asks Tarush for `vercel --prod`. Tarush hits **n**. Feed: `tarush › denied`. Dev's agent says so and moves on. *"Credentials never moved. Every request needed a yes."*
7. Close: "One npx per laptop. No cloud workspace, no shared vault. Your team's machines become your agent's tools."

## 6. Decisions (don't re-open)

- **Daemon + dumb relay, not hosted server + sidecars.** Local MCP server per laptop; relay is fan-out only.
- **One tool that runs a command, not mirrored MCP servers / dynamic tool discovery.** Offers in `team.json` are strings the agent reads, not MCP tools it discovers.
- **Own job table in the daemon; no MCP Tasks extension.**
- **Room name is the only auth.** Say it out loud.
- **Feed shows observable events only** (prompts, tool calls, files, requests, output). Never hidden reasoning.
- **No web dashboard until S3.** The CLI feed is the UI.
- **Positioning:** "Borrow a teammate's machine, not their credentials." Not "multiplayer X".
