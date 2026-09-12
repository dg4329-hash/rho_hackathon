# Contract (v2) — wire protocol, MCP tools, team.json

Everything here is what the three apps agree on. `packages/protocol/src/index.ts` is the TypeScript form of this file and is the source of truth if they ever disagree. Change either only by editing both and telling the other two people.

## 0. Conventions
- All messages are JSON over WebSocket, one object per frame.
- `user` is a short lowercase handle: `dev`, `tarush`, `abhi`.
- `room` is any string; it is the only secret.
- ids are `crypto.randomUUID()`.
- timestamps `ts` are ISO strings, set by the sender.

## 1. Relay wire protocol (`apps/relay` ⇄ `apps/daemon` / `apps/feed`)

Connect: `ws://<relay>/?room=<room>&user=<user>&role=daemon|feed`

The relay is dumb: it validates `room`/`user` on connect, stamps nothing, and forwards every frame it receives to **every other** connection in the room. It also keeps the last 200 frames per room and replays them to a new connection on join (as-is, in order). Two frames the relay itself emits:

```ts
{ type: 'presence', members: Array<{ user: string; role: 'daemon'|'feed'; offers: Offer[] }> }  // on any join/leave
{ type: 'error', message: string }                                                                 // bad query params
```

Frames clients send (all carry `from: user` and `ts`):

```ts
type Frame =
  | { type: 'hello';    from; ts; role: 'daemon'|'feed'; offers: Offer[] }             // first frame after connect; relay caches offers for presence
  | { type: 'request';  from; ts; id; to: string; command: string; why: string; offer?: string }
  | { type: 'decision'; from; ts; id; decision: 'approved'|'denied'|'auto'; reason?: string }   // 'auto' = permission was 'always'
  | { type: 'output';   from; ts; id; stream: 'stdout'|'stderr'; chunk: string }       // chunk ≤ 4 KB
  | { type: 'result';   from; ts; id; exitCode: number|null; durationMs: number; timedOut: boolean; tail: string } // tail = last 8 KB of combined output
  | { type: 'event';    from; ts; kind: EventKind; summary: string; data?: Record<string, unknown> }
```

```ts
type EventKind = 'prompt' | 'tool_call' | 'file_touched' | 'status' | 'note';
interface Offer { name: string; description: string; permission: 'always'|'ask'|'never' }
```

Routing: everything is broadcast. Daemons ignore `request` frames whose `to` isn't them. `id` ties request → decision → output* → result.

## 2. `team.json` (lives in each person's repo checkout or `~/.mesh/team.json`)

```jsonc
{
  "user": "tarush",
  "room": "rho",
  "relay": "wss://mesh-relay.up.railway.app",
  "cwd": "/Users/tarush/code/our-app",       // commands run here
  "timeoutSeconds": 120,                       // hard kill after this
  "allowArbitrary": "ask",                     // 'ask' | 'never' — commands not matching an offer
  "offers": [
    { "name": "figma.export", "command": "./scripts/figma-export.sh",
      "description": "Export a Figma frame to PNG. Usage: figma-export.sh <fileKey> <nodeId>. Prints the PNG path and a text description of the frame.",
      "permission": "ask" },
    { "name": "gh", "command": "gh", "description": "GitHub CLI, read-only usage preferred", "permission": "always" },
    { "name": "vercel.deploy", "command": "vercel", "description": "Deploy this repo. Use --prod only if asked.", "permission": "ask" },
    { "name": "rm", "command": "rm", "description": "", "permission": "never" }
  ]
}
```

Matching rule in the daemon: split the requested `command` with shell-words; the first token (basename) is compared to each offer's `command` basename. First match wins → that offer's permission. No match → `allowArbitrary`. `never` → immediate `decision: denied, reason: 'not offered'`. `always` → `decision: auto` and run. `ask` → prompt.

Spawn rule: `spawn('/bin/sh', ['-c', command], { cwd, env: process.env, timeout })`. Yes, `sh -c`. The approval prompt is the safety layer; the allowlist is convenience. Say this on stage rather than pretending otherwise.

## 3. Local MCP server (inside `apps/daemon`, streamable HTTP at `http://localhost:7337/mcp`)

Register once per laptop:
```bash
claude mcp add --transport http mesh http://localhost:7337/mcp
# Cursor: .cursor/mcp.json → { "mcpServers": { "mesh": { "url": "http://localhost:7337/mcp" } } }
```

Tools (names, inputs, outputs). Descriptions matter: they are the only thing that teaches the model when to use us.

| tool | input | returns |
|---|---|---|
| `list_teammates` | `{}` | `{ me: string, members: [{ user, online: true, offers: Offer[] }] }` |
| `ask_teammate` | `{ who: string, command: string, why: string, waitSeconds?: number (default 45, max 120) }` | on completion: `{ jobId, status: 'completed', exitCode, output: string (tail ≤ 8 KB), durationMs }`; if still running at waitSeconds: `{ jobId, status: 'running' }`; if denied: `{ jobId, status: 'denied', reason }` |
| `check_job` | `{ jobId: string, waitSeconds?: number }` | same shape as `ask_teammate` |
| `post_event` | `{ kind: EventKind, summary: string, data? }` | `{ ok: true }` |
| `team_activity` | `{ sinceMinutes?: number (default 10) }` | `{ events: Array<{ ts, from, type, summary }> }` — flattened, human-readable, newest last, ≤ 100 |

Tool description text (copy into the server verbatim):

- `list_teammates`: "List teammates currently online and the commands each one offers to run on their machine. Call this when you need a tool, credential, or environment you don't have (e.g. Figma, Vercel, a deploy key). Offers include usage notes; follow them exactly."
- `ask_teammate`: "Run a shell command on a teammate's machine. They will see the command and your `why`, and must approve it (unless the offer is marked 'always'). Use the exact command syntax from their offer description. Returns stdout/stderr. If status is 'running', call check_job with the jobId. If 'denied', do not retry the same command; tell the user."
- `team_activity`: "What teammates and their agents have done recently: prompts, tool calls, files touched, requests. Check before editing files others may be working on."

`ask_teammate` implementation: emit `request`, wait for the `decision`/`result` frames with that `id`, buffer `output` chunks into a job record `{ id, to, command, status, chunks[], exitCode, ... }` kept in memory (Map). `check_job` reads the same Map.

## 4. Hooks (`hooks/`, installed by Abhi's script into `.claude/settings.json`)

All hooks are `node hooks/emit.js <kind>` reading the hook's stdin JSON and POSTing to the daemon's local HTTP endpoint `POST http://localhost:7337/event` with `{ kind, summary, data }`. The daemon forwards it as an `event` frame.

| hook | kind | summary |
|---|---|---|
| `UserPromptSubmit` | `prompt` | first 140 chars of the prompt |
| `PostToolUse` (matcher `Edit\|Write\|MultiEdit`) | `file_touched` | relative path |
| `PostToolUse` (matcher `mcp__.*`) | `tool_call` | tool name |
| `Stop` | `status` | "idle" |

`UserPromptSubmit` also GETs `http://localhost:7337/activity?sinceMinutes=10` and prints it to stdout so the last 10 minutes of team activity land in the agent's context on every prompt.

## 5. Daemon local HTTP (besides `/mcp`)
- `POST /event` — see §4.
- `GET /activity?sinceMinutes=` — same as `team_activity`.
- `GET /health` — `{ user, room, relay: 'connected'|'disconnected', members: n }`.

## 6. CLI surface
```
mesh join <room> --as <user> [--relay wss://…] [--config ./team.json] [--port 7337]
mesh ask <who> "<command>" [--why "…"]        # human-driven request, for steps 2 and demos without an agent
mesh feed <room> [--relay …]                   # Abhi's app
mesh init                                       # writes a starter team.json
```

## 7. Explicit non-goals
Auth beyond room name, OAuth, P2P/NAT traversal, mirroring MCP servers, dynamic tool discovery, file locking, web dashboard (S3 only), persistence beyond the relay's 200-frame ring buffer.
