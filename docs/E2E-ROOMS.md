# E2E rooms test

`scripts/e2e-rooms.ts` is an end-to-end test for rooms. It starts real daemons, creates rooms, and checks
join, room keys, messaging, approvals, switch/leave/rejoin, and relay restarts. You can point it at any relay.

## Run it

Local (it starts its own relay on a free port with a random `ROOM_SECRET`):
```
pnpm e2e:rooms                      # root script = tsx scripts/e2e-rooms.ts
pnpm exec tsx scripts/e2e-rooms.ts  # same thing
```

Against a deployed relay (e.g. Railway):
```
pnpm e2e:rooms --relay https://<app>.up.railway.app
```
- Pass the http(s) base URL. The daemons get `wss://` from the room link.
- Check 9 (relay restart) is SKIPPED for a remote relay.
- It creates only 4 rooms via `POST /api/rooms`, so it barely touches room-creation rate limits.
- Daemon names are unique per run: `e2e-a-<rand>` through `e2e-g-<rand>`.

Flags:
| flag | effect |
|---|---|
| `--relay <url>` | use this relay instead of starting a local one |
| `--keep` | keep the temp dirs so you can look at them |
| `--verbose` | print every daemon and relay log at the end |
| `--leave-wait <s>` | how long a daemon that left must stay gone (check 6, default 10) |

Exit code: `0` = everything PASS (SKIP is fine), `1` = any FAIL. On FAIL it prints the logs of the processes involved.

## Isolation

- 6 real daemons (`apps/daemon/src/cli.ts join`). Each gets its own temp `HOME`, its own temp cwd (not a git repo),
  and its own free local port.
- Flags: `--no-register --no-git-offers --no-git-watch --no-codex-wake`.
- `SSH_CONNECTION` is set, so no native OS approval dialog ever pops. `MESH_APPROVE=watcher`, so `ask` requests go to the pending queue.
- It never touches your real `~/.mesh`, `~/.claude`, `~/.codex`, Cursor config, or a daemon on `:7337`.
- It talks to the daemons the way agents do: the local MCP endpoint (`POST http://127.0.0.1:<port>/mcp`) and the HTTP routes `/health` and `/pending`.
- Each daemon's `team.json` offers `echo` (permission `always`) and `uname` (permission `ask`).

## Checks

The output is a PASS/FAIL/SKIP table with timings.

| # | check | what passes |
|---|---|---|
| 1 | health + rooms | relay `/health` is 200; `POST /api/rooms` twice gives two different rooms R1, R2 with keyed links |
| 2 | join + isolation | a and b join R1 by its link and see each other (`GET /api/rooms/R1` members and `list_teammates`); c joins R2 and is not visible in R1 |
| 3 | key gate | `mesh join R1` with no key and with a wrong key exits 2 with a readable room-key message; `GET /api/rooms/R1` without a key is 401 |
| 4 | messaging + approval | `send_message` a→b shows in b's `inbox`; `ask_teammate` a→b `echo` (always) completes with output; `uname` (ask) is parked in b's `GET /pending`, b's `approve_request` approves it, a's `check_job` completes |
| 5 | switch_room | b switches to R2 by its link: gone from R1, visible with c in R2 |
| 6 | leave_room | c calls `leave_room`: gone from R2 presence, its process exits, still gone after ~10 s |
| 7 | rejoin | c joins R2 again with the link: visible again |
| 8 | owner ends the session | fresh room R3: d joins with the owner link (`#k=…&o=…`, `/health` owner true), e and f with the plain link. Non-owner `end_session` is a tool error and `POST /api/rooms/R3/end` without / with a wrong owner token is 403. d's `end_session` makes all three daemons exit within 10 s (e and f exit 0, saved join forgotten); `GET /api/rooms/R3` is 410; a fresh join with the link exits; a second end returns `alreadyEnded`; `POST /api/rooms` still works |
| 9a | relay restart, same secret (local only) | daemons reconnect on their own, presence comes back, old links still work, a message goes through |
| 9b | relay restart, new secret (local only) | the old link is rejected (401, join exits 2); daemons still holding the old key stop with exit 2, as designed |
| 10 | cleanup | every spawned process is killed and temp dirs are removed, also on failure or Ctrl-C |

## Railway checklist

- Set `ROOM_SECRET` on the service. Without it, keys reset on every deploy.
- Run `pnpm e2e:rooms --relay https://<app>.up.railway.app` after each deploy.
- FAIL on 1: the URL or health path is wrong.
- FAIL on 3: keys are not enforced. Check whether `MESH_REQUIRE_KEY=0` is set.

## Troubleshooting

- A daemon doesn't come up: the script prints the tail of its log. Run again with `--verbose` to see every log.
- Need to see a daemon's state after the run: add `--keep` so the temp HOME and cwd dirs are left behind.
- Key details (link format, 401s, exit 2): see `docs/ROOM-KEYS.md`.
