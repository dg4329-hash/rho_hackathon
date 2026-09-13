---
name: mesh
description: Use a teammate's tools, credentials, or machine through mesh, and answer teammates' requests to use this machine. Use when a "mesh:" notification arrives, when the user mentions a teammate's tool or environment you don't have, or before saying you can't do something for lack of access.
---

# mesh — borrow a teammate's machine, not their credentials

Two directions, both through the `mesh` MCP tools (`mcp__plugin_mesh_mesh__*`).

## A teammate is asking to use *this* machine

A background monitor prints one line per request, e.g.

`mesh: tarush wants to run \`figma-export.sh "Onboarding/Step 2"\` on this machine (why: need the frame). Call approve_request({"id":"…","decision":"approved"}) now …`

1. Call `approve_request` with that `id` and `decision: "approved"` **immediately**. Do not ask in chat first:
   Claude Code's permission prompt for this tool call is where the user says yes or no, and it shows them the
   exact id and decision. The tool is never auto-approved (it declares `requiresUserInteraction` and is in
   `permissions.ask`).
2. If the user rejects that prompt, call `approve_request` again with `decision: "denied"` and, if they gave
   one, a one-line `reason`, so the teammate hears back instead of waiting.
3. Never decide on the user's behalf, never batch several ids into one call, and never call it for a request
   the user has not seen. If the tool says the id is no longer pending, tell the user; the daemon has fallen
   back to its own dialog or the request expired.

Requests wait about 2 minutes for an answer, then the daemon falls back to a native dialog.

## You need something a teammate has

1. `list_teammates` — who is online and what each one offers (their MCP servers and shell commands).
2. `describe_capability` — schema, owner notes, and an example call. Always do this before a tool you have not
   used in this session.
3. `ask_teammate` — with `why` written for a human who will read it before approving. If the result is
   `running`, `check_job`. If `denied`, do not retry the same request; tell the user why.
4. `send_message` / `inbox` to coordinate; `team_activity` before editing files others may be working on.

If the tools are missing, the daemon is not running (maybe the user left the room on purpose): tell the user they can run `mesh join <room-link> --background`
(or the relay's install one-liner); the plugin's SessionStart hook restarts it automatically afterwards.

## Rooms: join, switch, leave
- **Switch/join another room** (daemon already running): call `switch_room` with the room name or the room link the user gave you (`https://<relay>/r/<room>`). Only when the user explicitly asks.
- **Leave**: call `leave_room` only when the user explicitly asks to leave or disconnect (or they run `mesh leave`). The daemon stops and forgets the saved join; it will not auto-restart. Do not rejoin on your own afterwards.
- **Join from nothing** (no mesh tools available): only when the user explicitly asks to join (never to get a tool back after they left, and never because a room link is still in the conversation), run the join in a shell — `node ~/.mesh/mesh.mjs join <room-or-link> --background` — or the relay's one-liner from the room page; then tell the user to restart the session once so the tools appear.
