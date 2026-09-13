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

## Owner token (End session)
- `ownerToken = base32lower(HMAC-SHA256(ROOM_SECRET, "owner:" + room))[:16]` — same alphabet/length as a key, never equal to it
  (room names can't contain `:`). Never stored; verified timing-safe.
- Only `POST /api/rooms` returns it: `201 { room, key, link, ownerToken, ownerLink }`, `ownerLink = <origin>/r/<room>#k=<key>&o=<ownerToken>`.
  The shareable `link` never has `o=`; `GET /api/rooms/:room` never returns it.
- Landing "Start a session" redirects the creator to the owner link. The room page stores `o=` in `localStorage` `mesh.owner.<room>`,
  scrubs it from the address bar (`history.replaceState` → `#k=<key>`), adds `--owner <token>` to the creator's commands
  (`/join.cmd` / `/join.command` accept `&owner=`; `install.sh` / `install.ps1` pass extra args through to `mesh join`),
  and shows an owner-only, two-step "End session for everyone" button.
- `POST /api/rooms/:room/end` — key via `?key=` / `x-mesh-key` (401 `{ error }`), owner token via `x-mesh-owner` or body `{ owner }`,
  optional body `{ by?, reason? }` (`by` must match `^[a-z0-9_-]{1,32}$`, `reason` ≤ 140 chars). Bad room → 400.
  Missing/wrong owner token → 403 `{ error: "only the person who started this session can end it" }` — required even with `MESH_REQUIRE_KEY=0`.
  → 200 `{ ok: true, room, ended: true, closed }`; already ended → 200 `{ ok: true, room, ended: true, closed: 0, alreadyEnded: true }`.
- On end the relay sends `{ type: "room_ended", room, by?, message, ts }` (`message` = `"<by or 'the host'> ended the session[: reason]"`)
  to every socket, closes each with **4410** (reason = message), forgets the room's history and artifacts, and tombstones the name
  for `MESH_ENDED_TTL_MS` (default 24 h).
- Tombstoned room: WS connect (after the key check) → `error` frame + close 4410 `"this session was ended by its owner"`;
  `GET /api/rooms/:room` and `/api/files/:room…` → 410 `{ error, ended: true }`; `POST /api/rooms` never reissues the name.
  `GET /health` adds `endedRooms`.
- A relay restart forgets tombstones (keys are stateless). Daemons forget their saved join on end, so nothing auto-reconnects;
  an old link typed in by hand after a restart would open an empty room with that name.
- Overlay: shows "end session" when the daemon's `/health` says `owner: true` (POST `localhost:<port>/end`); stops polling the relay on 410.

## Tests
Relay: create → key derivation deterministic under a fixed ROOM_SECRET; ws without key rejected 4401; wrong key rejected; right key ok; /api/rooms 401 without key; files 401 without key; MESH_REQUIRE_KEY=0 disables.
Daemon: link parsing (`#k=`), key persisted, connect with key OK, connect without key → exit 2 with the message, artifacts carry the header, switch_room with keyed link.
