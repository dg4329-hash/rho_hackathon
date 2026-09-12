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

**Public relay URL (Tarush):** provided at runtime — Tarush runs `./scripts/tunnel-relay.sh` (relay on `:8090` + ngrok) and it prints the session's `wss://<host>.ngrok-free.dev` URL, which goes into everyone's `team.json` `"relay"` (or `mesh join --relay …`) and the group chat. The URL changes every launch on the free ngrok plan, so it is deliberately not written here. Local dev: `ws://localhost:8080` (`pnpm -F relay start`). Railway (`scripts/deploy-relay.sh`, Dockerfile in `apps/relay/`) is blocked until someone has the Railway CLI + Docker; once deployed, replace this line with the permanent `wss://<host>`.

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
2. **daemon** (`apps/daemon`) — `mesh join <room> --as <name>`. Connects to relay. **Imports the owner's MCP servers as an MCP client** (spawns stdio servers from their config, `tools/list`), and announces every tool as an *offer* with its description and schema, plus any shell offers from `team.json`. On an incoming request it prints `<who> wants to call supabase.run_sql {…}  [y/n]`, then either calls the tool on the owner's server or spawns the shell command, and streams the result back. Same process hosts a **local MCP server** (streamable HTTP on `localhost:7337`) exposing six static tools: `list_teammates`, `describe_capability`, `ask_teammate`, `check_job`, `post_event`, `team_activity`.
3. **feed** (`apps/feed`) — `mesh feed <room>`. Joins the room read-only and pretty-prints every event: presence, prompts, tool calls, files touched, requests, approvals, streamed output. This is what's on the projector. Plus the Claude Code hook scripts that emit prompt/file events.

Teammates' tools never appear as first-class tools in the requester's client (that's where client caching and `list_changed` bugs live). They come back as *data* from our six static tools, two-level: one line per tool from `list_teammates`, full schema + owner notes from `describe_capability` only when the agent decides to use one.

## 3. Build order (each step has an acceptance test; do not skip ahead)

Status as of 2026-09-12 (all three branches merged to `main`; single-machine integration run: relay :8090 + daemons tarush/dev + feed + hooks + MCP client, every step rendered in the feed).

| step | what | owner | status | acceptance test |
|---|---|---|---|---|
| 0 | `packages/protocol` types + CONTRACT.md | Dev | done (exports `src/`, no build) | `pnpm -r typecheck` passes; others can import |
| 1 | Relay + two terminals echoing | Tarush | done (28/28 contract checks, soak OK) | two `wscat` clients in room `x` see each other's `event` messages |
| 2 | Daemon: join, offers, y/n, spawn, stream | Dev | done (daemon suite 20/20; live y/n verified) | Tarush's daemon runs `echo hi` requested from Dev's daemon CLI (`mesh ask tarush "echo hi"`), stdout appears on both |
| 3 | MCP wrapper inside daemon | Dev | done (MCP client → `ask_teammate` → stdout, verified) | Claude Code on Dev's laptop calls `ask_teammate` and gets stdout back in the tool result |
| 3b | Import owner's MCP servers as offers; `describe_capability`; mcp-form `ask_teammate` | Dev | done against fixture server; not yet against a real Supabase/Linear server | Tarush's daemon imports a stdio MCP (e.g. `@modelcontextprotocol/server-filesystem` or Supabase); Dev's Claude Code lists it, describes it, calls it, gets the tool result |
| 4 | Broadcast + `mesh feed` | Abhi | done (real relay + daemons, not mocks) | third laptop running `mesh feed` shows request → approval → output live |
| 5 | Hooks: prompts, files touched | Abhi | done (`emit.js prompt` → feed + `/activity`; `install.sh` verified) — not yet from a live Claude Code session | typing a prompt in Claude Code on any laptop shows up in everyone's feed within 2s |
| 6 | Real MCPs on Tarush's laptop for the demo (Supabase/Linear/GitHub stdio servers with keys) + Figma shell script as OAuth fallback | Tarush | partial: figma-export.sh written, needs FIGMA_TOKEN run; real MCP import untested | each imports cleanly on `mesh join`; `describe_capability` output reads well; figma-export.sh works |
| 7 | End-to-end demo rehearsal | all | not done (needs three laptops on the tunnel URL) | the script in §5 runs clean twice in a row |
| S1 | `check_job` for long commands | Tarush | daemon side done (`check_job` returns running/completed); relay soak OK | `ask_teammate` on `sleep 70` returns a jobId; `check_job` returns exit 0 |
| S2 | Deny path + `never` permission shown in demo | Dev | done (denied → `{status:"denied", reason}` verified) | denied request returns a clear error to the agent |
| S3 | Web dashboard | Abhi | not started | only if 4-7 are done and rehearsed |

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
- **Universal via MCP-client import, not per-integration code.** The daemon imports the owner's MCP servers and re-offers their tools with verbatim descriptions/schemas + owner notes. Teammates' tools are *data* from six static tools, never first-class tools in the requester's client. Shell offers cover non-MCP and OAuth-only cases.
- **Own job table in the daemon; no MCP Tasks extension.**
- **Room name is the only auth.** Say it out loud.
- **Feed shows observable events only** (prompts, tool calls, files, requests, output). Never hidden reasoning.
- **No web dashboard until S3.** The CLI feed is the UI.
- **Positioning:** "Borrow a teammate's machine, not their credentials." Not "multiplayer X".
