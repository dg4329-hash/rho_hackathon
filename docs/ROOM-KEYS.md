# Room keys — contract v1

Goal: nobody without the room LINK can connect, read the feed, download files, message agents, or open the overlay.
One link still shares everything. No accounts.

## Key
- `key = base32lower(HMAC-SHA256(ROOM_SECRET, room))[:16]` (RFC 4648 alphabet, lowercase, no padding).
- `ROOM_SECRET` is a relay env var. If unset the relay generates a random one at start and logs
  `! ROOM_SECRET not set: room keys reset on restart`. Keys are never stored; the relay recomputes and compares (timing-safe).
- `MESH_REQUIRE_KEY=0` disables enforcement (dev only). Default: enforced.

## Link format
`https://<relay>/r/<room>#k=<key>` — the key is in the URL FRAGMENT so it never reaches server logs or proxies.
Room page and overlay read it from `location.hash` and remember it in `localStorage` under `mesh.key.<room>`.

## Relay: where the key is required
| entry point | how the key is sent | on missing/wrong |
|---|---|---|
| WebSocket connect | query `&key=` | `error` frame `{ message: "room key required" \| "wrong room key" }` then close (4401) |
| `GET /api/rooms/:room` | `?key=` or header `x-mesh-key` | 401 `{ error }` |
| `POST /api/files/:room`, `GET /api/files/:room/:id`, `/meta` | header `x-mesh-key` or `?key=` | 401 |
| `GET /overlay?room=&port=` | `#k=` (client-side); the page itself is public HTML but every API call carries the key | overlay shows "this room needs its link" + a key box |
| `GET /r/:room` | `#k=` (client-side) | page renders a "paste the room link" box instead of the steps |
| `POST /api/rooms` (create) | none | returns `{ room, key, link }` |
| `GET /install.sh`, `/install.ps1`, `/join.cmd`, `/join.command`, `/mesh.mjs`, `/emit.js`, `/plugin.tgz` | none (public artifacts) | — |
`/health` stays public. `join.cmd`/`join.command` accept `&key=` and bake `--key` into the command.

## Daemon
- `mesh join <room-or-link> [--key K]`: a link with `#k=` supplies room, relay, and key. Key also from `team.json` `"key"` or env `MESH_KEY`. Stored in `~/.mesh/config.json` and `daemon.json` (state).
- RelayClient appends `&key=` on connect. On a 4401/`error` frame mentioning the key, print
  `this relay requires the room link (with its key). Get it from the room page.` and exit 2 (no reconnect loop).
- Artifact upload/download send `x-mesh-key`. `Artifact.url` stays keyless; `fetch_artifact` adds the header.
- `switch_room` accepts a link with `#k=` (sets key) or `{ room, key }`; switching to a keyed room without a key → readable error.
- `mesh watch` and hooks talk only to localhost; unchanged.

## Installers / room page commands
- `curl -fsSL <origin>/install.sh | bash -s -- <room> --key <key> [--as handle]` — the room page renders this from the fragment.
- PowerShell one-liner and `.cmd`/`.command` likewise carry `--key`.

## Frontend (keep simple; will be restyled later)
- Landing `/`: "Start a session" → POST /api/rooms → redirect to `/r/<room>#k=<key>`. Plus a "Join a room" box: paste a link → navigate to it.
- Room page: top card shows the shareable link (with key) + copy button + "anyone with this link can join; don't post it publicly".
  Steps as today, commands include `--key`. If no key in the fragment: only the "paste the room link" box.
- Overlay: reads key; footer shows a lock icon when keyed.

## Tests
Relay: create → key derivation deterministic under a fixed ROOM_SECRET; ws without key rejected 4401; wrong key rejected; right key ok; /api/rooms 401 without key; files 401 without key; MESH_REQUIRE_KEY=0 disables.
Daemon: link parsing (`#k=`), key persisted, connect with key OK, connect without key → exit 2 with the message, artifacts carry the header, switch_room with keyed link.
