# NEXT — from `main` to a winning demo


## Where we are

**End session (new):** the person who started a room (holds the owner link `#k=…&o=…`) can end it for everyone from the room page, the overlay, `end_session`, or `mesh end`: every daemon answers in-flight requests, forgets its saved join and exits; the link stops working (relay tombstone, 24 h, forgotten on relay restart). Suites: relay `end.test.ts`, daemon `end.test.ts`, e2e check 8. Railway cost: enable Serverless so an idle relay sleeps (README "Railway cost").

Cross-laptop is proven over the public relay (ngrok on Dev's Mac): Mac↔Mac and Mac↔Windows. **Windows is no longer an unknown**: the PowerShell one-liner, the Windows approval dialog and the message-box notification are verified on Tarush's real box. A fresh laptop joins with one command (or a downloaded `mesh-join-<room>.cmd` / `.command`), no clone, no `team.json`: handle from git, MCP servers imported at `ask`, daemon in the background; re-running the installer updates and stops + restarts a running daemon. Claude Code users get the **plugin auto-installed** from `<relay>/plugin.tgz` during `mesh join` (MCP server + hooks + in-session watcher, no extra commands); the watcher forwards teammate messages live. Codex (codex-cli 0.154) and Cursor are registered by `mesh join`. Chained commands (`echo hi; rm …`) never inherit an offer's `always` (found live on Tarush's machine, fixed). Dev's Mac offers Playwright (24 tools) + filesystem (14) through MCP import. Room page is written for beginners (pick a name → paste one command → restart once → "check it worked"). Suites: relay 28/28, daemon 20 + 30 + pending checks, typecheck green.

**Shipping tonight** (being built now; documented as the default experience, not yet verified cross-laptop):
- **Overlay** — "Pop out overlay" on the room page opens a small always-on-top window (Chrome/Edge Document Picture-in-Picture; popup fallback): pending requests with Approve/Deny, teammate messages with a reply box, live feed. While it is open the daemon routes approvals to it instead of the modal OS dialog; 120 s without an answer → OS dialog as fallback. The universal, non-interrupting approval path for Codex, Cursor and Claude Code owners alike. Contract: `docs/OVERLAY-API.md`.
- **`wait_for_events`** MCP tool — Codex/Cursor agents block until the next teammate message or pending request (`{ timeoutSeconds?: 60 }` → `{ messages, pending }`); it never approves. Demo line: *"Codex, watch mesh for the next 10 minutes."* Ten tools total.

Never happened: a live Figma call (Tarush's `FIGMA_TOKEN` / `FIGMA_FILE_KEY` still unset); a keyed MCP server (Supabase/GitHub) borrowed; a Codex tool call (no login); the overlay or `wait_for_events` answering a real cross-laptop request; the plugin's in-session approve on a fresh interactive session 3/3; three laptops at once; the feed on a projector; a timed rehearsal; Railway.

| step | true status |
|---|---|
| 0 protocol | done (10 tools, `message` event, `PendingRequest`) |
| 1 relay | done; front door + beginner room page + installers + `.cmd`/`.command` + `/plugin.tgz`; public via ngrok; **overlay page shipping tonight**; **Railway not done** |
| 2 daemon | done; cross-laptop Mac↔Mac, Mac↔Windows; **Windows dialog + message box verified on real Windows**; compound-command guard |
| 2b one-command install / zero-config / auto-register / background | done macOS + Windows PowerShell; installers stop + restart; plugin auto-install |
| 3 local MCP server | done from live Claude Code; **`wait_for_events` shipping tonight**; **Codex calls not exercised** |
| 3b MCP import | done vs real configs (Dev: playwright 24 + files 14); **no keyed server borrowed yet**; OAuth remotes skipped by design |
| 3c messages | done both ways; live in Claude Code (watcher); overlay reply box + `wait_for_events` tonight |
| 4 feed / room page | done vs real relay; **never on the projector** |
| 5 hooks | done, shipped by the plugin (or merged by `mesh join`); **prompt → feed not timed on two laptops** |
| 6 real MCPs + Figma | `figma-export.sh` by name dry-verified; **no live token run, no keys** |
| 7 rehearsal | not started |
| S1 / S2 | done in tests; deny never on stage |
| P plugin | on main, auto-installed; watcher + `approve_request` verified headless; **interactive 3/3 pending** |
| O overlay | **shipping tonight** — the demo's approval surface |
| W `wait_for_events` | **shipping tonight** — the "Codex, watch mesh" beat |

## Critical path (~5 h, much parallel)

| # | item | owner | h | acceptance | if skipped |
|---|---|---|---|---|---|
| 1 | **Overlay end to end.** Tarush: room page → **Pop out overlay** (Chrome/Edge), daemon port 7337. Dev: `ask tarush "echo hi"` from a Mac. | Dev (build), Tarush (verify) | 1 | Request card appears in < 2 s with command + `why`; **Approve** → Dev prints `hi`, `exit 0`; **Deny** → `denied: owner declined`; close the overlay, ask again → OS dialog appears (Windows MessageBox); a `send_message` from Dev shows in the overlay, reply box sends back. Works on Tarush's Windows box, not just Dev's Mac. | Tarush approves in the OS dialog (verified). Fine, just modal. |
| 2 | **`wait_for_events` from Codex.** Tarush (or Dev, second laptop) in Codex: *"Codex, watch mesh for the next 10 minutes."* Dev sends a message, then an `echo hi` request. | Dev | 0.5 | Codex loops on `wait_for_events`, prints the message and reports the pending request as information; it does **not** approve; Tarush approves in the overlay; Codex sees the result via the feed. | Beat 2:32 in DEMO.md is cut; Codex stays "registered, not shown". |
| 3 | **Figma live, by name.** Tarush: `export FIGMA_TOKEN=… FIGMA_FILE_KEY=…` in the shell that runs the daemon (PowerShell: `$env:`); `./scripts/figma-export.sh list`, then `"Onboarding/Step 2"`. Shell offer `figma.export` in his `team.json`. **Still blocked on Tarush setting the two variables.** | Tarush | 0.5 | `list` prints the frames; export by name prints `PNG: …` + outline in < 5 s; after re-join, presence shows `figma.export`; Dev's `describe_capability` shows the note. | Headline beat has no real output. |
| 4 | **Dev's Claude Code in a demo repo** (small app with `src/onboarding/Step1.tsx`): run `mesh join` **inside that repo** so the plugin (project scope) lands there; `CLAUDE.md` line saying Figma/Supabase aren't directly accessible — use the `mesh` tools. | Dev | 1 | Fresh `claude`: `/mcp` shows the plugin's mesh tools. Demo prompt *"Implement onboarding step 2 to match the Figma frame Onboarding/Step 2."* in 3 fresh sessions → `list_teammates → describe_capability → ask_teammate` unprompted **3/3**, carrying `figma-export.sh "Onboarding/Step 2"`; feed `💬 prompt:` < 2 s. Same session: a teammate's request interjects and **1** approves (plugin 3/3). | Agent invents Step 2 over an empty feed. |
| 5 | **Tarush's keyed MCP server**: Supabase `npx -y @supabase/mcp-server-supabase@latest --read-only --project-ref=<ref>` (env `SUPABASE_ACCESS_TOKEN`) in `~/.claude.json` or `.cursor/mcp.json`. `permissions`: reads `always`, `execute_sql` `ask`, `apply_migration` `never`; `notes` with table names. Run `npx` once to cache. | Tarush | 1.5 | Join banner `imported 1 servers, N tools (supabase N)`; Dev's Claude Code: *"describe tarush's supabase.list_tables and call it"* → real table names, feed `⚡ auto-approved`; `execute_sql` → overlay card; `apply_migration` → denied, no card. | "Universal via MCP import" is a slide, not a beat. |
| 6 | **Deny beat.** Tarush adds offer `vercel.deploy` (`command: vercel`, `ask`). Dev's second prompt: *"Ship onboarding step 2 to production."* | Dev, Tarush | 0.5 | Feed `dev ──▶ tarush $ vercel --prod`; Tarush clicks **Deny** in the overlay; `❌ denied (owner declined)`; exactly one `ask_teammate` in the transcript; agent reports the denial. | The signature beat shows nothing. |
| 7 | **Railway** (dashboard, no CLI): New Project → Deploy from GitHub → `dg4329-hash/rho_hackathon` → Generate Domain. Kills the "Dev's laptop + ngrok must survive" risk and the ngrok interstitial. The Dockerfile must produce `/plugin.tgz` too (relay builds it from `plugin/` at start). | Dev | 0.5 | `https://<railway-host>/health` → JSON; `/plugin.tgz` 200; one-liner from that host joins a room; item 1 re-run against it (overlay CORS origin = Railway host). Until then: ngrok, `pkill -x ngrok` before every launch. | Demo depends on Dev's Mac staying up and on venue Wi-Fi reaching ngrok. |
| 8 | **Three-laptop run + hooks timing + feed on the projector.** New room. Abhi: feed at ≥ 24 pt (or the room page in a browser). Dev: prompt typed → stopwatch. Tarush: overlay open on the side screen. | all | 1 | `/health` → `connections ≥ 3`; feed shows `dev ──▶ tarush …`, `✅ approved`, `▏ …`, `✔ exit 0`; prompt → `💬 prompt:` < 2 s; Abhi's next prompt transcript shows `Team activity (last 10 min):` with Dev's lines. Stay joined 30 min; overlay stays connected throughout. | Awareness beat is a spoken claim. |
| 9 | **Rehearsal ×2, timed, on the projector; run 2 on a phone hotspot.** New room each run. | all | 1.5 | Two consecutive clean runs of DEMO.md §1 ≤ 3:00; timings filled; `sample-frames.jsonl` regenerated from run 2. | Breaks on stage. |

## Demo-hardening

- **Projector**: feed ≥ 24 pt, dark theme, ≥ 100 columns, or the room page `https://<host>/r/<room>` in a browser at 150 %. `chalk.dim` lines vanish on cheap projectors — Abhi checks on the real screen. `FORCE_COLOR=3`.
- **Tarush's side screen**: the overlay is the beat. Chrome or Edge (Document PiP; other browsers get a plain popup that can hide behind windows). Nothing in front of it; daemon `✓` and relay `✓` in its footer; sound toggle off. Notifications on; Do Not Disturb off (the OS dialog is the fallback).
- **Pre-warm (T-15)**: tunnel (or Railway) up, both daemons joined (`mesh status` on each), overlay open on Tarush's box, feed shows both, `npx` servers cached, `figma-export.sh "Onboarding/Step 2"` run once, Claude Code open with `/mcp` connected, one `ask tarush "echo warm"` approved through the overlay, Codex told to watch mesh (if beat 2:32 is in).
- **Reset the room**: the relay replays 200 frames to every joiner — **never reuse a room name**. `mesh stop` on both, rejoin `rho-<n>` (one-liner or `join`), reopen the overlay from the new room page, `/health` → `connections ≥ 3`. Don't restart the tunnel.
- **ngrok**: hostname has been stable for this account; `NGROK_DOMAIN=…` pins it. Always `pkill -x ngrok` first — a stale ngrok makes the script print a URL then die (`ERR_NGROK_334`). If it changes anyway: everyone re-runs the one-liner from the new room page (~60 s) and reopens the overlay.
- **Machines and network**: `caffeinate -dims` / never-sleep on AC, chargers in. Venue Wi-Fi may block WebSockets → all three on one phone hotspot (rehearsal 2 proves it); `curl https://<host>/health` from each laptop on arrival. `date -u` on all three: requests older than 30 s by the *sender's* clock are dropped.
- **Timeouts**: overlay open → 120 s to answer, then the OS dialog gets 90 s more. Overlay closed → dialog only, 90 s. A silence ends as `owner did not answer in 90 s`; Dev's agent reports it; re-prompt.

## Pitch (90 s, Abhi)

"Every coding agent here is single-player: my tools, my keys, my laptop. But the team owns far more than any one of us. Dev's agent has no Figma; Tarush's does. Today the fix is Slack.

*(Dev types; feed fills)* Dev's agent hits the wall, looks around the room, finds Tarush's Figma export and Tarush's notes, and asks — with a reason. A small window on Tarush's screen lights up with exactly what will run; he clicks **Approve** without leaving what he was doing. It runs on *his* laptop with *his* token; the output lands in Dev's agent. The token never moved.

*(deny)* Now the part nobody else does. Dev's agent wants to ship to prod. Tarush clicks **Deny**. Dev's agent gets a clean 'denied', tells Dev, moves on. Credentials never moved; every request needed a yes.

Superconductor, Cursor cloud, AQ put your team in a hosted sandbox with a shared vault. We connect the laptops you already use — one command, no clone, no sandbox, no vault, no new IDE; Claude Code, Codex and Cursor in the same room. Capabilities, not credentials. Borrow a teammate's machine, not their credentials."

**Judge Q&A** (full set in DEMO.md §3):
1. *Isn't this SSH?* SSH hands a session every credential on the box; this hands an agent one bounded command, with a reason, and the owner says yes or no each time.
2. *Superconductor / Cursor pools?* They centralize — sandbox plus vault, or any worker takes any job. We're peer-to-peer and owner-approved.
3. *Anthropic cross-session messaging?* Same account only, and a message can never trigger execution. We're cross-person, cross-harness; execution is the point.
4. *`sh -c` on a teammate's machine?* The approval is the guard, `never` blocks classes, offers pin to scripts, chained commands never inherit `always`, the room sees everything.
5. *What's next?* Expiring scoped grants, a per-room audit log, file-claim warnings before an agent edits, in-session approvals for Codex and Cursor once their harnesses allow it.

**Honest-limitations slide**: room name is the only auth · shell offers are `sh -c` (approval is the guard) · OAuth-only MCPs (Linear, official Figma) can't be imported — shell offer instead · owner's laptop must be online and attended (2 min overlay, then 90 s dialog) · overlay needs Chrome/Edge for always-on-top · Codex/Cursor agents get messages by polling (`inbox` / `wait_for_events`), Claude Code gets them pushed · one session restart after install · no persistence.

## Stretch — only after item 9 passes twice

1. **File-claim warning in the prompt hook** (Abhi, 1 h): `emit.js` prefixes `⚠ tarush's agent touched src/auth.ts 3 min ago` when another user's `file_touched` is in the activity block. Cheapest proof of RESEARCH.md Claim C.
2. **`FIGMA_FIXTURE`** in `figma-export.sh` (Tarush, 15 min): if set, `cat` it and exit 0, so a Figma outage doesn't touch `team.json`.
3. Overlay sound toggle / pending count in the title bar, if not already in tonight's build.

Not S3: the relay's room page + overlay are the web view.

## Risks register

| # | risk | L / I | mitigation | owner |
|---|---|---|---|---|
| 1 | Overlay fails on stage (popup blocked, CORS origin mismatch after a host change, wrong daemon port, PiP unsupported) | M / M | Item 1 on Tarush's real box; OS dialog fallback is automatic (verified on Windows); footer shows daemon/relay state; Chrome/Edge only | Dev |
| 2 | Dev's agent doesn't reach for mesh unprompted | M / H | CLAUDE.md nudge, 3/3 test; explicit prompt; `mesh ask` CLI last | Dev |
| 3 | Network: venue blocks WS, stale ngrok, Dev's Mac sleeps | M / H | Railway (item 7); hotspot rehearsal; `pkill -x ngrok`; `caffeinate` | Dev |
| 4 | Figma live path (token, file key, name lookup, latency) | M / M | item 3 verified once live; `list` first; `FIGMA_FIXTURE` stretch | Tarush |
| 5 | Silent drops: reused room replays old frames; clock skew > 30 s; overlay/dialog timeouts | L / H | new room per run; `date -u`; `MESH_DEBUG=1` in rehearsal 1; Tarush watches the overlay | Abhi |
| 6 | Real MCP servers fail on stage (npx download, PAT expiry) | M / M | pre-warm `npx`, join at T-15; drop the Supabase beat first | Tarush |
| 7 | Stale registration: plugin is project-scoped to where `join` ran; tool list cached | M / M | join inside the demo repo; restart the session (or `/reload-plugins`); `/mcp` check at T-15 | Dev |
| 8 | Codex ignores "watch mesh" or stops looping on `wait_for_events` | M / L | item 2; beat 2:32 is optional and cut first | Dev |

## Found while reading (not fixed; owners decide)

1. `apps/daemon/src/core.ts` `REQUEST_MAX_AGE_MS = 30_000` compares sender `ts` to the local clock; a receiver > 30 s ahead silently ignores every request. Message notifications use a 5-min window for the same reason; the two numbers are unrelated.
2. `apps/daemon/src/config.ts`: `pnpm -F daemon start … --config ./team.json` resolves against `apps/daemon/`; pass an absolute path. `~/.mesh/last-config` remembers the last one so a rerun from any folder (e.g. a downloaded `.cmd`) keeps the same offers.
3. `scripts/figma-export.sh` has no fixture mode; `FIGMA_API_BASE` exists for tests only.
4. `scripts/tunnel-relay.sh` reads `:4040/api/tunnels` without checking its own ngrok owns it; with a stale ngrok it prints a URL then exits `ERR_NGROK_334`. `pkill -x ngrok` first.
5. `mesh join --background` skips the foreground registration output except lines matching `registered|already registered|restart your agent`; `mesh log` has the rest.
6. Overlay and the Claude Code watcher share one pending queue: with both attached, whichever answers first wins and the other sees the id vanish. Fine for the demo (Tarush is on one surface); say so if a judge asks.
7. Windows toast (`MESH_TOAST=1`) is unverified from the hidden background process; the message box is the default for that reason.
