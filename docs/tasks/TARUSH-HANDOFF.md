# Tarush handoff — verified status of branch `tarush` (2026-09-12)

Written by Dev's agent after Tarush's agent stalled. Everything below was re-run from scratch in a
worktree of `origin/tarush`, against the **real daemon** on `dev/daemon` (not the fake relay, not
Tarush's claims). Commands and excerpts are verbatim.

## Status per deliverable (docs/tasks/TARUSH.md)

| Deliverable | Status | Evidence (verified here) |
|---|---|---|
| 1. `apps/relay` (step 1) | **Done** (was partial — 5 contract/robustness bugs fixed, see below) | `pnpm -F relay test` 28/28 PASS locally and over `wss://` ngrok; real-daemon E2E `ask a "echo relay-ok"` → `relay-ok`, exit 0 |
| 2. Deploy public `wss://` | **Done via ngrok** (Railway blocked: no `railway` CLI, no Docker on this machine) | `./scripts/tunnel-relay.sh` prints `wss://<host>.ngrok-free.dev`; `/health` 200 through tunnel; daemon `ask … --relay wss://…` → exit 0 |
| 3. `scripts/figma-export.sh` (6b) | **Written + dry-verified; live run pending `FIGMA_TOKEN`** | `bash -n` ok; run against a local mock of both Figma endpoints: correct URLs, token header, PNG written, outline printed |
| 4. S1 long jobs | **Done** (relay side) | `ask a "sleep 70 && echo done" --wait 80` → `done`, `exit 0 in 70010 ms` through the relay; ping keepalive did not drop the idle daemon |
| 5. `team.json` starter + `pnpm -F relay validate` | **Done** (validate fixed to resolve paths from where you run it) | `pnpm -F relay validate <path>` prints user/room/relay/offers/import; starter parses |
| 6a. Real MCP servers on Tarush's laptop | **Not started** (requires Tarush's machine + keys) | Only a filesystem snippet in gitignored `.local/` — nothing verifiable from here |
| 30-min three-laptop session | **Not started** | Needs the team; tunnel launcher is ready for it |

## Contract deviations found in `apps/relay/src/index.ts` (line numbers = commit `a4c32a3`)

| Where | Problem | Fix |
|---|---|---|
| L42-49 `presencePayload` | Listed every connection, including ones that had **not sent `hello` yet** (empty `offers`). The daemon's `members()` / `findOffer()` read presence; a member could appear with no offers mid-handshake (race the daemon's own `fake-relay.ts` avoids by filtering `helloed`). | Presence lists only `helloed` conns. |
| L110-118 hello handler | Replayed history on **every** `hello`, not just the first (spec: "on first hello") → a client re-sending hello (the daemon does on reconnect with a fresh socket, but any client could on the same socket) got the ring buffer twice. | `helloed` flag; replay only on first hello. |
| L110-118 hello handler | Sent `presence` **before** the replay, so the newest frame a joiner saw was older than the presence it already had. `fake-relay.ts` replays first, then presence. | Replay history, then broadcast presence. |
| L120-134 message handler | Non-JSON frames were pushed into the 200-frame history and fanned out. Daemon ignores them, but they consume ring-buffer slots. | Drop with an `error` frame to the sender only. |
| L139-143 `cleanup` | Deleted the room (and its history) as soon as the last connection left. If the only daemon restarts, the late-joiner replay is empty. | Keep history; prune a room only when it has no conns **and** no history. `/health.rooms` counts rooms with live conns. |
| L147-153 error handler | Called `ws.close()` (graceful handshake) on an errored socket; may never complete. | `ws.terminate()` + idempotent cleanup. |
| L157-173 ping loop | Terminated the socket **and** removed/broadcast itself, then the `close` handler ran cleanup again (double `presence`). | Ping loop only terminates; `close` handler does the single cleanup. |
| L88-92 bad params | Error frame + `close()` with default code. | Same, with code `1008` + reason. Behaviour already contract-correct. |

Already correct in his version (verified by the test): verbatim fan-out to every *other* conn, no echo to sender, `hello` never forwarded or stored, 200-frame cap in order, presence on leave, 25 s ping with dead-socket termination, `GET /health` on the same port, rooms isolated.

Other fixes:
- `apps/relay/src/validate.ts` L10 resolved the path against `process.cwd()`, which pnpm sets to `apps/relay` — so `pnpm -F relay validate ./team.json` from the repo root looked for `apps/relay/team.json` (that is why his evidence uses `../../team.json`). Now resolves against `INIT_CWD`. Also prints offers/import summary and warns on the `REPLACE_WITH…` placeholder.
- `apps/relay/src/soak-s1.ts`: runs as written (`pnpm -F relay soak`, `RELAY_URL` honoured) — verified over the tunnel: `asker received 80/80 output frames`, `late joiner history outputs: 80`, `SOAK OK`.
- New `apps/relay/test/relay.test.ts` (`pnpm -F relay test`): 28 checks covering every §1 bullet; spawns the relay on a free port, or targets `RELAY_URL`. Tarush's original relay fails exactly 5 of them (the first four rows above plus "malformed frame not forwarded").

## Real-daemon E2E (daemon from `dev/daemon` at `44d66cf`, relay from this branch on :8090)

Scratch config (`import` disabled, `echo`/`sleep` offers `always`), daemon `a` joined with
`pnpm -F daemon start join verify --as a --config … --port 7411`:

```
mesh a@verify  offers=2  mcp=http://localhost:7411/mcp
● connected to ws://localhost:8090 room=verify as a
```

```
$ pnpm -F daemon start ask a "echo relay-ok" --why test --room verify --as b --relay ws://localhost:8090
→ a: echo relay-ok
relay-ok
← exit 0 in 3 ms
EXIT=0
```

Late joiner (feed role, after two asks), presence, leave, isolation — from a raw `ws` client:

```
late joiner received 9 frames: ["request","decision","output","result","request","decision","output","result","presence"]
replay sample: [{"type":"request","from":"b","command":"echo relay-ok"},{"type":"decision","from":"a"},{"type":"output","from":"a","chunk":"relay-ok\n"},{"type":"result","from":"a","tail":"relay-ok\n"}]
presence lists a with offers: echo:always,sleep:always
other-room replayed frames: 0 presence: z
leak into verify room: false
presence after tmp joined: a,late,tmp
presence after tmp left: a,late
```

S1 long job (relay must not drop/reorder; keepalive must not kill the idle owner):

```
$ pnpm -F daemon start ask a "sleep 70 && echo done" --why s1 --room verify --as b --relay ws://localhost:8090 --wait 80
→ a: sleep 70 && echo done
done
← exit 0 in 70010 ms
EXIT=0            (daemon a log: ⚡ b › sleep 70 && echo done (auto-approved) … ✔ exit 0 in 70010 ms)
```

## Public URL (ngrok)

```
$ ngrok http 8090 …  → https://gap-masses-sureness.ngrok-free.dev   (from 127.0.0.1:4040/api/tunnels)
$ curl https://gap-masses-sureness.ngrok-free.dev/health   → {"rooms":1,"connections":1} [http 200]
$ pnpm -F daemon start ask a "echo relay-ok-via-wss" --room verify --as b --relay wss://gap-masses-sureness.ngrok-free.dev
relay-ok-via-wss
← exit 0 in 6 ms      EXIT=0
$ RELAY_URL=wss://gap-masses-sureness.ngrok-free.dev pnpm -F relay test   → PASS (28/28)
```

That hostname is per-launch on the free plan — **do not paste it into docs**. `scripts/tunnel-relay.sh`
starts relay + ngrok and prints the session's URL; `docs/PLAN.md` §2 now says so. Both were stopped
after verification.

## Figma script — dry review (no `FIGMA_TOKEN` on this machine)

Endpoints match the Figma REST docs and TARUSH.md: `GET /v1/images/:key?ids=&format=png&scale=2` → image
URL → download; `GET /v1/files/:key/nodes?ids=` → walk `document.children`. Verified with a local mock
API (`FIGMA_API_BASE` override):

```
GET /v1/images/KEY123?ids=1%3A2&format=png&scale=2 token=secret-tok
GET /render.png token=-                      ← token correctly NOT sent to the S3 image host
GET /v1/files/KEY123/nodes?ids=1%3A2 token=secret-tok
PNG: …/mesh-figma-1_2.png                    (file: PNG image data, 1 x 1)
Frame: Onboarding / Welcome (FRAME) 390x844  file: Demo File
- Onboarding / Welcome (FRAME) [0,0 390x844] — fill #ffffff | vertical gap 16
  - Title (TEXT) [24,80 342x40] — "Welcome to Mesh Borrow a laptop" | Inter 700 28px | fill #1a1a1a
  - CTA (RECTANGLE) [24,700 342x52] — fill #3366ff @90% | r12
    - Label (TEXT) [150,716 90x20] — "Get started" | Inter 600 16px
```

Fixes vs. his version: `curl -f`/`-fL` so an HTTP error no longer writes an error body as the PNG; clear
message with instructions when `FIGMA_TOKEN` is unset; accepts URL-style `12-34` node ids; positions are
relative to the frame (CSS-ready); prints font family/weight/size, solid fill hex + opacity, corner
radius, auto-layout direction/gap; skips `visible:false` nodes; `FIGMA_MAX_DEPTH` (default 8) caps the
outline. **Live run against the real demo frame is still pending a token** — that is the single
remaining risk for the headline demo.

## Still blocked / not done

1. **Railway deploy** — no `railway` CLI / Docker here. ngrok launcher is the stop-gap; free-plan URL rotates per launch and the laptop must stay on.
2. **Figma live run** — needs `FIGMA_TOKEN` + the real `fileKey`/`nodeId`. Then: `./scripts/figma-export.sh <key> <node>` and paste the outline under Evidence in TARUSH.md.
3. **6a real MCP servers** — only possible on Tarush's laptop (`~/.claude.json` / `.cursor/mcp.json` with keys), then `mesh join` to confirm import; the daemon on `dev/daemon` supports it.
4. **Three-laptop 30-minute soak** — needs the team on the tunnel URL.

## How to run what's here

```bash
pnpm install && pnpm -F @mesh/protocol build
pnpm -F relay test                      # contract acceptance (28 checks)
./scripts/tunnel-relay.sh               # public wss:// for the session (Ctrl-C stops both)
pnpm -F relay validate ./team.json      # from the repo root
```
