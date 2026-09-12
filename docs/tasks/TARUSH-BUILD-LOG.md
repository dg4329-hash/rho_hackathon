# Tarush Build Log

> Source of truth for Tarush’s building and investigation sessions.
> Path: [`docs/tasks/TARUSH-BUILD-LOG.md`](TARUSH-BUILD-LOG.md) (committed on branch `tarush`).
> Companion checklist: [`docs/tasks/TARUSH.md`](TARUSH.md).
> Last updated: 2026-09-12 (renamed from `.local/BUILD-LOG.md` and pushed)

---

## Who / ownership

You are **Tarush**.

| May edit | Read-only |
|---|---|
| `apps/relay/**` | `apps/daemon/**`, `apps/feed/**` |
| `scripts/**` | `packages/protocol/**` |
| `docs/tasks/TARUSH.md` | `docs/CONTRACT.md` |
| `docs/tasks/TARUSH-BUILD-LOG.md` | Other people’s task files |
| Relay URL line in `docs/PLAN.md` §2 | Root configs except as needed for your deliverables |

Protocol / CONTRACT changes → tell **Dev**. Do not edit them yourself.

---

## Session workflow

1. **Start:** read this file, then `docs/tasks/TARUSH.md`, then `docs/CONTRACT.md` §1 (relay wire protocol).
2. **Work:** only Tarush-owned paths. Small commits, prefix `relay:` / `docs:` / etc. `pnpm typecheck` before push.
3. **End / after investigation:** append under [Evidence & session notes](#evidence--session-notes) — date, what changed, command + output excerpt, blockers, next action. Keep status tables accurate.
4. **Never commit secrets:** `team.json`, `.env`, tokens, `FIGMA_TOKEN`. Keep scratch under `.local/` (gitignored).

---

## Product in 30 seconds

**Pitch:** *Borrow a teammate's machine, not their credentials.*

One teammate’s coding agent can use another teammate’s MCP servers and shell commands **on that person’s laptop**, with a **y/n** approval. Credentials never leave the owner’s machine. The whole room can watch via `mesh feed`.

```
Dev laptop                    Tarush laptop
 Claude/Cursor                  Cursor
   │ MCP :7337                    │ MCP
   ▼                              ▼
 daemon ◄──── WebSocket ────► daemon ── y/n ── spawn / MCP call
   │              │               │
   └──────────► relay ◄───────────┘
                  │
            Abhi: mesh feed
```

- **Relay (you):** dumb WebSocket fan-out. Rooms keyed by string. Last 200 frames for late joiners. No auth — room name is the secret.
- **Daemon (Dev):** `mesh join`, import owner MCP servers, approvals, local MCP at `localhost:7337` with six static tools.
- **Feed (Abhi):** terminal UI + Claude Code hooks.

---

## Monorepo layout

```
apps/relay/          ← YOU — WebSocket relay (IMPLEMENTED locally)
apps/daemon/         ← Dev (stub)
apps/feed/           ← Abhi (stub)
packages/protocol/   ← Dev — shared Zod types (DONE)
scripts/             ← YOU — figma-export.sh, deploy-relay.sh, team.json.starter
hooks/               ← Abhi (README only)
docs/
  CONTRACT.md
  PLAN.md            (relay URL line editable by you)
  tasks/TARUSH.md
  tasks/TARUSH-BUILD-LOG.md   ← this file
team.json.example    committed starter
team.json            local only (gitignored)
.local/              scratch (gitignored): MCP snippets, etc.
```

**Stack:** Node 22+, pnpm 10, TypeScript ESM, `tsx` for dev. Workspaces: `apps/*`, `packages/*`.

**Run relay locally:**

```bash
npx pnpm@10.32.1 install
# (historical: protocol build was required then; since the dev/daemon merge @mesh/protocol exports src/ and has no build script)
npx pnpm@10.32.1 -F relay start            # PORT=8080 default
# or: pnpm -F relay dev
```

---

## Implementation status (as of 2026-09-12)

| Piece | Owner | Status |
|---|---|---|
| `packages/protocol/src/index.ts` | Dev | **Done.** |
| `apps/relay/src/index.ts` | Tarush | **Done.** Verified against CONTRACT §1 (`pnpm -F relay test`, 28 checks) and the real daemon; 5 bugs fixed 2026-09-12 — see `TARUSH-HANDOFF.md`. |
| `apps/relay` validate + soak + test | Tarush | **Done.** `pnpm -F relay validate ./team.json` (from repo root); `pnpm -F relay soak` 80/80; `pnpm -F relay test` 28/28 |
| Deploy public `wss://` | Tarush | **Done via ngrok** — `./scripts/tunnel-relay.sh` prints the session URL; verified with the real daemon over `wss://`. Railway still blocked (no CLI/Docker). |
| `scripts/figma-export.sh` | Tarush | **Written + mock-verified** (both endpoints, PNG, outline); live run pending `FIGMA_TOKEN` |
| Local `team.json` | Tarush | **Created** (gitignored); starter in `scripts/team.json.starter` |
| Cursor MCP | Tarush | Snippet in `.local/cursor-mcp.snippet.json` — merge + add real keys |
| `apps/daemon` | Dev | **Real** on `dev/daemon` (`44d66cf`); S1 `sleep 70` E2E passed through this relay |
| `apps/feed` | Abhi | Stub |
| This build log | Tarush | Was `.local/BUILD-LOG.md`; now committed as this file on `tarush` |

**Critical path left:** Tarush runs `./scripts/tunnel-relay.sh` and shares the URL; live Figma run with a token; real MCP servers on Tarush's laptop (6a).

---

## Ordered work progress

From `docs/tasks/TARUSH.md` + `docs/PLAN.md` §3:

| Step | Status | Notes |
|---|---|---|
| 1. Relay | **DONE** | `apps/relay/src/index.ts`; contract test in `apps/relay/test/` |
| 2. Deploy | **DONE (ngrok)** | `scripts/tunnel-relay.sh`; PLAN §2 points at it; Railway later |
| 6a. MCP + team.json | **PARTIAL** | Local team.json OK; real MCP keys + Dev import TBD |
| 6b. figma-export | **PARTIAL** | Mock-verified; needs `FIGMA_TOKEN` + real frame for the live run |
| S1 long jobs | **DONE** | `ask a "sleep 70 && echo done" --wait 80` → done, exit 0 via relay |
| team.json validate | **DONE** | `pnpm -F relay validate` + starter JSON |

**Definition of done (task file):** not fully met yet (no public relay, no live Figma demo, no 30-min three-laptop session).

---

## Relay implementation traps

- Dumb only: no auth, no DB, no persistence beyond 200-frame history. Room name = secret.
- `hello`: store offers, broadcast `presence`, replay history to joiner — do **not** put `hello` in history or forward it.
- `presence` / `error` are relay-emitted.
- Same HTTP server for `/health` and WS upgrade.
- **Runtime:** `tsx` resolves `@mesh/protocol` to `src/index.ts` (since the dev/daemon merge); no build step before relay start.
- Import `HISTORY_LIMIT`; do not Zod-validate every client frame.
- Do not touch daemon/feed/protocol.

---

## Contract cheat sheet (relay §1)

Connect: `ws://<relay>/?room=<room>&user=<user>&role=daemon|feed`

Relay emits:

```ts
{ type: 'presence', members: Array<{ user, role, offers: Offer[] }> }
{ type: 'error', message: string }
```

Clients send (all have `from`, `ts`): `hello` | `request` | `decision` | `output` | `result` | `event`

Broadcast everything; daemons ignore `request` where `to !== me`. `id` ties request → decision → output* → result.

---

## How to deploy (when auth is ready)

```bash
# Option A — Railway
npx @railway/cli login
./scripts/deploy-relay.sh
# then paste wss://<host> into docs/PLAN.md §2 and team.json "relay"

# Option B — ngrok bridge
ngrok config add-authtoken <token>
ngrok http 8080
# use wss:// URL from ngrok; keep laptop + relay running
```

Health: `curl https://<host>/health` → `{ rooms, connections }`.

---

## Teammate dependencies

| Person | Needs from you | You need from them |
|---|---|---|
| **Dev** | Relay (+ public URL) | Daemon for E2E / S1 / import confirm |
| **Abhi** | Same relay | Nothing for Step 1 |

Branch: **`tarush`** → `origin/tarush`. Public URL still missing.

---

## Don'ts

- No auth, room persistence, or database on the relay.
- Don't edit `apps/daemon`, `apps/feed`, `packages/protocol`, `docs/CONTRACT.md`.
- Don't commit `team.json`, `.env`, or tokens.

---

## Evidence & session notes

### 2026-09-12 — repo survey (first pass)

- Monorepo scaffold in place; protocol complete vs CONTRACT.
- Relay/daemon/feed were stubs.
- Created local build log + Cursor rule under `.local/` / `.cursor/rules/` (rule still gitignored).

### 2026-09-12 — Phase 1–5 execution + git

**Machine / tooling**

- Node v24.13.1; `pnpm` not on PATH → `npx pnpm@10.32.1`.
- Corepack / global pnpm install blocked (EPERM / policy).
- Git Bash: `C:\Program Files\Git\bin\bash.exe`.

**Committed in `a4c32a3`** (`relay: implement room fan-out, health, validate, and deploy scaffolding`)

- `apps/relay/src/index.ts` — full relay
- `apps/relay/src/validate.ts` — `TeamConfig` validator
- `apps/relay/src/soak-s1.ts` — 80-frame output soak
- `apps/relay/package.json` — `validate` script
- `apps/relay/Dockerfile`, `apps/relay/railway.toml`
- `scripts/figma-export.sh`, `scripts/deploy-relay.sh`, `scripts/team.json.starter`, `scripts/README.md`
- `docs/tasks/TARUSH.md` — Evidence section
- `docs/PLAN.md` — pending public relay URL line
- `.gitignore` — `.local/` + local Cursor rule path

**Still local / gitignored (secrets & scratch)**

- `.local/cursor-mcp.snippet.json`
- `.cursor/rules/local-build-log.mdc` (points at this file)
- `team.json` (user=tarush, relay=`ws://localhost:8080`)

**Acceptance excerpts**

```text
# after protocol build + relay start
B received A event: true
C got presence: true
C got history replay: true
OK true

pnpm -F relay validate ../../team.json
OK …\team.json
  user=tarush room=rho
  relay=ws://localhost:8080
  shell offers=2

pnpm -F relay exec tsx src/soak-s1.ts
asker received 80/80 output frames
asker received result: true
late joiner history outputs: 80, result: true
SOAK OK

figma-export.sh: bash -n OK; Usage without args; "FIGMA_TOKEN is not set" with args
```

**Git**

- `a4c32a3` on branch **`tarush`**, pushed to `origin/tarush`.
- `origin/main` did **not** get this commit (push to main was skipped).
- PR: https://github.com/dg4329-hash/rho_hackathon/pull/new/tarush

**Deploy attempts**

- Railway `whoami` → Unauthorized.
- Browserless login offered activate code `JNMG-GZFR` (likely expired if unused).
- ngrok → ERR_NGROK_4018 (no authtoken).
- No public `wss://` yet.

### 2026-09-12 — build log renamed and committed

- Renamed/moved `.local/BUILD-LOG.md` → `docs/tasks/TARUSH-BUILD-LOG.md`.
- Updated header/workflow: this file is now the committed session source of truth.
- Cursor rule updated to read/update this path.
- Pushed on branch `tarush`.

**Blockers (still open)**

1. Railway login + `./scripts/deploy-relay.sh` (or ngrok) → paste `wss://` into PLAN §2 + `team.json`.
2. `FIGMA_TOKEN` + verify against real demo frame.
3. Real stdio MCP keys; confirm import with Dev.
4. Dev daemon for real S1 (`sleep 70` → `check_job`).

**Next action:** Finish Railway/ngrok auth → deploy → update PLAN URL; set FIGMA_TOKEN; ping Dev when daemon is ready.

### 2026-09-12 — Dev's agent: verification, fixes, ngrok launcher

Full record: [`TARUSH-HANDOFF.md`](TARUSH-HANDOFF.md). Summary: relay fixed (presence before hello, replay-on-every-hello, replay/presence order, malformed frames, room history retention, double cleanup); `apps/relay/test/relay.test.ts` added; `validate.ts` resolves from `INIT_CWD`; `scripts/tunnel-relay.sh` added and verified with the real daemon over `wss://`; `figma-export.sh` hardened and mock-verified; `docs/PLAN.md` §2 updated. Open: Railway, `FIGMA_TOKEN` live run, 6a MCP servers, three-laptop soak.

