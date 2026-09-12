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
  | { type: 'request';  from; ts; id; to: string; why: string;
      command?: string;                                   // shell form
      tool?: string; args?: Record<string, unknown> }     // mcp form: tool = offer name '<server>.<tool>'
  | { type: 'decision'; from; ts; id; decision: 'approved'|'denied'|'auto'; reason?: string }   // 'auto' = permission was 'always'
  | { type: 'output';   from; ts; id; stream: 'stdout'|'stderr'; chunk: string }       // chunk ≤ 4 KB
  | { type: 'result';   from; ts; id; exitCode: number|null; durationMs: number; timedOut: boolean; tail: string }
      // command: tail = last 8 KB of combined output.  mcp: tail = tool result content flattened to text (≤ 8 KB), exitCode 0 ok / 1 isError
  | { type: 'event';    from; ts; kind: EventKind; summary: string; data?: Record<string, unknown> }
```

```ts
type EventKind = 'prompt' | 'tool_call' | 'file_touched' | 'status' | 'note' | 'message';  // message: data = { to: user|'all', text }
interface Offer {
  kind: 'command' | 'mcp';
  name: string;                 // command: 'figma.export'; mcp: '<server>.<tool>' e.g. 'supabase.run_sql'
  description: string;          // mcp: the server's own tool description, verbatim
  permission: 'always'|'ask'|'never';
  inputSchema?: object;         // mcp: the tool's JSON Schema, verbatim
  notes?: string;               // owner-written: when to use it, gotchas, examples
  server?: string;              // mcp: server name from the owner's config
}
```

Routing: everything is broadcast. Daemons ignore `request` frames whose `to` isn't them, that are older than 30 s, or whose `id` already has a `decision` in replayed history (replay guard). For a job it owns, a daemon only accepts `decision`/`output`/`result` frames whose `from` equals the request's `to`. `id` ties request → decision → output* → result.

## 2. `team.json` (lives in each person's repo checkout or `~/.mesh/team.json`)

```jsonc
{
  "user": "tarush",
  "room": "rho",
  "relay": "wss://mesh-relay.up.railway.app",
  "cwd": "/Users/tarush/code/our-app",       // shell commands run here
  "timeoutSeconds": 120,
  "allowArbitrary": "ask",                     // shell commands not matching an offer: 'ask' | 'never'

  // Import the owner's existing MCP servers as offers. This is the universal path.
  "import": {
    "fromClaudeCode": true,                    // ~/.claude.json mcpServers (global + this project) and ./.mcp.json
    "fromCursor": true,                        // ./.cursor/mcp.json and ~/.cursor/mcp.json
    "servers": ["*"],                          // or a list of server names to import
    "defaultPermission": "ask"                 // every imported tool starts here
  },
  // Per-tool overrides by glob on the offer name.
  "permissions": {
    "supabase.list_*": "always",
    "supabase.run_sql": "ask",
    "supabase.delete_*": "never",
    "github.*": "always"
  },
  // Owner notes shown to the requesting agent via describe_capability. Optional but high-value.
  "notes": {
    "supabase.run_sql": "Read-only queries only; our prod DB. Table names are snake_case; users live in public.profiles.",
    "figma.*": "File key for the app is 8fA2…; onboarding frames are under page 'Onboarding'."
  },

  // Shell offers, for things that aren't MCPs (or OAuth MCPs the daemon can't reach).
  "offers": [
    { "name": "figma.export", "command": "./scripts/figma-export.sh",
      "description": "Export a Figma frame to PNG + text outline. Usage: figma-export.sh <fileKey> <nodeId>",
      "permission": "ask" },
    { "name": "vercel.deploy", "command": "vercel", "description": "Deploy this repo. --prod only if asked.", "permission": "ask" }
  ]
}
```

**Import rule.** On `mesh join`, for each configured server: stdio servers are spawned by the daemon with the config's `command/args/env`; `http`/`sse` servers are connected without auth. Servers that fail (OAuth-only remotes like the official Figma MCP, missing binaries) are logged as `skipped: <reason>` and the owner is told to add a shell offer instead. Then `tools/list` → one offer per tool named `<server>.<tool>`, description and inputSchema verbatim, permission from `permissions` globs else `import.defaultPermission`, `notes` from the `notes` globs (first match).

**Shell matching rule.** Split `command` with shell-words; first token's basename vs each shell offer's `command` basename. No match → `allowArbitrary`. `never` → `decision: denied`. `always` → `decision: auto`. `ask` → prompt.

**Spawn rule (shell).** `spawn('/bin/sh', ['-c', command], { cwd, env: process.env, timeout })`. The approval prompt is the safety layer.

**Call rule (mcp).** Validate `args` against `inputSchema` (reject with a helpful `denied` reason on mismatch, before prompting). Prompt shows `tarush ← dev wants to call supabase.run_sql {"query": "select …"}  why: …  [y/n]`. On approve: `client.callTool({ name, arguments: args })`; flatten `content` (text parts joined, images as `[image]`, resources as their uri) into `result.tail`; `isError` → exitCode 1.

## 3. Local MCP server (inside `apps/daemon`, streamable HTTP at `http://localhost:7337/mcp`)

Register once per laptop:
```bash
claude mcp add --transport http mesh http://localhost:7337/mcp
# Cursor: .cursor/mcp.json → { "mcpServers": { "mesh": { "url": "http://localhost:7337/mcp" } } }
```

Tools (names, inputs, outputs). Descriptions matter: they are the only thing that teaches the model when to use us.

| tool | input | returns |
|---|---|---|
| `list_teammates` | `{}` | `{ me, members: [{ user, offers: [{ name, kind, permission, summary }] }] }` — `summary` = first 120 chars of description. One line per tool; keep it cheap. |
| `describe_capability` | `{ who: string, name: string }` | `{ name, kind, permission, description, inputSchema?, notes?, usage: string }` — `usage` is a rendered example call the model can copy |
| `ask_teammate` | `{ who: string, why: string, waitSeconds?: number (default 45, max 120), command?: string, tool?: string, args?: object }` — exactly one of `command` or `tool` | on completion: `{ jobId, status: 'completed', exitCode, output: string (tail ≤ 8 KB), durationMs }`; if still running at waitSeconds: `{ jobId, status: 'running' }`; if denied: `{ jobId, status: 'denied', reason }` |
| `check_job` | `{ jobId: string, waitSeconds?: number }` | same shape as `ask_teammate` |
| `post_event` | `{ kind: EventKind, summary: string, data? }` | `{ ok: true }` |
| `send_message` | `{ to: user \| 'all', text }` | `{ ok: true }` — emits `event` kind `message`; recipient daemon prints it live and queues it for `inbox` / the prompt hook |
| `inbox` | `{ unreadOnly?: true, sinceMinutes?: 120 }` | `{ messages: [{ id, ts, from, to, text, read }] }` — marks returned messages read when unreadOnly |
| `team_activity` | `{ sinceMinutes?: number (default 10) }` | `{ events: Array<{ ts, from, type, summary }> }` — flattened, human-readable, newest last, ≤ 100 |

Tool description text (copy into the server verbatim):

- `list_teammates`: "List teammates currently online and every tool or command each one can run for you on their machine (their MCP servers: Supabase, Figma, Linear, GitHub, etc., plus shell commands). Call this whenever you need a tool, credential, dataset, or environment you don't have, before telling the user you can't do something. Then call describe_capability on the specific tool before using it."
- `describe_capability`: "Full description, input schema, owner notes, and an example call for one teammate capability. Always call this before ask_teammate on a tool you haven't used in this session; the owner's notes contain project-specific details (IDs, table names, conventions) you cannot guess."
- `ask_teammate`: "Use a teammate's tool (tool + args, from describe_capability) or run a shell command on their machine (command). They see exactly what you're asking and your `why`, and must approve unless the capability is marked 'always'. Shell commands run in the owner's configured working directory with their environment. Returns { status, exitCode, output }: exitCode 0 = success, 1 = the tool reported an error, null = killed at the owner's timeout. If status is 'running', call check_job with the jobId. If 'denied', do not retry the same request; tell the user why."
- `check_job`: "Check on, or wait for, a job started by ask_teammate. waitSeconds blocks up to that long for completion (0 = return immediately). Same result shape as ask_teammate; exitCode null means it was killed at the owner's timeout."
- `team_activity`: "What teammates and their agents have done recently: prompts, tool calls, files touched, requests. Check before editing files others may be working on."

`ask_teammate` implementation: for `tool`, look up the offer in the last `presence` and validate `args` locally against `inputSchema` before emitting (fail fast with a readable error). Emit `request`, wait for the `decision`/`result` frames with that `id`, buffer `output` chunks into a job record `{ id, to, command, status, chunks[], exitCode, ... }` kept in memory (Map). `check_job` reads the same Map.

## 4. Hooks (`hooks/`, installed by Abhi's script into `.claude/settings.json`)

All hooks are `node hooks/emit.js <kind>` reading the hook's stdin JSON and POSTing to the daemon's local HTTP endpoint `POST http://localhost:7337/event` with `{ kind, summary, data }`. The daemon forwards it as an `event` frame.

| hook | kind | summary |
|---|---|---|
| `UserPromptSubmit` | `prompt` | first 140 chars of the prompt |
| `PostToolUse` (matcher `Edit\|Write\|MultiEdit`) | `file_touched` | relative path |
| `PostToolUse` (matcher `mcp__.*`) | `tool_call` | tool name |
| `Stop` | `status` | "idle" |

`UserPromptSubmit` also GETs `http://localhost:7337/inbox?unread=1` (unread messages, printed first) and `http://localhost:7337/activity?sinceMinutes=10` and prints it to stdout so the last 10 minutes of team activity land in the agent's context on every prompt.

## 5. Daemon local HTTP (besides `/mcp`)
- `POST /event` — see §4.
- `GET /inbox?unread=1` — same as `inbox`.
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
Auth beyond room name, OAuth, P2P/NAT traversal, exposing teammates' tools as first-class MCP tools in the requester's client (they are data returned by our static tools; this sidesteps client tool-list caching / list_changed), OAuth passthrough, file locking, web dashboard (S3 only), persistence beyond the relay's 200-frame ring buffer.
