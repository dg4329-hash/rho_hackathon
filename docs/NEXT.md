# NEXT — from merged `main` to a winning demo

Written 2026-09-12 (Sat evening) against `be35081`. Priority order with rough hours; no dates (slot unknown). Per-person commands and configs: "Next (post-merge)" in `docs/tasks/{DEV,TARUSH,ABHI}.md`.

## Where we are

Everything works on one machine and over ngrok: relay 28/28; daemon 20+30 checks (shell + MCP requests, approve/deny/`never`, timeouts, reconnect); local MCP server driven by a real MCP client through list → describe → ask → check_job; feed and hooks render every frame. Re-verified today on the merged tree: typecheck, all suites, `tunnel-relay.sh` + `mesh join` + `mesh ask` over `wss://` → exit 0. Never happened: three laptops, a real MCP import, hooks from live Claude Code, a live Figma call, a human pressing `n`, a timed rehearsal.

| step | true status |
|---|---|
| 0 protocol | done |
| 1 relay | done; ngrok re-verified on merged tree |
| 2 daemon | done; **never with two humans** |
| 3 local MCP server | done via MCP client; **never from live Claude Code** |
| 3b MCP import | done vs fixture; **no real server** |
| 4 feed | done vs real relay; **never on a third laptop** |
| 5 hooks | done vs `curl`; **never from live Claude Code** |
| 6 real MCPs + Figma | mock-verified; **no token, no keys; Tarush is on Windows** |
| 7 rehearsal | not started |
| S1 / S2 | done in tests; deny never on stage |

## Critical path (~8 h, much parallel)

| # | item | owner | h | acceptance | if skipped |
|---|---|---|---|---|---|
| 0 | **Where does Tarush's owner-daemon run?** `shell.ts:81` spawns `/bin/sh` with a process-group kill; `approval.ts:35` needs a real TTY; his build log shows Git Bash on locked-down Windows. Try WSL2; else the owner role moves to a Mac. | Tarush, Dev | 0.5 | On the stage terminal, local relay: `join t --as tarush`, then `ask tarush "echo hi"` from another terminal. Expect `[y/n]`, `y` → `hi`, `exit 0`. `no tty` / `spawn error` = not the stage machine. | Every `y` auto-denies. |
| 1 | **Three-laptop test over ngrok.** Tarush: `pkill -x ngrok; ./scripts/tunnel-relay.sh`, posts `wss://<host>`. All: `date -u` within 20 s. Dev and Tarush join `rho-1` with `--relay wss://<host> --config /abs/team.json`; Abhi runs the feed; Dev `ask tarush "echo hi"`. | all | 1 | Tarush sees `⚡ dev wants to run: echo hi … [y/n]`; `y`; Dev prints `hi`, `← exit 0`; feed: `dev ──▶ tarush $ echo hi`, `✅ approved`, `▏ hi`, `✔ exit 0`; `/health` → `connections: 3`. Second ask, `n` → `denied: owner declined`. Stay joined 30 min. | Nothing later is trustworthy. |
| 2 | **Dev's Claude Code in a demo repo** (small app with `src/onboarding/Step1.tsx`): `claude mcp add --transport http mesh http://localhost:7337/mcp`, `hooks/install.sh .`, a `CLAUDE.md` line saying Figma/Supabase aren't directly accessible — use the `mesh` tools. Dev's `team.json`: `"import": { "servers": [] }` (else it imports `mobbin`/`posthog` and its own `mesh` entry). | Dev | 1 | Fresh `claude`: `/mcp` shows `mesh ✔`. Demo prompt *"Implement onboarding step 2 to match the Figma frame Onboarding/Step 2."* in 3 fresh sessions → `list_teammates → describe_capability → ask_teammate` unprompted **3/3**; feed `💬 prompt:` < 2 s. | Agent invents Step 2 over an empty feed. |
| 3 | **Tarush's real MCP servers**: Supabase `npx -y @supabase/mcp-server-supabase@latest --read-only --project-ref=<ref>` (env `SUPABASE_ACCESS_TOKEN`); GitHub `npx -y @modelcontextprotocol/server-github` (env `GITHUB_PERSONAL_ACCESS_TOKEN`). JSON, `permissions`, `notes` verbatim in TARUSH.md Next #3 (reads `always`; `execute_sql`/`create_*` `ask`; `apply_migration`/`delete_*` `never`). Linear is OAuth-only: skip. Run each `npx` once to cache. | Tarush | 2 | Banner `imported 2 servers, N tools (supabase n, github m)`; presence `● tarush supabase(n) github(m) figma.export vercel.deploy`. Dev's Claude Code: *"describe tarush's supabase.list_tables and call it"* → real table names; feed `⚡ auto-approved`. `execute_sql` → `[y/n]`; `apply_migration` → denied, no prompt. | "Universal via MCP import" is a slide. |
| 4 | **Figma live + fallback.** Figma frame `Onboarding / Step 2` (~8 layers); `FIGMA_TOKEN`; `./scripts/figma-export.sh <fileKey> <nodeId>`; both ids into `notes["figma.*"]`. Fallback: Tarush adds `FIGMA_FIXTURE=<file>` to the script (if set, `cat` it, exit 0); Abhi commits real output as `docs/fixtures/step2.txt`. | Tarush, Abhi | 1 | Outline in < 5 s. Dev's demo prompt ends in `ask_teammate` carrying `./scripts/figma-export.sh <key> <id>`; outline in Dev's tool result. `FIGMA_FIXTURE=docs/fixtures/step2.txt ./scripts/figma-export.sh x y` prints it offline. | Headline beat has no output. |
| 5 | **Hooks from live Claude Code**, Dev's demo repo + Abhi's clone. | Abhi, Dev | 1 | Prompt → `💬 prompt:` < 2 s by stopwatch; `Edit` → `📁 file:`; Abhi's next prompt transcript (`ctrl-o`) shows `Team activity (last 10 min):` with Dev's lines — screenshot it. | Awareness beat is a spoken claim. |
| 6 | **Deny beat.** Tarush adds offer `vercel.deploy` (`command: vercel`, `ask`). Dev's second prompt: *"Ship onboarding step 2 to production."* | Dev, Tarush | 0.5 | Feed `dev ──▶ tarush $ vercel --prod`; `n`; `❌ denied (owner declined)`; exactly one `ask_teammate` in the transcript; agent reports the denial. | The signature beat shows nothing. |
| 7 | **Rehearsal ×2, timed, on the projector; run 2 on a phone hotspot.** New room each run. | all | 1.5 | Two consecutive clean runs of DEMO.md §1 ≤ 3:00; timings filled; `sample-frames.jsonl` regenerated from run 2. | Breaks on stage. |

## Demo-hardening

- **Projector**: feed ≥ 24 pt, dark theme, ≥ 100 columns. `chalk.dim` output/timestamps vanish on cheap projectors — Abhi checks on the real screen, swaps `dim` for light gray if needed. `FORCE_COLOR=3`; notifications off.
- **Tarush's side screen**: daemon alone in a 20 pt terminal so `[y/n]` is always the last line.
- **Pre-warm (T-15)**: tunnel up, daemons joined, feed shows both, `npx` servers cached, `figma-export.sh` run once, Claude Code open with `/mcp` connected, one `ask tarush "echo warm"` completed.
- **Reset the room**: the relay replays 200 frames to every joiner — **never reuse a room name**. Kill daemons + feed, rejoin as `rho-<n>`, `/health` → `connections: 3`. Don't restart the tunnel.
- **ngrok**: URL was stable across three launches today; claim the free static domain and launch with `NGROK_DOMAIN=…`. Always `pkill -x ngrok` first — a stale ngrok makes the script print a URL then die (`ERR_NGROK_334`, reproduced today). If it changes anyway: paste in chat, everyone rejoins with `--relay` (~60 s).
- **Machines and network**: `caffeinate -dims` / never-sleep on AC, chargers in. Venue Wi-Fi may block WebSockets → all three on one phone hotspot (rehearsal 2 proves it); `curl https://<host>/health` from each laptop on arrival. `date -u` on all three: requests older than 30 s by the *sender's* clock are dropped silently.

## Pitch (90 s, Abhi)

"Every coding agent here is single-player: my tools, my keys, my laptop. But the team owns far more than any one of us. Dev's agent has no Figma; Tarush's does. Today the fix is Slack.

*(Dev types; feed fills)* Dev's agent hits the wall, looks around the room, finds Tarush's Figma export and Tarush's notes, and asks — with a reason. Tarush sees exactly what will run and presses **y**. It runs on *his* laptop with *his* token; the output lands in Dev's agent. The token never moved.

*(deny)* Now the part nobody else does. Dev's agent wants to ship to prod. Tarush presses **n**. Dev's agent gets a clean 'denied', tells Dev, moves on. Credentials never moved; every request needed a yes.

Superconductor, Cursor cloud, AQ put your team in a hosted sandbox with a shared vault. We connect the laptops you already use — no sandbox, no vault, no new IDE. Capabilities, not credentials. Borrow a teammate's machine, not their credentials."

**Judge Q&A** (full set in DEMO.md §3):
1. *Isn't this SSH?* SSH hands a session every credential on the box; this hands an agent one bounded command, with a reason, and the owner says yes or no each time.
2. *Superconductor / Cursor pools?* They centralize — sandbox plus vault, or any worker takes any job. We're peer-to-peer and owner-approved.
3. *Anthropic cross-session messaging?* Same account only, and a message can never trigger execution. We're cross-person, cross-harness; execution is the point.
4. *`sh -c` on a teammate's machine?* The approval prompt is the guard, `never` blocks classes, offers pin to scripts, the room sees everything.
5. *What's next?* Expiring scoped grants, a per-room audit log, file-claim warnings before an agent edits.

**Honest-limitations slide**: room name is the only auth · shell offers are `sh -c` (approval is the guard) · OAuth-only MCPs (Linear, official Figma) can't be imported — shell offer instead · owner's laptop must be online and attended · no persistence.

## Stretch — only after item 7 passes twice

1. **Railway deploy** (Tarush, 1 h) from GitHub with Railway's Dockerfile builder (no local Docker). Kills the "laptop + ngrok must survive" risk. Accept: item 1 re-run against the Railway host.
2. **File-claim warning in the prompt hook** (Abhi, 1 h): `emit.js` prefixes `⚠ tarush's agent touched src/auth.ts 3 min ago` when another user's `file_touched` is in the activity block. Cheapest proof of RESEARCH.md Claim C.
3. **`npx mesh` packaging** (Dev, 2 h): the close says "one npx per laptop"; today it's a pnpm monorepo. Accept: `npx <pkg> join …` from an empty dir. Otherwise say "one command per laptop".

Not S3: decision §6 — the CLI feed is the UI.

## Risks register

| # | risk | L / I | mitigation | owner |
|---|---|---|---|---|
| 1 | Tarush's Windows laptop can't host the owner daemon (`/bin/sh`, mintty → `no tty` auto-deny) | H / H | Item 0 in hour one: WSL2, else a Mac | Tarush |
| 2 | Dev's agent doesn't reach for mesh unprompted | M / H | CLAUDE.md nudge, 3/3 test; explicit prompt; `mesh ask` CLI last | Dev |
| 3 | Network: venue blocks WS, stale ngrok, URL change, sleep | M / H | hotspot rehearsal, `pkill -x ngrok`, `NGROK_DOMAIN`, `caffeinate` | Tarush |
| 4 | Figma live path (token, node id, latency) | M / M | verified once live; `FIGMA_FIXTURE` | Tarush, Abhi |
| 5 | Silent drops: reused room replays old frames; clock skew > 30 s | L / H | new room per run; `date -u`; `MESH_DEBUG=1` in rehearsal 1 | Abhi |
| 6 | Real MCP servers fail on stage (npx download, PAT expiry) | M / M | pre-warm `npx`, join at T-15; drop the Supabase beat first | Tarush |

## Found while reading (not fixed; owners decide)

1. `apps/daemon/src/shell.ts:81-85` hardcodes `/bin/sh`, `detached`, `process.kill(-pid)`; `approval.ts:35` needs a stdin+stdout TTY. Not Windows-compatible.
2. `apps/daemon/src/core.ts:151-153` compares sender `ts` to the local clock; a receiver > 30 s ahead silently ignores every request.
3. `apps/daemon/src/config.ts:20-24`: `pnpm -F daemon start … --config ./team.json` resolves against `apps/daemon/` (verified today); README "reads ./team.json" misleads. `apps/daemon/src/mcp-import.ts:99-112` doesn't exclude the daemon's own `mesh` entry that `claude mcp add` writes to `~/.claude.json`.
4. `docs/DEMO.md` 1:55 "types reason `not mid-sprint`": `approval.ts` reads one keypress; reason is always `owner declined` (fixture too).
5. `docs/DEMO.md` §2 Figma row: swapping the offer command to `cat …` breaks `matchShellOffer` (`shell.ts:31-38`, basename `cat` ≠ `figma-export.sh`); `docs/fixtures/step2.txt` doesn't exist.
6. `docs/DEMO.md` §2 "Railway down": there is no Railway. 2:25 "Tarush's agent's context": Tarush is on Cursor, no hooks — say Abhi's. 1:05: only the outline returns; the PNG stays on Tarush's laptop.
7. `scripts/tunnel-relay.sh:80-90` reads `:4040/api/tunnels` without checking its own ngrok owns it; with a stale ngrok it printed a URL then exited `ERR_NGROK_334` (reproduced today). `docs/PLAN.md` §2 "URL changes every launch": stable across three launches today.
