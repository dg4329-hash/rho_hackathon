# NEXT — from `main` to a winning demo

Written 2026-09-12 (Sat, late) against `df4a70e`. Priority order with rough hours; no dates (slot unknown). Per-person commands and configs: "Next (post-merge)" in `docs/tasks/{DEV,TARUSH,ABHI}.md`.

## Where we are

Cross-laptop is proven over the public relay (ngrok on Dev's Mac): Mac↔Mac and Mac↔Windows (Git `bash.exe`). A fresh laptop joins with one command (`curl …/install.sh | bash -s -- <room>`), no clone, no `team.json`: handle from git, MCP servers imported at `ask`, mesh registered with Claude Code (+ hooks), Codex (codex-cli 0.154) and Cursor, daemon in the background. Approvals are native OS dialogs (90 s → denied), TTY `[y/n]` as fallback. Agent-to-agent messages work both ways (`send_message` / `inbox`, prompt-hook injection, native notification). Eight MCP tools. Suites: relay 28/28, daemon 20 + 30 checks, typecheck green.

Never happened: the PowerShell installer or the Windows dialog on a real Windows box (Tarush's run used Git Bash); a live Figma call (`FIGMA_TOKEN` never set); a keyed MCP server (Supabase/GitHub) borrowed; a Codex tool call (no login); three laptops at once; the feed on a projector; a timed rehearsal; Railway.

| step | true status |
|---|---|
| 0 protocol | done (8 tools, `message` event) |
| 1 relay | done; web front door + installers; public via ngrok, **Railway not done** |
| 2 daemon | done; **cross-laptop with two humans**, Mac↔Mac, Mac↔Windows |
| 2b one-command install / zero-config / auto-register / background | done on macOS + Git Bash; **PowerShell path + Windows dialog untested on real Windows** |
| 3 local MCP server | done from live Claude Code; **Codex calls not exercised** |
| 3b MCP import | done vs real Claude Code / Cursor configs; **no keyed server borrowed yet**; OAuth remotes skipped by design |
| 3c messages | done both ways; Codex/Cursor pull-only |
| 4 feed / room page | done vs real relay; **never on the projector** |
| 5 hooks | done, auto-installed by `mesh join`; **prompt → feed not timed on two laptops** |
| 6 real MCPs + Figma | `figma-export.sh` by name dry-verified; **no live token run, no keys** |
| 7 rehearsal | not started |
| S1 / S2 | done in tests; deny never on stage |
| P plugin | in progress on `dev/plugin`; not on the demo path |

## Critical path (~6 h, much parallel)

| # | item | owner | h | acceptance | if skipped |
|---|---|---|---|---|---|
| 1 | **Tarush runs the Windows one-liner on his real box.** PowerShell: `& ([scriptblock]::Create((irm -Headers @{'ngrok-skip-browser-warning'='1'} https://<host>/install.ps1))) <room> --as tarush`. Then Dev asks `echo hi` from a Mac. If the PowerShell path fails, fall back to Git Bash (`curl … \| bash`, proven). | Tarush, Dev | 0.5 | Installer finishes with `mesh running in the background`; `node ~/.mesh/mesh.mjs status` → `● running`; the Windows MessageBox appears; **Yes** → Dev prints `hi`, `exit 0`; **No** → `denied: owner declined`. A `send_message` from Dev shows a balloon notification. | Tarush's owner-daemon has to run in Git Bash with `MESH_APPROVE=tty`, or on a Mac. |
| 2 | **Figma live, by name.** Tarush: `export FIGMA_TOKEN=… FIGMA_FILE_KEY=…` in the shell that runs the daemon; `./scripts/figma-export.sh list`, then `./scripts/figma-export.sh "Onboarding/Step 2"`. Shell offer `figma.export` (`command: ./scripts/figma-export.sh`, notes: "pass the frame name, e.g. Onboarding/Step 2") in his `team.json`. | Tarush | 0.5 | `list` prints the frames; export by name prints `PNG: …` + outline in < 5 s; after re-join, presence shows `figma.export`; Dev's `describe_capability` shows the note. | Headline beat has no real output. |
| 3 | **Dev's Claude Code in a demo repo** (small app with `src/onboarding/Step1.tsx`): run the one-liner (or `pnpm -F daemon start join <link>`) **inside that repo** so `claude mcp add` (project scope) and the hooks land there; `CLAUDE.md` line saying Figma/Supabase aren't directly accessible — use the `mesh` tools. | Dev | 1 | Fresh `claude`: `/mcp` shows `mesh ✔`. Demo prompt *"Implement onboarding step 2 to match the Figma frame Onboarding/Step 2."* in 3 fresh sessions → `list_teammates → describe_capability → ask_teammate` unprompted **3/3**, carrying `figma-export.sh "Onboarding/Step 2"`; feed `💬 prompt:` < 2 s. | Agent invents Step 2 over an empty feed. |
| 4 | **Tarush's keyed MCP server**: Supabase `npx -y @supabase/mcp-server-supabase@latest --read-only --project-ref=<ref>` (env `SUPABASE_ACCESS_TOKEN`) in `~/.claude.json` or `.cursor/mcp.json` (GitHub optional). `permissions`: reads `always`, `execute_sql` `ask`, `apply_migration` `never`; `notes` with table names. Run `npx` once to cache. | Tarush | 1.5 | Join banner `imported 1 servers, N tools (supabase N)`; presence `● tarush supabase(N) figma.export vercel.deploy`; Dev's Claude Code: *"describe tarush's supabase.list_tables and call it"* → real table names, feed `⚡ auto-approved`; `execute_sql` → dialog; `apply_migration` → denied, no dialog. | "Universal via MCP import" is a slide, not a beat. |
| 5 | **Deny beat.** Tarush adds offer `vercel.deploy` (`command: vercel`, `ask`). Dev's second prompt: *"Ship onboarding step 2 to production."* | Dev, Tarush | 0.5 | Feed `dev ──▶ tarush $ vercel --prod`; Tarush clicks **Deny**; `❌ denied (owner declined)`; exactly one `ask_teammate` in the transcript; agent reports the denial. | The signature beat shows nothing. |
| 6 | **Railway** (dashboard, no CLI): New Project → Deploy from GitHub → `dg4329-hash/rho_hackathon` → Generate Domain. Kills the "Dev's laptop + ngrok must survive" risk and the ngrok interstitial. | Dev | 0.5 | `https://<railway-host>/health` → JSON; one-liner from that host joins a room; item 1 re-run against it. Until then: ngrok, `pkill -x ngrok` before every launch. | Demo depends on Dev's Mac staying up and on venue Wi-Fi reaching ngrok. |
| 7 | **Three-laptop run + hooks timing + feed on the projector.** New room. Abhi: feed at ≥ 24 pt (or the room page in a browser). Dev: prompt typed → stopwatch. | all | 1 | `/health` → `connections ≥ 3`; feed shows `dev ──▶ tarush …`, `✅ approved`, `▏ …`, `✔ exit 0`; prompt → `💬 prompt:` < 2 s; Abhi's next prompt transcript shows `Team activity (last 10 min):` with Dev's lines. Stay joined 30 min. | Awareness beat is a spoken claim. |
| 8 | **Rehearsal ×2, timed, on the projector; run 2 on a phone hotspot.** New room each run. | all | 1.5 | Two consecutive clean runs of DEMO.md §1 ≤ 3:00; timings filled; `sample-frames.jsonl` regenerated from run 2. | Breaks on stage. |
| 9 | **Plugin** (`dev/plugin`, in progress): requests land in the owner's Claude Code session, no restart. Merge only if it passes 3/3 on a fresh session **before** rehearsal 1; otherwise it stays a "next" slide. | Dev | — | See `docs/UX-RESEARCH.md` §(c). | Owner keeps the dialog; restart after install stays. Both fine for the demo. |

## Demo-hardening

- **Projector**: feed ≥ 24 pt, dark theme, ≥ 100 columns, or the room page `https://<host>/r/<room>` in a browser at 150 %. `chalk.dim` lines vanish on cheap projectors — Abhi checks on the real screen. `FORCE_COLOR=3`.
- **Tarush's side screen**: the dialog is the beat. Nothing else in front of it; notifications on (mesh uses them); Do Not Disturb off.
- **Pre-warm (T-15)**: tunnel (or Railway) up, both daemons joined (`mesh status` on each), feed shows both, `npx` servers cached, `figma-export.sh "Onboarding/Step 2"` run once, Claude Code open with `/mcp` connected, one `ask tarush "echo warm"` approved through the dialog.
- **Reset the room**: the relay replays 200 frames to every joiner — **never reuse a room name**. `mesh stop` on both, rejoin `rho-<n>` (one-liner or `join`), `/health` → `connections ≥ 3`. Don't restart the tunnel.
- **ngrok**: hostname has been stable for this account; `NGROK_DOMAIN=…` pins it. Always `pkill -x ngrok` first — a stale ngrok makes the script print a URL then die (`ERR_NGROK_334`). If it changes anyway: everyone re-runs the one-liner from the new room page (~60 s).
- **Machines and network**: `caffeinate -dims` / never-sleep on AC, chargers in. Venue Wi-Fi may block WebSockets → all three on one phone hotspot (rehearsal 2 proves it); `curl https://<host>/health` from each laptop on arrival. `date -u` on all three: requests older than 30 s by the *sender's* clock are dropped silently.
- **Dialog timeout is 90 s**: if Tarush is slow, the request is denied with `owner did not answer in 90 s`. Dev's agent will report that; re-prompt.

## Pitch (90 s, Abhi)

"Every coding agent here is single-player: my tools, my keys, my laptop. But the team owns far more than any one of us. Dev's agent has no Figma; Tarush's does. Today the fix is Slack.

*(Dev types; feed fills)* Dev's agent hits the wall, looks around the room, finds Tarush's Figma export and Tarush's notes, and asks — with a reason. Tarush gets a dialog with exactly what will run and clicks **Approve**. It runs on *his* laptop with *his* token; the output lands in Dev's agent. The token never moved.

*(deny)* Now the part nobody else does. Dev's agent wants to ship to prod. Tarush clicks **Deny**. Dev's agent gets a clean 'denied', tells Dev, moves on. Credentials never moved; every request needed a yes.

Superconductor, Cursor cloud, AQ put your team in a hosted sandbox with a shared vault. We connect the laptops you already use — one command, no clone, no sandbox, no vault, no new IDE; Claude Code, Codex and Cursor in the same room. Capabilities, not credentials. Borrow a teammate's machine, not their credentials."

**Judge Q&A** (full set in DEMO.md §3):
1. *Isn't this SSH?* SSH hands a session every credential on the box; this hands an agent one bounded command, with a reason, and the owner says yes or no each time.
2. *Superconductor / Cursor pools?* They centralize — sandbox plus vault, or any worker takes any job. We're peer-to-peer and owner-approved.
3. *Anthropic cross-session messaging?* Same account only, and a message can never trigger execution. We're cross-person, cross-harness; execution is the point.
4. *`sh -c` on a teammate's machine?* The approval dialog is the guard, `never` blocks classes, offers pin to scripts, the room sees everything.
5. *What's next?* Approvals inside the coding tool (plugin, in progress), expiring scoped grants, a per-room audit log, file-claim warnings before an agent edits.

**Honest-limitations slide**: room name is the only auth · shell offers are `sh -c` (approval is the guard) · OAuth-only MCPs (Linear, official Figma) can't be imported — shell offer instead · owner's laptop must be online and attended (90 s dialog timeout) · Codex/Cursor owners get messages pull-only · one session restart after install · no persistence.

## Stretch — only after item 8 passes twice

1. **Plugin merge** (item 9) if it's green: the pitch line becomes "the request shows up in Tarush's Claude Code and he presses 1".
2. **File-claim warning in the prompt hook** (Abhi, 1 h): `emit.js` prefixes `⚠ tarush's agent touched src/auth.ts 3 min ago` when another user's `file_touched` is in the activity block. Cheapest proof of RESEARCH.md Claim C.
3. **`FIGMA_FIXTURE`** in `figma-export.sh` (Tarush, 15 min): if set, `cat` it and exit 0, so a Figma outage doesn't touch `team.json`.

Not S3: the relay's room page is the web view.

## Risks register

| # | risk | L / I | mitigation | owner |
|---|---|---|---|---|
| 1 | PowerShell installer / Windows MessageBox fail on Tarush's real box | M / H | Item 1 first thing; fallback Git Bash + `MESH_APPROVE=tty` (proven), or owner role on a Mac | Tarush |
| 2 | Dev's agent doesn't reach for mesh unprompted | M / H | CLAUDE.md nudge, 3/3 test; explicit prompt; `mesh ask` CLI last | Dev |
| 3 | Network: venue blocks WS, stale ngrok, Dev's Mac sleeps | M / H | Railway (item 6); hotspot rehearsal; `pkill -x ngrok`; `caffeinate` | Dev |
| 4 | Figma live path (token, file key, name lookup, latency) | M / M | item 2 verified once live; `list` first; `FIGMA_FIXTURE` stretch | Tarush |
| 5 | Silent drops: reused room replays old frames; clock skew > 30 s; dialog 90 s timeout | L / H | new room per run; `date -u`; `MESH_DEBUG=1` in rehearsal 1; Tarush watches his screen | Abhi |
| 6 | Real MCP servers fail on stage (npx download, PAT expiry) | M / M | pre-warm `npx`, join at T-15; drop the Supabase beat first | Tarush |
| 7 | Stale registration: Claude Code caches tool list; `claude mcp add` is project-scoped to where `join` ran | M / M | join inside the demo repo; restart the session; `/mcp` check at T-15 | Dev |

## Found while reading (not fixed; owners decide)

1. `apps/daemon/src/core.ts` `REQUEST_MAX_AGE_MS = 30_000` compares sender `ts` to the local clock; a receiver > 30 s ahead silently ignores every request. Dialog timeout (90 s) is longer than this window by design, but the two numbers are unrelated.
2. `apps/daemon/src/config.ts`: `pnpm -F daemon start … --config ./team.json` resolves against `apps/daemon/`; pass an absolute path.
3. `scripts/figma-export.sh` has no fixture mode; `FIGMA_API_BASE` exists for tests only.
4. `scripts/tunnel-relay.sh` reads `:4040/api/tunnels` without checking its own ngrok owns it; with a stale ngrok it prints a URL then exits `ERR_NGROK_334`. `pkill -x ngrok` first.
5. `mesh join --background` skips the foreground registration output except lines matching `registered|already registered|restart your agent`; `mesh log` has the rest.
6. Windows notification is a WinForms balloon (`NotifyIcon`), which some Windows 11 builds route to the notification center only; the dialog itself is WPF `MessageBox` and unaffected.
