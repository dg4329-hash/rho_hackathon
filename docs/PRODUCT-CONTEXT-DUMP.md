# Mesh — complete product and implementation context

> Snapshot: `main` through commit `bb783fa`, reviewed 2026-09-13. This is a shared context document for understanding the current product and exploring where it could go. Sections 1–16 describe the implementation and its evidence; Section 17 is a product-opportunity brainstorm, not a claim that every idea is shipped. Do not copy real room keys, owner tokens, API credentials, or private teammate data into prompts.

## 1. The product in plain language

**Mesh lets one person's coding agent borrow a specific tool, command, file, or working environment from a teammate's computer while that teammate keeps control of execution.** The agent asks through a shared room, gives a reason, and the owner's local daemon checks the owner's configured policy. If the action needs approval, the owner sees the requested command or tool arguments and accepts or denies it. The owner's machine executes approved work with its own installed tools and credentials; only output and optional file artifacts travel back. The relay carries messages and a live activity feed but never runs the borrowed tool. The repository's pitch is **"borrow a teammate's machine, not their credentials."** [README](../README.md), [protocol](../packages/protocol/src/index.ts), [core](../apps/daemon/src/core.ts).

A concrete example: Dev's agent lacks access to a design asset but Tarush has a local Figma export script. Dev's agent uses `list_teammates` to discover `figma.export`, `describe_capability` to read its usage and Tarush's notes, then `ask_teammate` with the exact command and a reason. Tarush sees the request in Mesh's overlay or OS dialog, approves it, and the script runs on Tarush's laptop. Dev's agent receives the text output and any exported file descriptor, then may download the file using `fetch_artifact`. This Figma flow is an **intended demo scenario**; the repo's historical docs do not establish a successful live Figma call. [DEMO](DEMO.md), [NEXT](NEXT.md), [artifacts](../apps/daemon/src/artifacts.ts).

The roles are **requester** (the teammate's agent that asks), **owner** (the machine hosting the capability and the human who controls it), and **relay** (the shared room transport). One person can be both requester and owner for different requests. The room creator additionally holds an **owner token** that can end the entire session. A regular room member can leave only their own connection. [room keys](ROOM-KEYS.md), [relay](../apps/relay/src/index.ts).

Mesh is useful when a team has fragmented access: one person's MCP servers, SaaS login, local files, configured CLI, or working copy are unavailable to another person's agent. It also gives the team visibility through a room page, optional overlay, terminal feed, messages, and file-touch awareness. It works across Claude Code, Codex, and Cursor by registering one local MCP server with static Mesh tools; teammates' changing offers are returned as data by those tools. The strategic extension is that **MCP gives an agent tools; Mesh could make the team's collective capabilities discoverable and usable, with execution remaining at the owner.** Section 17 develops that idea and separates near-term applications from future capabilities. [local MCP server](../apps/daemon/src/local-server.ts), [registration](../apps/daemon/src/register.ts).

### What is shipped, and what is still a demo claim

| Area | Current code | Evidence / caveat |
|---|---|---|
| Rooms and cross-laptop transport | One WebSocket/HTTP relay, keyed rooms, presence and forwarded frames | Historical README records Mac↔Mac and Mac↔Windows trials over a public ngrok relay. This sweep did not repeat them. |
| Borrow a shell command or imported MCP tool | Owner daemon discovers offers, applies permission, executes, returns result | Automated suites cover many paths; actual imported OAuth-backed Figma/Linear remotes are not supported by the importer. |
| Human yes/no | Overlay, Claude Code watcher plus its user permission prompt, native OS dialog, terminal fallback | Windows dialog and notification were manually observed in prior work. A live cross-laptop overlay approval is not established by the current docs. |
| Files | Upload artifact to relay, return descriptor, download on demand | Implemented and tested with fixtures. Relay files are temporary, not a durable file store. |
| Messaging and awareness | Agent messages, inbox, prompt hooks, git watch, pre-edit warning | Claude Code gets an in-session plugin path; Codex/Cursor primarily poll. An opt-in Codex wake can start a separate run. |
| End a session | Owner-only end closes everyone and temporarily tombstones the room | Implemented in relay and daemon with tests. A relay restart forgets tombstones. |
| Railway | Dockerfile and Railway configuration are present | Do not imply a live Railway deployment has been verified unless someone tests the current service. |
| Marketing site | `website/index.html` is served by the relay at `/site` | Separate from the functional landing page at `/` and room page at `/r/:room`. |

This table deliberately separates **implemented** from **live-verified**. Older [NEXT](NEXT.md), [DEMO](DEMO.md), and [BUILD-LOG](BUILD-LOG.md) text still says the overlay is "shipping tonight," says the room name is the only authentication, or lists ten/fourteen MCP tools. In this checkout the overlay exists, keys are required by default, and the local MCP server has **15 tools**. Treat the source files and [protocol package](../packages/protocol/src/index.ts) as the source of truth.

## 2. Architecture and ownership boundaries

```text
Requester human → Requester coding agent (Claude Code / Codex / Cursor)
                         │ local MCP call: list / describe / ask / check
                         ▼
                 Requester's local daemon
                         │ keyed WebSocket frames
                         ▼
             Shared HTTP + WebSocket relay
             • room and key gate
             • fan-out, presence, bounded history
             • room page, overlay, installers
             • temporary artifact bytes
                         │ same-room keyed WebSocket frames
                         ▼
                  Owner's local daemon
                  • offer discovery and config
                  • schema and permission checks
                  • pending approvals
                  • shell or imported MCP execution
                  • loopback MCP and HTTP APIs
                         │ exact action + reason shown
                         ▼
                  Owner human approves/denies
                         │
                  result/output/artifact descriptor
                         └─────────────── back to requester's agent
```

The relay is **not a cloud agent or credential vault**. It receives the request metadata, the command or MCP arguments, decision/result/output frames, activity summaries, and uploaded artifact bytes. Credentials used by a local CLI or MCP server stay with the owner process if the owner has configured them locally. Be precise: Mesh does **not** make all request content private from the relay, and output or artifacts may contain sensitive material if a tool returns it. The relay is a transport and temporary store. [relay](../apps/relay/src/index.ts), [files](../apps/relay/src/files.ts), [core](../apps/daemon/src/core.ts).

There are three essential processes:

1. **Relay** — `apps/relay`, one Node HTTP/WebSocket service. It creates rooms, derives/verifies room keys, forwards frames, tracks presence and bounded recent history, serves the functional web UI and downloadable installers/bundle/plugin, and temporarily stores files. Its state is in memory. [index.ts](../apps/relay/src/index.ts), [web.ts](../apps/relay/src/web.ts), [keys.ts](../apps/relay/src/keys.ts), [files.ts](../apps/relay/src/files.ts).
2. **Per-laptop daemon** — `apps/daemon`, joined to a room. It owns local capabilities, connects to the relay, hosts a loopback Streamable HTTP MCP server, exposes loopback endpoints to hooks/overlay, keeps jobs/inbox/activity in memory, handles approvals, executes allowed work, and registers its MCP server with supported agents. [cli.ts](../apps/daemon/src/cli.ts), [core.ts](../apps/daemon/src/core.ts), [local-server.ts](../apps/daemon/src/local-server.ts).
3. **Optional visibility clients** — the functional room page, overlay, Claude Code plugin/hooks, `apps/feed` terminal feed, and source-run Electron tray. They make the room visible and provide approval surfaces; none replaces the daemon. [web.ts](../apps/relay/src/web.ts), [overlay.ts](../apps/relay/src/overlay.ts), [feed](../apps/feed/src/index.ts), [tray](../apps/tray/main.js).

The shared `@mesh/protocol` package defines Zod schemas/types for permissions, offers, config, wire frames, artifacts, MCP inputs/results, and constants. The daemon and relay import those types rather than inventing separate ones. The code says the package wins when prose in [CONTRACT](CONTRACT.md) differs. [protocol](../packages/protocol/src/index.ts).

### Repository map

| Path | Responsibility |
|---|---|
| `packages/protocol/src/index.ts` | Shared schemas, frame shapes, tool inputs/results, descriptions, defaults. |
| `apps/daemon/src/cli.ts` | `mesh` commands, join/background lifecycle, room switch/leave/end, installed bundle entry. |
| `apps/daemon/src/core.ts` | Request and result routing, authorization path, messaging, inbox/activity, lifecycle. |
| `apps/daemon/src/{config,mcp-import,permissions,shell,approval,pending,artifacts,local-server,register,relay-client,gitwatch,codex-wake}.ts` | Focused daemon subsystems. |
| `apps/relay/src/{index,web,overlay,keys,files,limits,validate}.ts` | Room server, pages, keys, temporary files, hardening. |
| `apps/feed/src/index.ts` | Optional terminal live feed; mock relay/daemon support exists. |
| `plugin/`, `hooks/` | Claude Code plugin and fallback hooks for prompts, tools, file touches, messages, warnings. |
| `apps/tray/` | Optional un-packaged Electron always-on-top overlay wrapper. |
| `website/index.html` | Separate marketing site served at `/site`. |
| `scripts/` | Relay tunnel/deploy helpers, room end-to-end runner, Figma shell export example. |
| `docs/` | Protocol and feature contracts, build history, planned demo, research and operations notes. |

## 3. Core user journey, step by step

### Create and join a room

The functional landing page at `/` can create a room via `POST /api/rooms`. The response includes a random-looking room name, a **room key**, a shareable link `https://host/r/<room>#k=<key>`, and a separate **owner token/link** for the creator. The creator's page stores the owner token locally and removes it from the visible URL; the ordinary link shared with teammates carries only the room key. The room page displays a prefilled join command, downloadable Mac/Windows launchers, membership, activity, and an overlay button. The `/site` page is a separate marketing page. [web.ts](../apps/relay/src/web.ts), [keys.ts](../apps/relay/src/keys.ts), [website](../website/index.html).

A teammate can run the one-liner from the room page without cloning the repo. It downloads `mesh.mjs` (the bundled daemon) and `emit.js` under `~/.mesh`, stops any previous installed daemon, and joins in the background. It requires Node 20+, plus the target coding agent if that agent should be registered. Re-running the installer refreshes the bundle and rejoins. The relay also serves downloadable `.cmd` and `.command` wrappers. The join flow chooses a handle from `git config user.name` or the OS username unless `--as` is supplied. It uses the current working directory as the default project context, imports local MCP servers, may publish read-only Git offers, and registers its local MCP server with Claude Code/Codex/Cursor. The agent session usually needs one restart or plugin reload to see new tools. [README](../README.md), [cli.ts](../apps/daemon/src/cli.ts), [register.ts](../apps/daemon/src/register.ts).

The room's **owner link** carries an extra `o=<ownerToken>` fragment. Passing that link or `--owner` when joining saves the ability to end the session for everyone. Teammates who join with the normal key link cannot end it. A regular `leave_room` only disconnects its caller. [owner.ts](../apps/daemon/src/owner.ts), [room keys](ROOM-KEYS.md).

### Discover, request, decide, execute, return

1. The requester asks `list_teammates`; its daemon reads current relay presence and returns each online teammate's advertised offers. A summary includes name, kind, permission, and for fixed commands a usage hint. [local-server.ts](../apps/daemon/src/local-server.ts), [relay-client.ts](../apps/daemon/src/relay-client.ts).
2. The requester asks `describe_capability({who,name})`; it gets a full description, JSON input schema for MCP tools, the owner's notes, and a suggested `ask_teammate` call. This is how a model learns project-specific usage. [protocol](../packages/protocol/src/index.ts).
3. `ask_teammate` requires `who`, `why`, and exactly one of `command` or `tool` plus `args`. The requester validates a described MCP tool's arguments before sending where possible. It emits a uniquely identified `request` frame through the relay. [core.ts](../apps/daemon/src/core.ts), [schema.ts](../apps/daemon/src/schema.ts).
4. The owner's daemon checks the addressee, request age/replay, offer matching, argument schema, and permission. `never` returns a denial without a prompt. `always` auto-approves. `ask` routes to a currently attached watcher/overlay, then native dialog, then terminal as available. The owner sees the **action and reason before execution**. [core.ts](../apps/daemon/src/core.ts), [permissions.ts](../apps/daemon/src/permissions.ts), [approval.ts](../apps/daemon/src/approval.ts), [pending.ts](../apps/daemon/src/pending.ts).
5. Approved shell work runs in the owner's configured working directory with the owner's environment and a timeout. Approved imported MCP work calls the owner's local MCP client, with schema validation and result flattening. The daemon emits a decision, optional output chunks, and a result with exit code, duration, tail, and artifact descriptors. The requester holds a memory-only job record; `ask_teammate` waits up to 55 seconds (45 default), then returns `running` if needed, and `check_job` polls for completion. [shell.ts](../apps/daemon/src/shell.ts), [mcp-import.ts](../apps/daemon/src/mcp-import.ts), [jobs.ts](../apps/daemon/src/jobs.ts).

The request/action and output are visible in the room activity stream. It is an observable event feed, **not hidden model reasoning or a full conversation transcript**. [feed](../apps/feed/src/index.ts), [web.ts](../apps/relay/src/web.ts).

## 4. Capabilities, configuration, and the actual permission model

An optional local `team.json` configures `user`, `room`, `relay`, `key`, `owner`, `cwd`, timeout, arbitrary-command policy, MCP import, named shell offers, per-tool permission globs and notes, Git offers, and Codex wake. Without it, `mesh join` uses zero-config defaults: import Claude Code/Cursor MCP servers at **ask**, no custom shell offers, `allowArbitrary: "ask"`, `gitOffers: true`, `codexWake: false`. CLI flags override matching file settings. Do not commit `team.json` or token-bearing files; only [team.json.example](../team.json.example) is tracked. [config.ts](../apps/daemon/src/config.ts), [protocol](../packages/protocol/src/index.ts), [AGENTS](../AGENTS.md).

```json
{
  "user": "owner",
  "room": "example-room",
  "relay": "wss://relay.example",
  "cwd": "/path/to/project",
  "timeoutSeconds": 120,
  "allowArbitrary": "ask",
  "codexWake": false,
  "gitOffers": true,
  "import": {
    "fromClaudeCode": true,
    "fromCursor": true,
    "servers": ["*"],
    "defaultPermission": "ask"
  },
  "permissions": {
    "supabase.list_*": "always",
    "supabase.delete_*": "never"
  },
  "notes": {
    "supabase.*": "Read-only demo project; describe tables before querying."
  },
  "offers": [
    {
      "name": "figma.export",
      "command": "./scripts/figma-export.sh",
      "description": "Export a frame already accessible on this machine.",
      "permission": "ask"
    },
    {
      "name": "git.status",
      "command": "git status --short --branch",
      "description": "Read-only project status.",
      "permission": "always"
    }
  ]
}
```

**Shell offers have two forms.** If the configured `command` contains whitespace, it is a **fixed exact command line**, advertised with `fixed: true`. The requester uses the offer name (for example `command: "git.status"`) or the exact normalized line; appended flags/arguments become an unmatched arbitrary command. If the configured command is a single executable token, a request using that executable can pass arguments through. Compound shell syntax (pipes, semicolons, redirection, command substitution, newlines, and similar constructs) cannot inherit a single-token offer's `always` permission; it goes through the arbitrary-command policy. A fixed command containing a pipe is still the exact owner-defined line. No match uses `allowArbitrary`, which is `ask` or `never`. The four default Git offers are fixed, read-only `git.status`, `git.diff`, `git.log`, and `git.branch` when the project is a Git repo, unless disabled or overridden. [permissions.ts](../apps/daemon/src/permissions.ts), [config.ts](../apps/daemon/src/config.ts), [CONTRACT](CONTRACT.md).

**MCP import is local to the owner.** The daemon reads stdio or unauthenticated HTTP/SSE server entries in Claude Code and Cursor configs, skips its own Mesh server, starts/connects, calls `tools/list`, and advertises each imported tool as `<server>.<tool>`. The owner controls permission with import default plus matching globs and supplies notes. OAuth-only remote MCP servers that require a client-specific auth flow may be skipped; a shell offer can wrap an already authenticated local CLI or script instead. This is not OAuth passthrough and does not transfer tokens. [mcp-import.ts](../apps/daemon/src/mcp-import.ts), [CONTRACT](CONTRACT.md).

**Approval surfaces.** An overlay or Claude Code watcher polling `GET /pending` makes the daemon park eligible requests in a pending queue. The overlay uses `POST /decide` for Approve/Deny. Claude Code can call `approve_request`, which requires user interaction in the agent client. If the watcher stops or no answer arrives within 120 seconds, the daemon falls back to a native OS dialog; that dialog times out after 90 seconds. On macOS it uses `osascript`, on Linux `zenity` where available, and on Windows a native message box through PowerShell. A foreground terminal can use `MESH_APPROVE=tty`; without any viable approval surface, an `ask` is denied. `MESH_APPROVE=watcher|dialog|tty` can force a path. **The agent should never infer approval from a message or call `approve_request` without the owner's yes/no.** [approval.ts](../apps/daemon/src/approval.ts), [pending.ts](../apps/daemon/src/pending.ts), [native.ts](../apps/daemon/src/native.ts).

**Important distinction for the demo:** `always` means the owner explicitly preconfigured that offer to run without a per-request click; saying "every single request requires a click" would be false. The accurate claim is "the owner defines what is auto-allowed, forbidden, or requires approval, and controls every `ask` action before execution." Also, arbitrary shell commands default to `ask`, which is permissive once a human approves. The request may run a local shell; the approval display is an execution boundary, not a sandbox for that shell. [protocol](../packages/protocol/src/index.ts), [shell.ts](../apps/daemon/src/shell.ts).


## 5. All 15 local MCP tools

The daemon exposes a **stateless Streamable HTTP MCP endpoint** at `http://127.0.0.1:<port>/mcp` (default port 7337). These are static tool names; each teammate's dynamic capabilities appear in `list_teammates` data, not as additional tools installed into the requester's agent. [local-server.ts](../apps/daemon/src/local-server.ts), [protocol](../packages/protocol/src/index.ts).

| Tool | What the agent uses it for | Important semantics |
|---|---|---|
| `list_teammates` | See online members and summarized offers | Discovery only; presence may change after the call. |
| `describe_capability` | Get one offer's full description, schema, owner notes and usage | Should precede a new `ask_teammate` tool call. |
| `ask_teammate` | Request one shell command or one imported MCP call on a named owner | Requires `why`; exactly one of `command` or `tool`; may return `running`, `completed`, or `denied`. |
| `check_job` | Wait for or retrieve a prior job by ID | A job is memory-only; it is not a durable queue. |
| `post_event` | Emit a prompt/tool/status/note/activity item to the room | Feed is observable summaries, not hidden reasoning. |
| `send_message` | Send text to one online teammate or `all` | Recipient gets a live event plus inbox entry; MCP handler rejects a named offline recipient. |
| `switch_room` | Leave current room and join a different room/link with same identity/offers | Keyed room needs a valid key; old room may be restored after refusal. |
| `leave_room` | Disconnect this machine and forget its saved join | Ends its local daemon; does not end the shared room. |
| `end_session` | Creator ends the room for everyone | Requires the saved owner token; closes all sockets and invalidates the room until relay tombstone expires/restarts. |
| `wait_for_events` | Wait for new messages or pending requests | Informational only; does **not** approve. Current implementation defaults to **50 seconds**, maximum 55, despite older docs saying 60. Polling it can make approvals wait in the watcher queue. |
| `inbox` | Read recent addressed/broadcast messages and file notices | Default unread-only; returned messages are marked read. In-memory last 500. |
| `send_file` | Upload an owner-local file and send its descriptor/message | Source must resolve under the project or `~/.mesh`. |
| `fetch_artifact` | Download an artifact named in a result/inbox/activity item | Saves under `./mesh-artifacts/<sender>/`; small images or text can also be returned inline to the model. |
| `team_activity` | Get recent flattened room events | Useful before overlapping work; not a durable audit log. |
| `approve_request` | Submit the owner's decision for one pending request | Must be tied to explicit owner input; Claude Code's MCP user-interaction metadata and `permissions.ask` rule are part of that UI. |

The requester's `ask_teammate` and `check_job` results include an ID, status, exit code or denial reason, bounded output tail, duration, and optional artifact descriptors/errors. A long job can continue after `ask_teammate` returns `running`; the model should call `check_job`. A denied request should be reported, not silently retried. [protocol](../packages/protocol/src/index.ts), [jobs.ts](../apps/daemon/src/jobs.ts).

### Loopback HTTP endpoints, distinct from MCP

The same daemon binds **127.0.0.1 only** and exposes `POST /mcp`, `POST /event`, `GET/POST /approvals` (runtime surface mode), `POST /switch`, `POST /leave`, `POST /end`, `POST /message`, `GET /inbox`, `GET /activity`, `GET /touched`, `GET /health`, `GET /pending`, and `POST /decide`. `/pending` can long-poll; `consumer=overlay` distinguishes the overlay's message view from the Claude watcher so overlay reads do not mark messages read. The relay's web origin is allowed through CORS for browser-to-local-daemon calls. These are local operational interfaces, not public relay APIs. [local-server.ts](../apps/daemon/src/local-server.ts), [OVERLAY-API](OVERLAY-API.md).

## 6. The wire protocol and what the relay sees

Clients connect to the relay's WebSocket with room, user, role (`daemon` or `feed`), and room key. A daemon sends `hello` with its advertised offers. The relay records the offers for presence, sends recent bounded history to the joiner, broadcasts current presence on joins/leaves, and forwards subsequent frames to the other sockets in that room. It does not sign a frame, inspect a command for permission, or execute it. [protocol](../packages/protocol/src/index.ts), [relay index](../apps/relay/src/index.ts), [relay-client.ts](../apps/daemon/src/relay-client.ts).

| Frame | Purpose |
|---|---|
| `hello` / `presence` | Announce role/offers and show online users. |
| `request` | Requester sends `id`, `to`, `why`, and one command or tool+args. |
| `decision` | Owner says `approved`, `denied`, or `auto`, optionally with reason. |
| `output` | Owner streams bounded stdout/stderr chunks for shell work. |
| `result` | Final exit code, elapsed time, timeout flag, output tail and artifacts/errors. |
| `event` | Prompt/tool/file-touch/status/note/message/file activity. |
| `error` / `room_ended` | Relay rejection or creator-ended session. |

The owner daemon ignores requests not addressed to it, its own requests, already-seen/replayed requests, and requests more than **30 seconds** old by the sender timestamp. The requester accepts result/decision/output frames only when the frame's `from` matches the intended owner handle. This is a handle check, not cryptographic sender authentication. A machine clock far ahead of another can cause fresh requests to be dropped. The relay client reconnects with backoff after ordinary disconnects; a bad room key (close 4401) or ended room (4410) is terminal. It holds small recent-frame/outbox buffers; the product does not guarantee durable delivery across long outages. [core.ts](../apps/daemon/src/core.ts), [relay-client.ts](../apps/daemon/src/relay-client.ts), [CONTRACT](CONTRACT.md).

The relay retains at most **200 frames / 4 MiB** of recent room history and a total in-memory temporary artifact store, then forgets them on restart. History replay helps a newly joined feed catch up, but does not turn the product into a persistent chat or audit system. [relay index](../apps/relay/src/index.ts), [limits.ts](../apps/relay/src/limits.ts).

## 7. Keys, owner authority, safety, and session lifecycle

By default the relay derives a 16-character lowercase base32 room key as an HMAC of the room name using server-side `ROOM_SECRET`. A separate HMAC over `"owner:" + room` produces the creator's owner token. The share link puts the room key in the URL **fragment** (`#k=...`) so opening the page does not send it in the initial HTTP URL. Browser code stores it locally and sends it to keyed APIs. WebSocket connections carry the key as a **query parameter**, so a proxy/access log may capture it. The daemon saves the key (and owner token when held) in local Mesh config/state. Rotate `ROOM_SECRET` only if invalidating old links is acceptable; without a stable secret, restarting the relay changes every derived key. [keys.ts](../apps/relay/src/keys.ts), [ROOM-KEYS](ROOM-KEYS.md).

A room key gates WebSocket connections, `GET /api/rooms/:room`, and file upload/download. The public landing/marketing pages and installer/bundle/plugin downloads do not require a room key. Anyone with the **share link** can join that room; there is no account system, per-member cryptographic identity, or private per-agent encryption layer beyond the HTTPS/WSS transport. The owner human's approval is the operational control for `ask` actions. [web.ts](../apps/relay/src/web.ts), [ROOM-KEYS](ROOM-KEYS.md).

**End session is different from leave.** The creator's owner link includes `&o=<ownerToken>`; only an owner-holding daemon/browser can call `POST /api/rooms/:room/end` with both key and owner token. The relay broadcasts `room_ended`, closes all room sockets with code 4410, deletes that room's frames/files, and holds an in-memory tombstone for roughly 24 hours so the link returns 410/4410 instead of silently reopening. Every joined daemon treats the end as terminal, answers in-flight work, forgets saved join, and exits. A relay restart forgets the tombstone, so an old link manually reused later can name a fresh empty room. [owner.ts](../apps/daemon/src/owner.ts), [index.ts](../apps/relay/src/index.ts), [ROOM-KEYS](ROOM-KEYS.md).

When an individual daemon **leaves or stops**, it forgets its saved join so the Claude Code SessionStart hook does not resurrect it. It denies pending requests with a "left the room" reason, sends final null-exit results for active work, kills tracked shell jobs, dialog/other child processes and imported stdio MCP servers, closes local HTTP, and exits. A switch racing a leave is refused. `mesh end` can also use a saved owner join when no daemon is currently running. [core.ts](../apps/daemon/src/core.ts), [children.ts](../apps/daemon/src/children.ts), [cli.ts](../apps/daemon/src/cli.ts).

Security and reliability boundaries to state honestly:

- Credentials stay in the owner's environment/MCP server, but **request arguments, decision/event metadata, output and uploaded artifacts pass through the relay**. Do not claim the relay sees nothing.
- The room key is a bearer secret: sharing the link shares room access. The owner token is a separate bearer secret for global end. Avoid putting either in a slide or context document.
- The local approval routes are bound to loopback and the Claude tool has interaction metadata, but there is no independent human authentication on `POST /decide` for other local processes. The design assumes local processes/browser access are trusted.
- An `always` offer bypasses the per-request approval UI by owner configuration. A `never` offer is denied. Approval of arbitrary shell work can grant a powerful one-time action in the owner's own environment.
- The current relay trusts client-supplied `from` handles inside frames; the daemon's job result check compares that handle with the intended owner, not a signed identity. Do not describe Mesh as an adversarially hardened zero-trust network.
- Source inspection found two potential edge cases to investigate before strong reliability claims: a disconnected requester can mark a queued request denied while its client may later flush the queued frame on reconnect; a malformed discovered `team.json` can fall back to zero-config on a link-based join unless `--config` was explicit. These are **code-review concerns, not freshly reproduced bugs**. [relay-client.ts](../apps/daemon/src/relay-client.ts), [core.ts](../apps/daemon/src/core.ts), [cli.ts](../apps/daemon/src/cli.ts).


## 8. Messaging, presence, awareness, and background Codex work

A daemon can send a short message to one teammate or `all`. The message is an `event` frame, so it appears in room activity. An addressed recipient daemon prints it, keeps it in an in-memory inbox (last 500), wakes any local long-pollers, and may show an OS notification for a fresh non-replayed message when no watcher is attached. A file event similarly becomes an inbox message with an artifact descriptor. The overlay shows messages and can reply through the local `POST /message` route. [core.ts](../apps/daemon/src/core.ts), [native.ts](../apps/daemon/src/native.ts), [overlay.ts](../apps/relay/src/overlay.ts).

**Claude Code** has a plugin monitor that polls the local daemon and makes teammate messages/pending requests visible inside its session. The prompt hook also drains unread inbox items and injects a recent activity summary into the next prompt. **Codex and Cursor** see Mesh through their registered MCP tools and can call `inbox` or `wait_for_events`; an open Codex desktop thread is not inherently pushed a new turn by a message. This matters in a demo: "agent received a push" is accurate for the Claude Code plugin path, while Codex/Cursor usually pull unless a separate background wake is enabled. [plugin](../plugin/), [hooks](../hooks/), [local-server.ts](../apps/daemon/src/local-server.ts).

**Optional Codex wake** is configured with `"codexWake": true` and can be disabled for one join with `--no-codex-wake`. Each fresh addressed/broadcast teammate message or file event can enqueue a separate hidden `codex exec --json --approve-for-me -` process using the owner's saved Codex login, MCP config, project instructions and normal Codex permission machinery. The queue is serial, capped at 20 items, discards messages older than five minutes, persists the last 500 seen IDs under `~/.mesh/codex-wake-seen.json`, caps a run at 30 minutes, and shows its final status in a native alert. Its prompt says teammate text is untrusted and says **never approve a Mesh request on the owner's behalf**. It does not create a turn in the already-open Codex desktop thread. [codex-wake.ts](../apps/daemon/src/codex-wake.ts).

**Important current-code limitation:** opt-in Codex wake starts work in response to a teammate message without a separate Mesh owner preapproval for that message. The background Codex run still has its own Codex sandbox/approval controls, and it cannot decide Mesh approvals. A prior local approval-gating patch was never pushed and is absent from this `main` snapshot. Do not show message-triggered background execution as though Mesh itself first asks the owner for a yes/no on the complete message. [codex-wake.ts](../apps/daemon/src/codex-wake.ts).

**File awareness.** Claude Code hooks publish prompt summaries, post-tool MCP calls, edited paths, and idle status. Before Edit/Write/MultiEdit, a PreToolUse hook queries local `/touched` and warns if another teammate reported touching the same path recently; the warning is informational and never blocks the edit. For Codex, Cursor, or a human editor without Claude hooks, the daemon may run `git status --porcelain` every five seconds inside a Git repo and emit newly dirty paths, with rate limits and a silent initial baseline. It skips Git watch if it detects the Claude hook/plugin to reduce duplicates. These are awareness signals, **not file locks, full file sync, or guaranteed real-time coordination**. [plugin hooks](../plugin/hooks/hooks.json), [emit.js](../plugin/hooks/emit.js), [gitwatch.ts](../apps/daemon/src/gitwatch.ts), [touched test](../apps/daemon/test/touched.test.ts).

## 9. Artifacts and files

Large bytes do **not** ride the WebSocket request/result frame. A shell command can print `MESH_FILE: <path>` or legacy `PNG: <path>.png`; after execution the owner daemon finds each file and uploads it to the keyed relay file API. An imported MCP response that includes an image or blob can also produce an artifact. Text content remains in a bounded output tail. Upload failures are reported as `artifactErrors` without changing an otherwise successful job into a failed one. `send_file` explicitly sends an allowed project/`~/.mesh` path with an optional note. [artifacts.ts](../apps/daemon/src/artifacts.ts), [core.ts](../apps/daemon/src/core.ts), [FILES-API](FILES-API.md).

The relay accepts up to **25 MB per file**, holds at most **200 MB total** with least-recently-used eviction, and expires files after about **one hour**. It is memory-only and requires the room key for upload/download. The result or inbox carries a small descriptor (name, MIME, size, URL, optional hash). The requester uses `fetch_artifact` to save the file under the current project's `mesh-artifacts/<sender>/`; small images can be returned as MCP image content and small text/JSON inline. The room page/overlay render file chips. This is temporary transfer, not persistent shared storage or automatic project synchronization. [relay files](../apps/relay/src/files.ts), [daemon artifacts](../apps/daemon/src/artifacts.ts), [FILES-API](FILES-API.md).

The included [Figma export shell example](../scripts/figma-export.sh) can list frames or select one by name/ID and prints a PNG path marker plus a text outline. It is a useful example of wrapping a credentialed local API behind an owner-approved command. Its actual success depends on a valid local Figma token/file key, which is not supplied by the repo. Do not treat the script's presence as proof the live demo asset exists.

## 10. The interfaces people see

### Functional landing and room page

At `/`, a beginner can start a session or paste an existing room link. The creator is redirected to an owner link; the functional room page `/r/:room` displays the shareable link, a copy control, four numbered setup steps, a join command adjusted for platform/key/owner, downloadable launchers under a disclosure, a self-check/restart instruction, connected members and advertised offers, recent room activity, a "Pop out overlay" control, and owner-only two-step "End session for everyone." On Windows the page selects PowerShell by default; its install guidance shows only the selected platform. The room key comes from the fragment/local storage and is attached to protected API calls. The page polls the relay room API about every two seconds. [web.ts](../apps/relay/src/web.ts).

At `/site`, the relay serves [website/index.html](../website/index.html), a separate aesthetic marketing page introduced in newer commits. Its sections are a hero with animated install terminal, an Alex/Taylor Figma-request walkthrough, Ask/Approve/Done explanation, Always/Ask/Never control cards, a room-link-to-install-command generator with macOS/Linux and Windows toggles, and a start-session call to action. The walkthrough has play/pause/replay and a full-screen modal. **It is a scripted DOM animation, not a live Mesh request:** the displayed Figma result and approval are staged by page JavaScript. The page calls its own sequence a "Live demo," so anyone recording it should distinguish this visualization from a real multi-laptop run. Its setup and CTA currently point to a hard-coded Railway URL; source code alone does not establish whether that service is healthy. The marketing phrase "No key was ever shared" refers to Taylor's credential, since the room *access key* is shared via the link. This page is separate from the functional room experience and MCP host. The relay copies it to a served asset at startup. [website animation](../website/index.html), [web.ts](../apps/relay/src/web.ts), [relay index](../apps/relay/src/index.ts).

### Overlay

The room page opens an always-on-top **Document Picture-in-Picture** window in supported Chrome/Edge or a regular popup fallback. The compact overlay follows the landing page's light/dark palette and uses the same logo mark. It shows pending approvals with requester/action/arguments/`why`, Approve/Deny, messages with reply, recent feed and file chips, and connection state. Its Settings disclosure holds the daemon port, room switch, leave and end controls. Failed decisions stay visible for retry. Its request decisions go to **the owner's local daemon** (`/decide`); its activity/presence data come from **the keyed relay room API**. A browser on a different computer cannot approve for the owner merely by opening the public room page; it needs access to that owner's loopback daemon. The panel can collapse and has alert/badge behavior; the sound checkbox enables a local alert tone. [overlay.ts](../apps/relay/src/overlay.ts), [OVERLAY-API](OVERLAY-API.md).

The optional [Electron tray](../apps/tray/) wraps the same overlay in a source-run, frameless always-on-top panel with tray controls; packaging/install distribution is not set up. Its browser storage is separate from Chrome's and it does not pass the saved room key automatically, so a keyed feed may initially need the link/key entered in the overlay's key box. Local approvals can still use the daemon connection. The browser overlay is the primary story, not the tray installer. [tray README](../apps/tray/README.md), [main.js](../apps/tray/main.js).

### Terminal feed and Claude Code plugin

`apps/feed` is an optional terminal projector view for room presence, requests, decisions, output and hooks/activity; it includes a mock playback path for a scripted demo. **Current code gap:** the standalone feed CLI builds a WebSocket URL without a room key, so it cannot join a default keyed production room as written. It also retries after an owner-ended room rather than treating 4410 as terminal. For a keyed real demo, use the **room page's live feed** unless this is fixed and tested. A mock feed is a simulated fallback and should be identified as such. [feed](../apps/feed/src/index.ts), [DEMO](DEMO.md).

The Claude Code plugin is served as `/plugin.tgz` and installed during join when possible. It bundles the Mesh MCP server registration, five activity/awareness hooks, a SessionStart hook to restore a saved join, a background monitor that watches local pending requests/messages, and a skill that teaches the agent to use Mesh. If plugin install fails, the daemon falls back to direct Claude MCP registration and a merged project hook config; it removes old duplicate hook/MCP entries when the plugin takes over. This plugin is project-scoped to where join ran. [register.ts](../apps/daemon/src/register.ts), [plugin](../plugin/), [PLUGIN](PLUGIN.md).

For non-default local ports, the plugin's MCP entry and watcher can use `MESH_PORT`, but its `emit.js` hook defaults to port 7337 unless `MESH_DAEMON` is separately set. On a custom-port demo, prompt events/inbox/pre-edit warnings can silently miss the daemon. Use default 7337 for the stage path or test and set `MESH_DAEMON` explicitly. [plugin emit.js](../plugin/hooks/emit.js), [plugin MCP config](../plugin/.mcp.json).

## 11. How to run the checkout and a live room

**Repo development:** Node 20+ and the pinned pnpm version via Corepack. From the repo root:

```powershell
corepack pnpm install
corepack pnpm -r typecheck
$env:PORT = '8090'
corepack pnpm -F relay start
```

The relay's `start` script builds the current daemon bundle before serving `apps/daemon/dist/mesh.mjs` as `/mesh.mjs`. For a standalone rebuild, run `corepack pnpm -F daemon bundle`. In another terminal, inside the project whose tools/files should be exposed:

```powershell
corepack pnpm -F daemon start join 'http://localhost:8090/r/example-room#k=<room-key>' --as owner --background
corepack pnpm -F daemon start status
Invoke-RestMethod http://127.0.0.1:7337/health
```

The example link/key must be a real one created at the relay landing page; `example-room` alone will not work on a key-enforcing relay. A creator should use their **owner link** when they need the End session control. A teammate uses the **share link**. When using `pnpm -F daemon start`, an explicit relative `--config` can resolve from `apps/daemon`; use an absolute path for an intended custom config. [README](../README.md), [cli.ts](../apps/daemon/src/cli.ts).

**No-clone teammate onboarding:** visit the shared `https://<relay>/r/<room>#k=<key>` page and copy its platform-specific one-liner. On Windows the page supplies a PowerShell installer command or a downloadable `.cmd`; on macOS/Linux it supplies a Bash installer or Mac `.command`. The installer saves `~/.mesh/mesh.mjs` and joins in the background. Restart the coding agent once to load the Mesh MCP tools. Manage an installed daemon with `node ~/.mesh/mesh.mjs status|log|stop` (Windows: use `$env:USERPROFILE\.mesh\mesh.mjs`). On the repo checkout, `corepack pnpm -F daemon start <command>` runs source. [README](../README.md), [web.ts](../apps/relay/src/web.ts).

**Public hosting:** `apps/relay/Dockerfile`, `railway.json`, and `apps/relay/railway.toml` define a one-replica Railway route with a `/health` check. The Docker image includes protocol, daemon bundle, plugin and website. A stable, secret `ROOM_SECRET` environment variable is required for links to survive redeploys. There is also a local/public ngrok helper in `scripts/tunnel-relay.sh`; it persists a generated local room secret and checks for stale ngrok. Railway Serverless sleep may drop in-memory rooms/history when idle, but links remain derivable from a stable secret. A cold start can briefly fail. These are operational instructions from source/docs, **not proof of a currently healthy Railway deployment**. [Dockerfile](../apps/relay/Dockerfile), [railway.json](../railway.json), [README](../README.md), [tunnel script](../scripts/tunnel-relay.sh).

The relay also limits room creation and socket connects per IP, caps rooms at 10,000, forgets empty-room state after two idle hours, rejects over-2 MiB frames, probes duplicate offering-daemon names before refusing a second live instance, and pings connected sockets. Most limits are environment-tunable. One replica is important because room/history/file state is in process memory. [limits.ts](../apps/relay/src/limits.ts), [index.ts](../apps/relay/src/index.ts).


## 12. Verification inventory and live-evidence status

The repository has meaningful automated coverage. On this Windows checkout, `corepack pnpm -r typecheck`, the relay suite, and the local MCP acceptance test passed after the room/overlay changes. The full daemon suite did **not** pass: its shell timeout test and later Unix/macOS-oriented artifact, hook, and native-dialog fixtures fail on this host. Those failures were reproduced while checking the push, and temporary diagnostic edits were discarded; no daemon changes went into `bb783fa`. This is not a fresh live multi-laptop rehearsal or proof that today's deployment is healthy. Before shipping code, [AGENTS](../AGENTS.md) calls for typecheck, daemon suite, daemon MCP suite, relay suite, and a daemon bundle after daemon changes.

| Suite / file | What it is intended to exercise |
|---|---|
| `pnpm -r typecheck` | TypeScript across protocol, daemon, relay, feed, tray. |
| `pnpm -F daemon test` | Shell/permissions, pending approval, artifacts, Git watch, touched paths, keys, Codex wake, leave and end. Defined in [daemon package](../apps/daemon/package.json). |
| `pnpm -F daemon exec tsx test/mcp.test.ts` | Local MCP server registration/tool behavior and protocol integration. |
| `pnpm -F relay test` | Relay frames/presence, files, keys, limits, hardening and owner end. Defined in [relay package](../apps/relay/package.json). |
| `pnpm e2e:rooms` | Isolated real-daemon flow against a local relay: create/key/join/isolation, messaging and approvals, switch/leave/rejoin, owner end, relay restart/secret change. Can target a remote relay with `--relay`; remote restart check is skipped. [E2E-ROOMS](E2E-ROOMS.md). |
| `pnpm -F feed mock` | Scripted/simulated feed path, useful as an openly labeled fallback rather than live proof. |
| `pnpm -F daemon bundle` | Produce the single-file daemon that the relay serves to installers. |

The prior [README verified section](../README.md) records public-relay Mac↔Mac and Mac↔Windows activity, native Windows dialog/notification checks, Claude plugin install and imported Playwright/files offers, and a separate Codex wake run that called `list_teammates`. The prior [PLUGIN](PLUGIN.md) doc records headless plugin checks and calls out interactive-session work still needed. [NEXT](NEXT.md) records live Figma, keyed imported Supabase, three laptops at once, projector feed, timed rehearsal, and Railway as unproven at the time it was written; several of its technical status statements are stale. A Mesh MCP exchange in this working session did use Dev's imported Playwright to navigate YouTube and received a completed result, then a later verification request was denied by Dev; that illustrates both a successful remote tool response and a denial result, but it does **not** prove the main video played after an ad, the UI approval surface, or a currently connected room.

An earlier integration attempt after the teammate lifecycle commits also encountered Windows test-fixture issues (Git Bash path and a repository directory containing a space). This checkout's current daemon-suite run confirms that the suite is not green on Windows. Tests involving real child processes, native dialogs, and shell scripts can behave differently on Windows than on the Mac fixtures.

## 13. Demo construction guide based on the product that exists

### A reliable story arc

1. **Problem, 15 seconds:** "Our agents are single-player. One teammate has a configured tool or authenticated environment that another agent does not."
2. **Discovery:** Show `list_teammates` returning a named owner's offers, then `describe_capability` showing the exact description, schema/usage and owner note. This is the product's universal MCP abstraction; the requester does not get the credential.
3. **Request and reason:** Show one `ask_teammate` with a clearly understandable action and `why`. Keep the action short enough that the approval card visibly shows it in full. Distinguish a named shell offer from an imported MCP offer.
4. **Human control:** For the main yes/no beat, configure the chosen offer as **ask**; put the owner's overlay on a visible side display. The owner reads the full action and reason, clicks Approve, and the requester receives output. A separate request can be denied to show a clean failure that the agent reports without retrying.
5. **Result becomes work:** Show the requester agent using the returned text or calling `fetch_artifact` for a produced image/file. If the demo uses a live external service, verify its credential, resource names, latency and output beforehand. Otherwise choose an honest local fixture/command and say it is a fixture.
6. **Team context:** Show a message/reply or room activity event. The functional room page is a safe keyed feed surface. The pre-edit warning can be a second example if rehearsed; do not imply a lock.
7. **Close:** "The action ran on the owner's laptop. The owner's credentials stayed there. The owner controlled whether this `ask` request ran."

[DEMO](DEMO.md) has a historical three-minute run of show, fallback ladder, and judge questions, but its script assumes several not-yet-proven live integrations and a terminal feed that currently lacks key support. Use it as inspiration, then adapt the actual run to the present code and a rehearsed environment. The key visual moment is the owner seeing **action + reason before the result appears**, not an after-the-fact success popup.

### Good choices for a first real rehearsal

- An owner-defined `echo` or read-only fixed Git offer establishes the transport and result path, but `always` will not show the approval card. Mark it `ask` for the yes/no demo.
- A local script that returns useful text and prints `MESH_FILE:` for a generated image proves artifact transfer without depending on a third-party API. Label the data as a fixture if it is one.
- An imported MCP tool from a teammate (for example Playwright on Dev's machine) proves the universal import path. It may produce a real OS approval request depending on Dev's config; confirm the owner's availability and that the browser/tool is stable.
- A true Figma/Supabase demo is stronger **only if** the right owner's token/server is available, the daemon imports or wraps it successfully, the permission mode is correct, and both approve and deny beats were rehearsed. Presence advertising a tool is not itself a completed end-to-end call.
- For the projector, the keyed **room page** is currently a better live feed than the standalone `apps/feed` CLI until feed key support is fixed. Test the page after a long/high-volume run because its cursor can stall after the 200-frame history ring fills.

### Wording that stays technically true

| Say | Avoid implying |
|---|---|
| "The owner chooses auto-allowed, denied, and ask-before-running capabilities." | "Every request always needs a click." |
| "The credential remains on the owner's machine; the result crosses the relay." | "The relay never sees any data." |
| "The room link is the access key; the owner has an extra end-session token." | "The room name is the only authentication." |
| "Mesh borrows existing local MCP tools and shell offers." | "Every OAuth MCP is automatically importable." |
| "The overlay can approve through the owner's local daemon; OS dialog is the fallback." | "A public browser page alone can approve on any laptop." |
| "Claude Code can receive plugin messages in-session; Codex can poll or start an opt-in separate run." | "A teammate message creates a new turn in the existing Codex desktop chat." |
| "The room activity feed shows observable prompts, tool calls, file touches and requests." | "Mesh synchronizes all agent conversations or hidden reasoning." |
| "The relay has bounded, temporary in-memory history and files." | "There is a durable audit log or permanent shared drive." |

### Questions a demo designer should settle before building slides/video

- Who is the requester, who owns the borrowed capability, and whose screen shows the approval? Which two machines are actually present?
- Is the relay local, ngrok, or Railway today? Does every participant have the **same keyed room link** and can they pass `/health` and presence checks?
- Is the main borrowed action a shell offer, imported MCP tool, or a file? Is its permission `ask`? What exact action and reason will the human see?
- Which agent client is shown? Does its Mesh MCP registration appear in a **fresh** session? If Claude Code, did join occur in the demo project so the project-scoped plugin loads?
- Will the demonstration include a real artifact? If yes, is its path readable by the owner's daemon and does the requester call `fetch_artifact` before claiming to have viewed it?
- Is a live external service essential, or should a deterministic local fixture establish the product behavior first? Is every fallback labeled accurately?
- Is the demo using the room page feed, an overlay, a tray, or the terminal feed? Which works with keyed rooms on the actual machine?
- Has the yes/no click path been observed on the owner's real desktop, including a denial? Does a running watcher change routing to a pending queue?
- How will the creator end or reset the room between rehearsals? Do not put a real `#k=` or `#o=` value on a public slide or in a recorded terminal scrollback.

## 14. Known gaps and areas to verify before stronger claims

These are **source-backed or documentation-backed caveats**, not a prioritized product backlog:

1. **Stale docs:** [NEXT](NEXT.md), [BUILD-LOG](BUILD-LOG.md), and parts of [README](../README.md)/[CONTRACT](CONTRACT.md) mix older unkeyed/ten-tool language with current 15-tool, keyed, end-session code. This context file uses the code snapshot as its baseline.
2. **Terminal feed and keys:** [feed](../apps/feed/src/index.ts) sends no room key and retries after an ended-room close. For current keyed rooms its live projector path is incomplete.
3. **Room-page/overlay feed cursor:** [web.ts](../apps/relay/src/web.ts) uses ring-buffer positions as polling cursors. When the relay's 200-frame history fills, the `next` value can stop advancing and browser feeds can miss later events. This is also noted in [BUILD-LOG](BUILD-LOG.md).
4. **Tray onboarding:** the source-only Electron tray does not pass a saved room key into its separate web storage; the overlay may need a pasted link/key. No packaged installer exists. [tray](../apps/tray/main.js).
5. **Custom daemon ports and plugin hooks:** plugin `emit.js` defaults to localhost:7337 unless `MESH_DAEMON` is set, even if its MCP/monitor use `MESH_PORT`. [emit.js](../plugin/hooks/emit.js).
6. **Codex wake permission:** current opt-in message wake does not have a distinct Mesh owner preapproval before starting the separate Codex process. The user can leave it off, and Codex's own sandbox applies. [codex-wake.ts](../apps/daemon/src/codex-wake.ts).
7. **Temporary/non-durable state:** job records, inbox, room history, tombstones and artifact bytes do not survive relevant process restarts. Stable `ROOM_SECRET` preserves key derivation, not past data. [relay](../apps/relay/src/index.ts), [core](../apps/daemon/src/core.ts).
8. **Remote outages and clocks:** stale requests over 30 seconds old are dropped; offline requests/result delivery are not a durable queue. Test disconnect/reconnect behavior before describing exactly-once execution. [core.ts](../apps/daemon/src/core.ts), [relay-client.ts](../apps/daemon/src/relay-client.ts).
9. **Browser/OS behavior:** Document PiP is browser-dependent; fallback popup and Windows native dialogs need real-desktop rehearsal. A headless test does not prove the popup appeared above a particular app. [overlay.ts](../apps/relay/src/overlay.ts), [native.ts](../apps/daemon/src/native.ts).
10. **Source-level authorization concerns:** `/decide` is protected by localhost binding and browser CORS, not a separate user-auth token for native local callers. Relay frame `from` is claimed by clients. The security pitch should stay scoped to a trusted small team and an owner-controlled computer. [local-server.ts](../apps/daemon/src/local-server.ts), [relay](../apps/relay/src/index.ts).

## 15. Source of truth and reading order for future ChatGPT work

For a demo or design prompt, use **this file for the consolidated story**, then verify exact technical claims in the current files before publishing:

1. [README](../README.md) for the product's intended onboarding and run commands.
2. [CONTRACT](CONTRACT.md) and [protocol package](../packages/protocol/src/index.ts) for protocol/config/tools; when they disagree, the TypeScript package is authoritative.
3. [daemon core](../apps/daemon/src/core.ts), [local MCP server](../apps/daemon/src/local-server.ts), [approval](../apps/daemon/src/approval.ts), [permissions](../apps/daemon/src/permissions.ts), and [CLI](../apps/daemon/src/cli.ts) for actual request, human control and lifecycle.
4. [relay index](../apps/relay/src/index.ts), [web](../apps/relay/src/web.ts), [overlay](../apps/relay/src/overlay.ts), [keys](../apps/relay/src/keys.ts), and [files](../apps/relay/src/files.ts) for the room and visible UX.
5. [plugin](../plugin/), [fallback hooks](../hooks/), [feed](../apps/feed/src/index.ts), [tray](../apps/tray/) for agent integration and presentation surfaces.
6. [DEMO](DEMO.md), [NEXT](NEXT.md), [E2E-ROOMS](E2E-ROOMS.md), [FILES-API](FILES-API.md), [ROOM-KEYS](ROOM-KEYS.md), and [BUILD-LOG](BUILD-LOG.md) for planned beats, prior evidence and historical context—checking dates and source before reusing a claim.

**Prompt-ready product brief:** "Mesh is a small-team, local-first collaboration layer for coding agents. Each laptop runs a daemon that exposes its owner's chosen shell commands and existing MCP tools as discoverable offers. A keyed WebSocket relay connects a room and hosts the setup page, activity view, approval overlay, installer and temporary file store. A requesting agent discovers an offer, supplies the exact action and a reason, and receives an output or file result after the owner's policy auto-allows it or the owner approves it through an overlay, Claude Code prompt, native dialog or terminal. The borrowed tool executes on the owner's computer with its existing credentials; credentials are not passed to the requester. Agents can also send messages and files and see limited awareness of teammates' activity. Claude Code, Codex and Cursor connect through the daemon's local MCP server. The creator can end the room for everyone. The product is a prototype: room-link bearer access, temporary in-memory state and some unverified live/demo paths should be presented honestly."


## 16. Practical CLI and HTTP reference

The current daemon CLI registers these commands in [cli.ts](../apps/daemon/src/cli.ts); it does **not** register a `mesh feed` subcommand even though older prose in [CONTRACT](CONTRACT.md) mentions one. The feed is its own package command.

| Command | Effect |
|---|---|
| `mesh join <room-or-link> [--as ...] [--relay ...] [--key ...] [--owner ...] [--config ...] [--port ...] [--background]` | Configure offers/import, connect a daemon and register agent clients. Optional `--no-register`, `--no-git-watch`, `--no-git-offers`, `--no-codex-wake`, `--codex`, `--cursor` adjust setup. |
| `mesh ask <who> "<command>" [--why ...]` | Human/CLI request through Mesh; useful as a simple transport smoke test if the coding agent is not ready. |
| `mesh init` | Write a starter `team.json` in the current project. |
| `mesh watch [--port ...]` | Long-poll local pending approvals and messages; used by the Claude Code plugin monitor. |
| `mesh status` | Read the saved daemon state and loopback health; show user, room, relay and log path. |
| `mesh log` | Print the saved background daemon log. |
| `mesh stop` | Stop the local background daemon and forget the join; do not auto-rejoin. |
| `mesh leave [--port ...]` | Ask the running local daemon to leave and forget its join; other members stay. |
| `mesh end [--port ...] [--reason ...]` | Creator-only end for everyone; can use a saved owner join even with no running daemon. |

A background join saves a daemon state/log and remembered room config under `~/.mesh`. A plugin SessionStart hook may resume a saved join after a session start, but leave/stop/end intentionally clear it. The CLI can receive `MESH_RELAY`, `MESH_KEY`, `MESH_OWNER`, `MESH_APPROVE`, `MESH_DEBUG` and related environment settings; avoid printing real secret values. Installed form is `node ~/.mesh/mesh.mjs <command>` where there is no global `mesh` binary. [cli.ts](../apps/daemon/src/cli.ts), [config.ts](../apps/daemon/src/config.ts).

The public relay routes live on the same host/port as its WebSocket:

| Route | Use / gate |
|---|---|
| `GET /health` | Public small status, including rooms/connections and ended count. |
| `GET /` | Functional start/join landing page. |
| `POST /api/rooms` | Create room, return share link and creator-only owner link/token; rate-limited. |
| `GET /r/:room` | Functional room page; fragment holds key client-side. |
| `GET /api/rooms/:room?since=...` | Keyed presence and recent events for room page/overlay. Ended room returns 410. |
| `POST /api/rooms/:room/end` | Key plus owner token; global end. |
| `GET /overlay?room=...&port=...` | Public overlay HTML; its protected fetches carry the room key and talk to owner-local daemon for decisions. |
| `GET /site` | Separate static marketing page and scripted visual walkthrough. |
| `GET /install.sh`, `GET /install.ps1` | Public platform installers with relay origin baked in. |
| `GET /join.cmd`, `GET /join.command` | Public downloadable platform wrappers; room/key/owner arguments are generated by the room page. |
| `GET /mesh.mjs`, `GET /emit.js`, `GET /plugin.tgz` | Public daemon bundle, hook emitter and Claude plugin archive. |
| `POST /api/files/:room`, `GET /api/files/:room/:id` and `.../meta` | Keyed temporary artifact upload, bytes and metadata. |

A `GET` of public HTML is not itself room authorization: the protected room state, WebSocket, file API and decision path have separate gates. The relay's production `start` script rebuilds the daemon bundle before serving it; a different entry path still needs the asset present. Missing bundle/plugin assets produce a service-unavailable response with a hint. [web.ts](../apps/relay/src/web.ts), [index.ts](../apps/relay/src/index.ts), [files.ts](../apps/relay/src/files.ts).

## 17. Product opportunity and application brainstorm

This section is **strategic exploration**, not a feature inventory. Sections 1–16 describe what the code actually implements and where evidence is still missing. The brainstorming question is: **What useful resource exists on another person's machine that my agent cannot currently use?** That framing is broader than asking which SaaS integrations Mesh should add.

The current primitive is **discover → describe → request with a reason → apply the owner's policy or ask the owner → execute on the owner's machine → return output or an artifact**. One agent's tool list is local; Mesh makes teammates' explicitly offered capabilities discoverable through its own stable MCP tools. In the strongest formulation: **MCP answers “What can this agent do?” Mesh could answer “What can this team do?”** The owner's credentials stay in their environment, although request arguments, results, and transferred files still cross the relay. [request flow](#discover-request-decide-execute-return), [trust boundary](#2-architecture-and-ownership-boundaries).

### 17.1 What is being borrowed?

| Scarce resource | A concrete request | Fit with today's primitive | Boundary to remember |
|---|---|---|---|
| Credentials and authenticated tools | Use an owner's Figma, Supabase, Stripe or Linear operation | An owner can offer a local CLI command or import a compatible local MCP server. | The owner executes with their credential; arbitrary OAuth remotes are not automatically importable. |
| Authenticated browser session | Read a dashboard or download a file through an owner's configured browser tool | Imported Playwright is an example of a real remote MCP capability. | Reusing a specific logged-in browser profile/session is tool-dependent and needs verification. |
| Working environment | Run a command in the owner's configured repo, Python environment or local service | Offered shell work runs in the owner's daemon working directory. | Mesh does not synchronize entire repos or environments. Inputs and returned results must be explicit. |
| Machine, operating system and attached device | Run a macOS build, Windows check, GPU command or device test | A named command/MCP tool can wrap a local action and return text or files. | Device control, scheduling and reliable test orchestration are not built in. |
| Network position | Query an internal service from a teammate already on the VPN | The action can execute on the reachable machine. | Mesh does not tunnel the requester's network; only the offered operation and its result cross. |
| Local or restricted data | Query a permitted dataset, inspect logs or return a report | A local offer can compute an answer and return bounded output/artifacts. | Data does not magically remain local if the response itself exposes it; scope the tool and output. |
| Installed or licensed software | Export via CAD/Adobe or an internal application installed on one workstation | A wrapper command or compatible MCP server can expose a narrow operation. | The software must support automation, and its license and organization policy still apply. |
| Human authority | Request a deploy, refund, publish, delete or purchase action | `ask` already surfaces an exact capability action and reason for approval. | Today's click authorizes execution, not a formal business approval, audit or identity workflow. |
| Another agent's expertise | Ask a specialist agent to inspect a design, codebase or incident | Messaging and tool calls provide pieces of the interaction. | Formal agent-to-agent task delegation, context transfer and structured follow-up are future work. |

The owner machine is the **execution boundary**. The relay is neither a secret vault nor an invisible private channel: it can see frame metadata and requested actions and temporarily holds returned artifacts. A room link is a bearer key, and the present `Always / Ask / Never` model is offer-level or pattern-level policy, not a complete enterprise authorization system. The interesting product promise is **“borrow access, not credentials”**, stated with those qualifications. [permissions](#4-capabilities-configuration-and-the-actual-permission-model), [keys](#7-keys-owner-authority-safety-and-session-lifecycle).

### 17.2 The application map

These 25 possibilities are grouped by the product capability they exercise. **“Current primitive” means an owner could attempt it by deliberately exposing a suitable shell command or importable MCP tool; it does not mean that service, device or cross-laptop workflow was verified.** “Extension” needs new product work. “Vision” depends on several extensions and should not be described as shipped.

| # | Application | Why someone would use it | Maturity |
|---|---|---|---|
| 1 | **Team-authenticated browser** | A teammate's browser can reach a customer dashboard, vendor portal or internal admin UI for an agent that lacks the session. | Current primitive, session-specific setup to verify |
| 2 | **Shared credentialed SaaS actions** | Ask the Figma/Linear/Stripe/AWS owner to perform one operation without copying their API key. | Current primitive for compatible local tools |
| 3 | **Just-in-time production diagnostics** | Ask for a narrowly exposed read-only query, logs or feature-flag inspection instead of distributing persistent production access. | Current primitive; stronger policy/audit needed for serious use |
| 4 | **Borrowed VPN/network position** | Execute a specific internal API query on the machine already connected to an office, customer or staging network. | Current primitive for an explicit local tool |
| 5 | **Cross-platform development** | Ask a Mac, Windows or Linux teammate to build or run a targeted check in their actual environment. | Current primitive; reproducibility/result UX to improve |
| 6 | **Peer device lab** | Install a build on a phone, run Xcode, inspect a Raspberry Pi or capture device logs and screenshots. | Extension of local offers and artifacts |
| 7 | **Team GPU and expensive compute** | Run inference, transcription, rendering or a benchmark on the team's one powerful machine. | Current primitive for small tasks; queuing/quotas later |
| 8 | **Private local models** | Use a specialist model on a secure workstation while keeping model weights and local corpus there. | Current primitive via a wrapper; data-handling policy matters |
| 9 | **Operational knowledge as callable interfaces** | An infra owner exposes `deploy.staging`, `rollback` and `inspect.logs` instead of teaching every agent brittle commands. | Current primitive; richer tool contracts later |
| 10 | **Agent-to-agent delegation** | Ask Dev's design agent to review a component using its own context and tools, not merely call one Figma tool. | Extension: structured task/response lifecycle |
| 11 | **Team of specialists** | Design, infra, security, data and product agents each maintain an owned capability domain the team can consult. | Extension built on delegation |
| 12 | **Automatic capability routing** | Ask for “someone who can test checkout” and have Mesh select among Playwright, BrowserStack and device owners. | Extension: discovery semantics and scheduler |
| 13 | **Follow-the-sun work** | Hand a runnable validation task to an online teammate in another time zone. | Vision: durable queue, availability and handoff |
| 14 | **Temporary cross-company rooms** | A client or agency exposes a small set of approved capabilities during an engagement without provisioning every contractor into every service. | Extension: identity, policy, isolation and audit |
| 15 | **Support escalation** | A support agent asks engineering/finance-owned diagnostic or refund capabilities for one customer case. | Extension: scoped workflows and business controls |
| 16 | **Human business authority** | Route deploys, refunds, publication, spending or deletion through the person accountable for that decision. | Extension: approval records, policy and identity |
| 17 | **On-demand teammate expertise** | Ask the teammate's agent why a system was built a certain way, using its permitted local notes and code context. | Extension: agent delegation or local search offers |
| 18 | **Federated organizational search** | Query each person's permitted local corpus for relevant context without centrally indexing every laptop. | Extension: search offers, aggregation and privacy rules |
| 19 | **Distributed RAG** | Route one question to finance, engineering, sales and design knowledge nodes, then synthesize cited results. | Vision: retrieval protocol and provenance |
| 20 | **Multi-agent peer review** | Send a change to separate security, testing and architecture agents, then combine their findings. | Extension: delegation and result synthesis |
| 21 | **Multi-machine testing swarm** | Run Safari on a Mac, Edge on Windows, backend tests on Linux and device checks on phones. | Current primitive for manual calls; orchestration is future |
| 22 | **A shared company computer** | Treat the organization's machines, tools, data and approval owners as one discoverable capability graph. | Vision and organizing metaphor |
| 23 | **Personal Mesh** | Use a home GPU desktop, work laptop, Mac and Raspberry Pi from whichever device currently hosts the agent. | Current room primitive; personal setup UX needed |
| 24 | **Family or remote assistance** | Request one understandable diagnostic action on a relative's machine with their explicit consent, avoiding broad remote control. | Possible extension; not the initial audience |
| 25 | **Hackathon-team coordination** | Ask the teammate with the key, working backend, design asset, deployment login or target OS to do the needed step. | Strong near-term fit with the current prototype |

Several of these are *the same workflow with different scarce resources*. For example, “borrow the VPN,” “borrow the GPU,” and “borrow the authenticated browser” all mean the requester sends a narrow operation to the node where it can run. The differentiated layer is not a catalog of Figma/Stripe/AWS integrations. It is the combination of **discovery, owner-defined capability, local execution, approval and returned result**.

### 17.3 Where to focus first

This is a product-focus ranking, **not a demo script**. A use case becomes a good wedge when the missing capability is common, the manual workaround is painful, the result is easy to use in the requester's task, and the owner is comfortable exposing a narrow interface.

| Priority | Focus | Why it fits | What to validate before claiming it |
|---|---|---|---|
| **1 — Authenticated tool borrowing** | Figma exports, issue context, read-only analytics or a local service-specific command | It expresses the existing discover/request/approve/return loop with a clear ownership boundary. The requester lacks a concrete capability the teammate already has. | At least one repeatable real service path, stable output/artifact, exact permission mode, and whether the owner actually saves interruption time. |
| **1 — Authenticated browser borrowing** | A dashboard or admin task available through the owner's browser/Playwright tooling | Nearly any web UI can become an owner-hosted capability without a bespoke service MCP. The need is intuitive to non-developers too. | Session/profile behavior, selector fragility, what actions can be safely scoped, and whether approval text is understandable. |
| **2 — Environment and cross-platform borrowing** | Run a test/build in the teammate's working setup or on another OS | Teams already say “works on my machine” and own diverse hardware. A result can be a log, screenshot or artifact. | Repeatability, input code/version alignment, sandboxing, task cleanup and whether commands are safe as named offers. |
| **2 — Internal diagnostics and network position** | Read-only production/staging logs, data or private APIs from a machine that already has access | This is a high-value enterprise extension of the same primitive. It can reduce standing access for other developers. | Narrow read-only interfaces, query limits, output filtering, identity, audit, compliance and operating within company policy. |
| **Later — Specialist-agent delegation and routing** | Ask the best design/infra/security agent for a result | Potentially the largest platform opportunity, but the current protocol primarily borrows tools and sends messages, not durable agent tasks. | Task ownership, handoff, context limits, progress, retries, attribution, cancellation and who approves each downstream action. |

The first two priorities deserve the most product learning because they require the fewest invented platform components. A single high-frequency “my agent needs something only a teammate has” workflow can establish value. A file transfer alone is weaker; the strong outcome is that the requesting agent **finishes a task it could not finish with only its own tools**. The feed, messaging and awareness features help the team trust and coordinate those cross-machine actions, but the capability-sharing loop is the wedge.

### 17.4 Three possible product directions

1. **“AirDrop for agent capabilities.”** The simple near-term product: your teammate has something your agent needs; your agent requests the specific action, their policy or approval governs it, and the result comes back. This is closest to what exists.
2. **A permissioned operating system for a team of agents.** People, machines, credentials, environments, data and authority become a discoverable graph. An agent expresses intent; Mesh identifies a suitable node, applies policy, runs there and returns the result. This needs better identity, capability contracts, selection and audit before it can be trusted at organization scale.
3. **A collaboration protocol for agents themselves.** An agent discovers another agent's specialist context, delegates a bounded task, follows up, receives a structured result and coordinates work across the team. Messaging is a beginning, but first-class delegation is not shipped.

The unifying long-range sentence is: **“Your agent is no longer limited by your laptop; it is backed by your team.”** It is a vision statement. Today's precise claim is narrower: a joined agent can discover **advertised offers from online teammates** and request those offers, with local owner execution and the current permission policy.

### 17.5 Questions that determine which opportunity is real

- **Frequency and ownership:** In which actual workflows does one teammate repeatedly possess a capability another agent needs? How many requests are worth the owner's interruption, and which can safely be auto-allowed?
- **Capability design:** Is the unit a named operation, a general shell program, a browser session, a dataset query, a device, or an agent task? Narrow, typed operations are easier to understand and approve than broad remote shell access.
- **Trust and privacy:** What exactly may appear in a request, result or file? The relay sees transported content, and a room-link bearer key is not corporate identity. Sensitive production/cross-company stories need stronger isolation, authentication, audit and retention controls.
- **Approval semantics:** Current `Always / Ask / Never` answers whether an operation may execute. Business authorization needs a separate record of who approved what, when, under which policy, and whether the action actually completed.
- **Working-context alignment:** For code/build/test borrowing, how does the owner run the *requester's exact revision* without silently using a different checkout? Does Mesh move a patch, invoke a shared repo, or require both machines to pull the same commit?
- **Result usability:** Does the requester get structured data, a file, a screenshot, a concise tool answer or a task result? Can its agent reliably consume that result and continue work?
- **Reliability:** What happens when an owner goes offline, a room restarts, an approval times out, a command has side effects, or an agent retries? Durable queues, idempotency and cancellation become essential for asynchronous routing.
- **Agent specialization:** Would teams maintain named specialist agents, or are narrow owner-hosted tools sufficient? Formal delegation should solve a repeated task that tool borrowing cannot, not merely add a second chat layer.
- **Audience:** The first adopter may be a hackathon team, small engineering team, agency/client pair, internal platform team or solo developer with multiple machines. Each has different setup burden and trust expectations.

The most useful next research step is to collect real instances of “I had to ask someone else to run or fetch this for my agent,” record the action and handoff time, and see which ones map cleanly to a narrow owner-hosted capability. That tests the wedge without committing to the entire distributed-agent vision.
