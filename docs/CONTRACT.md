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

HTTP on the same port: `GET /health` → `{ rooms, connections }`; web front door `GET /` (start a session, plain-words explanation), `POST /api/rooms` → `{ room }`, `GET /api/rooms/:room?since=<n>` → `{ room, members, watchers, events, next }`, `GET /r/:room` (beginner room page: pick a name, one-liner with room filled in, downloadable installer, "restart once" step with a self-check, who's online, live feed, **Pop out overlay** button), `GET /overlay?room=&port=` (the overlay page, shipping tonight; `docs/OVERLAY-API.md`); installers `GET /install.sh`, `GET /install.ps1` (public origin baked in from `Host` / `X-Forwarded-Proto`; both stop a running daemon before re-joining, so re-running updates + restarts), `GET /join.cmd?room=&as=` / `GET /join.command?room=&as=` (double-clickable wrappers around the same installers), `GET /mesh.mjs` (daemon bundle), `GET /emit.js` (hook emitter), `GET /plugin.tgz` (Claude Code plugin, built from `plugin/` + `.claude-plugin/` at relay start). Rooms match `^[a-z0-9][a-z0-9-]{1,40}$`.

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

## 2. `team.json` (optional; `./team.json` or `~/.mesh/team.json` or `--config`)

**Zero-config rule.** `mesh join` works with no file. Defaults: `user` = first word of `git config user.name` (else OS username), lowercased; `relay` from the room link / `--relay` / `MESH_RELAY`; `cwd` = where the command ran; `import` = everything from Claude Code + Cursor configs at permission `ask`; no shell offers; `allowArbitrary: ask`; `codexWake: false`. A `team.json`, if present, is honoured and flags win over it.

`codexWake: true` opts this owner into a separate background `codex exec` run for each fresh direct or broadcast teammate message/file. The run inherits Codex's saved login, MCP configuration (including `mesh`), project instructions, and rules. It uses a workspace-write sandbox with Codex auto-review, never authorizes a mesh `ask` approval on the owner’s behalf, and returns a final native alert. Messages are handled serially; IDs are recorded in `~/.mesh/codex-wake-seen.json` so relay replay/reconnect does not repeat work. Messages older than five minutes are not started. This is off by default because teammates can cause local work and model usage. `--no-codex-wake` disables it for that join.

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
    { "name": "vercel.deploy", "command": "vercel", "description": "Deploy this repo. --prod only if asked.", "permission": "ask" },
    // FIXED command lines (whitespace in `command`): the requester asks by name, the owner's exact line runs. Safe as `always`.
    { "name": "git.status", "command": "git status --short", "description": "Working-tree status of the app repo.", "permission": "always" },
    { "name": "git.diff",   "command": "git diff HEAD",      "description": "Uncommitted diff of the app repo.",   "permission": "always" }
  ]
}
```

**Import rule.** On `mesh join`, for each configured server (the daemon's own `mesh` entry and any `http://localhost:*/mcp` URL are skipped so it never imports itself): stdio servers are spawned by the daemon with the config's `command/args/env`; `http`/`sse` servers are connected without auth. Servers that fail (OAuth-only remotes like the official Figma MCP, missing binaries) are logged as `skipped: <reason>` and the owner is told to add a shell offer instead. Then `tools/list` → one offer per tool named `<server>.<tool>`, description and inputSchema verbatim, permission from `permissions` globs else `import.defaultPermission`, `notes` from the `notes` globs (first match).

**Default git visibility.** When the daemon's cwd is inside a git repo, it adds four fixed, read-only offers with permission `always` unless the owner already defines the name: `git.status` (`git status --short --branch`), `git.diff` (`git diff HEAD`), `git.log` (`git log --oneline -20`), `git.branch` (`git rev-parse --abbrev-ref HEAD`). Teammates' agents call them by name. Opt out with `"gitOffers": false` in team.json or `mesh join --no-git-offers`.

**Shell matching rule.** Two kinds of shell offer, decided by the offer's `command`:
- **Fixed offer** — `command` contains whitespace (`git diff HEAD`, `echo a | tr a b`). It is the owner's complete command line. A request matches it only when the request, normalized (trim, collapse runs of whitespace), equals the offer's `command` exactly **or** equals the offer's `name` (so agents call `ask_teammate({ who, command: "git.diff" })`). Nothing else matches: not a prefix, not extra flags (`git diff HEAD --stat` → arbitrary). The daemon runs the **offer's** line verbatim (pipes and all): fixed offers are never compound-escalated, so `always` on them is safe. Fixed offers are checked first and advertised with `fixed: true` in `presence`/`list_teammates`.
- **Single-token offer** — `command` is one program (`git`, `./scripts/figma-export.sh`). Split the request with shell-words; first token's basename vs the offer's `command` basename; the rest of the request is passed through to the owner's program. A bare `git` offer with `always` therefore auto-approves *any* git command — the owner's choice; prefer fixed offers for `always`. **Compound requests** (any `;`, `&&`, `||`, `|`, redirection, backticks, `$( )`, newline, or unparseable input) never inherit a single-token offer's `always`: they are treated as `ask` (or `never` when `allowArbitrary` is `never`).

No match → `allowArbitrary`. `never` → `decision: denied`. `always` → `decision: auto`. `ask` → prompt. An offer's `never` stays `never`.

**Spawn rule (shell).** POSIX: `spawn('/bin/sh', ['-c', command], { cwd, env: process.env, detached })`, process group killed at `timeoutSeconds`. Windows: Git's `bash.exe` if installed (so offers written for `sh` work), else `cmd.exe`. The approval prompt is the safety layer.

**Approval rule.** Prompts are serialized, one at a time. Order: (0) **watcher** — if anything long-polled `GET /pending` in the last 60 s (the room-page overlay, or `mesh watch` run by the Claude Code plugin monitor), the request is parked in the pending queue and answered via `POST /decide` (overlay buttons) or the `approve_request` tool (Claude Code's own permission prompt); no answer in 120 s, or the watcher stops polling → fall through; (1) native OS dialog — macOS `osascript display dialog`, Windows PowerShell `MessageBox`, Linux `zenity` — buttons Deny/Approve, 90 s timeout → `denied` with reason `owner did not answer in 90 s`; (2) if no dialog is possible (or `MESH_APPROVE=tty`), a terminal `[y/n]` single keypress; (3) no TTY either → `denied`, reason `no tty and no dialog available`. `MESH_APPROVE=watcher|dialog|tty` forces one surface. Deny from a dialog is `owner declined` (no typed reason); the overlay and `approve_request` may carry a short `reason`. Incoming `message` events trigger a native notification (macOS `display notification`, Linux `notify-send`, Windows a small always-on-top message box; `MESH_TOAST=1` for a toast), skipped for replayed history older than 5 min, and wake every `/pending` long-poller (overlay, watcher, `wait_for_events`).

**Call rule (mcp).** Validate `args` against `inputSchema` (reject with a helpful `denied` reason on mismatch, before prompting). Prompt shows `tarush ← dev wants to call supabase.run_sql {"query": "select …"}  why: …  [y/n]`. On approve: `client.callTool({ name, arguments: args })`; flatten `content` (text parts joined, images as `[image]`, resources as their uri) into `result.tail`; `isError` → exitCode 1.

## 3. Local MCP server (inside `apps/daemon`, streamable HTTP at `http://localhost:7337/mcp`)

Registration is automatic on `mesh join` (best-effort, one line each, never blocks the join; `--no-register` skips it):

| agent | how | when |
|---|---|---|
| Claude Code plugin | download `<relay>/plugin.tgz` → `~/.mesh/marketplace`, then `claude plugin marketplace add` + `claude plugin install mesh@mesh --scope project` in `cwd`. Brings the MCP server, the §4 hooks and the `mesh watch` monitor; the next two rows are then skipped (`the mesh plugin provides …`) | `claude` on PATH |
| Claude Code | `claude mcp add --transport http mesh http://localhost:<port>/mcp` in `cwd` (project scope; replaces a stale `mesh` entry) | `claude` on PATH and no plugin |
| Claude Code hooks | merged into `<cwd>/.claude/settings.json` (§4) | `claude` on PATH, an `emit.js` found, no plugin |
| Claude Code ask rule | `permissions.ask` for `approve_request` (both tool-name forms) in `<cwd>/.claude/settings.json` | `claude` on PATH |
| Codex | `codex mcp add mesh --url http://localhost:<port>/mcp` (verified codex-cli 0.154); else `[mcp_servers.mesh] url = …` written to `~/.codex/config.toml` | `codex` on PATH or `~/.codex` exists, or `--codex` |
| Cursor | `mesh` merged into `<cwd>/.cursor/mcp.json` `{ "mcpServers": { "mesh": { "url": … } } }` | `<cwd>/.cursor` or `~/.cursor` exists, or `--cursor` |

Every client caches its tool list: the agent session must be restarted once after registration (Claude Code: or `/reload-plugins`). Manual equivalent: `claude mcp add --transport http mesh http://localhost:7337/mcp`.

Twelve tools (names, inputs, outputs). Descriptions matter: they are the only thing that teaches the model when to use us.

| tool | input | returns |
|---|---|---|
| `list_teammates` | `{}` | `{ me, members: [{ user, offers: [{ name, kind, permission, summary, fixed?, usage? }] }] }` — `summary` = first 120 chars of description. Fixed shell offers (§2) carry `fixed: true, usage: 'command: "<name>"'`. One line per tool; keep it cheap. |
| `describe_capability` | `{ who: string, name: string }` | `{ name, kind, permission, description, inputSchema?, notes?, fixed?, usage: string }` — `usage` is a rendered example call the model can copy; for a fixed offer it is `ask_teammate({ who, command: "<name>", why })` |
| `ask_teammate` | `{ who: string, why: string, waitSeconds?: number (default 45, max 55), command?: string, tool?: string, args?: object }` — exactly one of `command` or `tool` | on completion: `{ jobId, status: 'completed', exitCode, output: string (tail ≤ 8 KB), durationMs }`; if still running at waitSeconds: `{ jobId, status: 'running' }`; if denied: `{ jobId, status: 'denied', reason }` |
| `check_job` | `{ jobId: string, waitSeconds?: number }` | same shape as `ask_teammate` |
| `post_event` | `{ kind: EventKind, summary: string, data? }` | `{ ok: true }` |
| `send_message` | `{ to: user \| 'all', text }` | `{ ok: true }` — emits `event` kind `message`; recipient daemon prints it live and queues it for `inbox` / the prompt hook |
| `inbox` | `{ unreadOnly?: true, sinceMinutes?: 120 }` | `{ messages: [{ id, ts, from, to, text, read }] }` — marks returned messages read when unreadOnly |
| `send_file` | `{ to: user \| 'all', path: string, note?: string }` | uploads a file under the owner project or `~/.mesh`, emits a `file` event, and returns its artifact descriptor; see `docs/FILES-API.md` |
| `fetch_artifact` | `{ url?: string, id?: string, saveAs?: string }` | downloads into `./mesh-artifacts/<sender>/`; small images/text are also returned inline; see `docs/FILES-API.md` |
| `team_activity` | `{ sinceMinutes?: number (default 10) }` | `{ events: Array<{ ts, from, type, summary }> }` — flattened, human-readable, newest last, ≤ 100 |
| `approve_request` | `{ id: string, decision: 'approved' \| 'denied', reason?: string }` | `{ ok, id, decision }`; error text if the id is no longer pending. Declares `_meta["anthropic/requiresUserInteraction"]`, so in Claude Code the permission prompt for this call is the owner's yes/no; never allowlisted |
| `switch_room` | `{ room \| room link, relay? }` | `{ ok, room, relay }` — leaves the current room and joins another with the same identity/offers; also `POST /switch` and the overlay's room box |
| `leave_room` | `{ reason? }` | `{ ok, left }` — disconnects, forgets the saved join (no auto-restart), stops the daemon; also `POST /leave` and the overlay's Leave button; rejoin with the join command |
| `wait_for_events` | `{ timeoutSeconds?: number (default 60) }` | `{ messages: InboxMessage[], pending: PendingRequest[] }` — long-poll; returns on the next teammate message or pending request, or empty arrays at timeout. Codex/Cursor's manual watcher path. Never decides anything |

Tool description text (copy into the server verbatim):

- `list_teammates`: "List teammates currently online and every tool or command each one can run for you on their machine (their MCP servers: Supabase, Figma, Linear, GitHub, etc., plus shell commands). Call this whenever you need a tool, credential, dataset, or environment you don't have, before telling the user you can't do something. Then call describe_capability on the specific tool before using it."
- `describe_capability`: "Full description, input schema, owner notes, and an example call for one teammate capability. Always call this before ask_teammate on a tool you haven't used in this session; the owner's notes contain project-specific details (IDs, table names, conventions) you cannot guess."
- `ask_teammate`: "Use a teammate's tool (tool + args, from describe_capability) or run a shell command on their machine (command). They see exactly what you're asking and your `why`, and must approve unless the capability is marked 'always'. Shell commands run in the owner's configured working directory with their environment. A shell offer marked fixed: true is one exact command line the owner chose (e.g. git.diff runs `git diff HEAD`): pass command: '<offer name>' and nothing else; arguments or extra flags will not match it. Returns { status, exitCode, output }: exitCode 0 = success, 1 = the tool reported an error, null = killed at the owner's timeout. If status is 'running', call check_job with the jobId. If 'denied', do not retry the same request; tell the user why."
- `check_job`: "Check on, or wait for, a job started by ask_teammate. waitSeconds blocks up to that long for completion (0 = return immediately). Same result shape as ask_teammate; exitCode null means it was killed at the owner's timeout."
- `post_event`: "Post a short note to the team activity feed (what you're doing, what you found)."
- `send_message`: "Send a short message to a teammate's agent ('all' for everyone). Use it to coordinate: what you're about to change, a fix idea for something you saw in team_activity, a question about their tool. Delivered live to their terminal and the room page, and into their agent's context on its next prompt (Claude Code) or when it calls inbox (Cursor)."
- `inbox`: "Unread messages from teammates addressed to you or to everyone. Call it when you start a task or when team_activity shows a message. Marks them read."
- `team_activity`: "What teammates and their agents have done recently: prompts, tool calls, files touched, requests. Check before editing files others may be working on."
- `approve_request`: "Approve or deny a teammate's pending request to use this machine. Only call this after the user has explicitly said yes or no to the specific request shown in the mesh notification. Claude Code's own permission prompt for this call is where they say it: when a mesh notification reports a pending request, call this with decision 'approved' right away and let that prompt ask the user; if the user rejects the prompt, call again with decision 'denied' (and their reason, if any) so the teammate is told. Never decide on the user's behalf."
- `wait_for_events`: "Wait for the next teammate message or request to use this machine (long-poll, up to timeoutSeconds). Returns messages and pending requests as information; approvals are decided by the user in the mesh overlay or dialog, never by you. Loop on this when the user asks you to watch mesh."

`send_message` rejects an offline `to` (other than `all`). The recipient daemon keeps the last 500 messages in memory, prints each live, fires a native notification (skipped for replayed history older than 5 min), wakes `/pending` long-pollers (the overlay shows it with a reply box; the Claude Code watcher prints `mesh: message from <who>: …` into the session; `wait_for_events` returns it), and serves them via `inbox` / `GET /inbox`.

`ask_teammate` implementation: for `tool`, look up the offer in the last `presence` and validate `args` locally against `inputSchema` before emitting (fail fast with a readable error). Emit `request`, wait for the `decision`/`result` frames with that `id`, buffer `output` chunks into a job record `{ id, to, command, status, chunks[], exitCode, ... }` kept in memory (Map). `check_job` reads the same Map.

## 4. Hooks (Claude Code only; shipped by the plugin, else installed by `mesh join` into `<cwd>/.claude/settings.json`)

When the Claude Code plugin is installed it ships these same five hooks (`plugin/hooks/hooks.json`, same `emit.js`) plus a SessionStart hook, and `mesh join` skips the merge below. Otherwise `mesh join` copies `hooks/emit.js` to `~/.mesh/emit.js` (the installer downloads it from the relay's `/emit.js`) and merges five entries into the project's `.claude/settings.json`, replacing previous mesh entries and keeping everything else (`hooks/install.sh <repo>` does the same by hand; needs `jq`). Each hook is `node ~/.mesh/emit.js <kind>` (prefixed `MESH_DAEMON=http://localhost:<port>` when the port isn't 7337), timeout 5 s, reading the hook's stdin JSON and POSTing `{ kind, summary, data }` to `POST http://localhost:7337/event`. The daemon forwards it as an `event` frame. Hooks never fail the agent: errors are swallowed, exit 0, 1 s HTTP timeout.

| hook | kind | summary |
|---|---|---|
| `UserPromptSubmit` | `prompt` | first 140 chars of the prompt |
| `PreToolUse` (matcher `Edit\|Write\|MultiEdit`) | `pre_edit` | posts nothing; conflict warning, see below |
| `PostToolUse` (matcher `Edit\|Write\|MultiEdit`) | `file_touched` | relative path |
| `PostToolUse` (matcher `mcp__.*`) | `tool_call` | tool name |
| `Stop` | `status` | "idle" |

`UserPromptSubmit` also GETs `/inbox?unread=1` (unread messages, printed first, marked read) and `/activity?sinceMinutes=10` and prints both to stdout so they land in the agent's context on every prompt. Cursor still pulls with `inbox`; Codex pulls by default and can separately opt into automatic background runs with `codexWake`.

**Conflict warning (`pre_edit`).** Before every Edit/Write/MultiEdit the hook GETs `/touched?path=<relative path>&minutes=10`. If another user's daemon reported a `file_touched` for that path in the last 10 minutes, it prints one line per user (max 3), newest first, as PreToolUse JSON — `hookSpecificOutput.additionalContext` (lands in the agent's context) and `systemMessage` (shown to the user):
`mesh: abhi edited src/billing.ts 3 min ago — coordinate before changing it (send_message abhi)`. It never blocks: no `permissionDecision`, exit 0 always, 1 s HTTP timeout, silent when the daemon is down or nobody touched the file.

**Where `file_touched` comes from.** Claude Code hooks (above, precise). For everyone else — Codex, Cursor, a human in an editor — the daemon's **git watch** (`apps/daemon/src/gitwatch.ts`): when the daemon's cwd is inside a git repo it runs `git status --porcelain --untracked-files=normal` every 5 s (5 s timeout, a tick is skipped while the previous run is still going), diffs against the last snapshot, and emits one `file_touched` (summary = path relative to the repo root, `data.source = "git"`) per newly modified/added path, max 20 per tick, one emit per path per 60 s; the first snapshot is a baseline and emits nothing. `mesh-artifacts/`, `.mesh`, and directory entries are never emitted. Off with `--no-git-watch`, or automatically when Claude Code hooks are installed for that cwd (an `emit.js` hook in `.claude/settings.json`, or the mesh plugin) so files are not reported twice. Logs one line on start: `git watch: on (<repo root>)`.

## 5. Daemon local HTTP (`127.0.0.1:<port>`, default 7337)
- `POST /mcp` — stateless Streamable HTTP MCP endpoint (§3). `GET`/`DELETE /mcp` → 405.
- `POST /event` — `{ kind, summary, data? }`, see §4. 400 on a bad body.
- `GET /inbox?unread=1` — `{ messages }`, same as `inbox` (`unread=0` returns read ones too; look-back 120 min).
- `GET /activity?sinceMinutes=10` — `{ events }`, same as `team_activity`.
- `GET /touched?path=<relative path>&minutes=10` — `{ touched: [{ user, ts }] }`: other users who reported a `file_touched` for that path in the window (from the activity buffer; one entry per user, newest first; a path matches when equal or when one is a `/`-suffix of the other, since hooks and the git watch may root paths differently). 400 without `path`. Backs the `pre_edit` hook (§4).
- `GET /pending?wait=25&messages=1&consumer=overlay&since=<ISO>` — `{ pending: PendingRequest[], messages: InboxMessage[] }`; long-poll ≤ 25 s, returns early on a new request or message. Any caller counts as an attached watcher for 60 s (§2 approval rule). `consumer=overlay` + `since` returns messages newer than `since` without marking them read; the default consumer (the Claude Code watcher) marks them read.
- `POST /decide` — `{ id, decision: 'approved'|'denied', reason? }` → `{ ok, id, decision }`; 404 if the id is not pending. Same effect as `approve_request`.
- `POST /message` — `{ to, text }` → `{ ok: true }`; same as `send_message` (the overlay's reply box).
- CORS: allowed for the relay's origin only, so the overlay page can call the daemon. Bound to 127.0.0.1.
- `GET /health` — `{ user, room, relay: 'connected'|'disconnected', members: n }`. Also how `mesh status` / `--background` decide the daemon is alive.

## 6. CLI surface
```
mesh join <room | https://<relay>/r/<room>> [--as <user>] [--relay wss://…] [--config /abs/team.json] [--port 7337]
          [--background] [--no-register] [--cursor] [--codex] [--no-git-watch] [--no-codex-wake]
mesh status                                     # background daemon: user@room, relay state, members, pid, log path (exit 1 if none)
mesh stop                                       # SIGTERM the background daemon, remove ~/.mesh/daemon.json
mesh log                                        # print ~/.mesh/daemon.log
mesh watch [--port 7337]                        # one line per pending request / teammate message; run by the Claude Code plugin monitor
mesh ask <who> "<command>" [--why "…"] [--room] [--as] [--relay] [--config] [--wait 120]   # human-driven request; exit = remote exit code, 2 = denied/timeout
mesh init                                       # writes a starter team.json in the current directory
mesh feed <room> [--relay …]                    # Abhi's app
```
- A room link (`https://host/r/room`, also `wss://host/room`) sets both room and relay. `MESH_RELAY` is the env fallback for `--relay`.
- `--background`: re-spawns itself detached with `MESH_BACKGROUND=1`, stdout/stderr to `~/.mesh/daemon.log`, state `{ pid, port, room, relay, user, cwd, startedAt }` in `~/.mesh/daemon.json`, waits ≤ 15 s for `/health`, then prints the registration lines. Re-running while one is up on that port prints "already running". Approvals in this mode are native dialogs only.
- `--no-register`: skip §3 registration and §4 hooks. `--cursor` / `--codex`: register even if the tool isn't detected. `--no-git-watch`: don't emit `file_touched` from `git status` (§4).
- Env: `MESH_APPROVE=tty` forces the terminal prompt; `MESH_DEBUG=1` logs every frame; `MESH_RELAY` default relay.
- Installed form: `node ~/.mesh/mesh.mjs <command> …` (the bundle has no `mesh` on PATH). Installers run `join <room> --relay <baked origin> --background [--as …]`.

## 7. Explicit non-goals
Auth beyond room name, OAuth, P2P/NAT traversal, exposing teammates' tools as first-class MCP tools in the requester's client (they are data returned by our static tools; this sidesteps client tool-list caching / list_changed), OAuth passthrough, file locking, a web dashboard beyond the room page and the overlay, persistence beyond the relay's 200-frame ring buffer.
