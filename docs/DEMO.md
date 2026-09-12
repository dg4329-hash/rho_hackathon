# Demo — run of show

Target: **3:00 demo + 2:00 Q&A.** Three laptops. Projector = Abhi's `mesh feed` full-screen, 24pt, dark theme (or the relay's room page `https://<relay>/r/<room>` in a browser). Dev's and Tarush's screens on side displays (or mirrored to the projector only at beats 3 and 5 — Tarush's beat is the overlay lighting up; it must be visible).

Abhi is on the mic. Dev types. Tarush clicks Approve / Deny in the overlay. Nobody else touches a keyboard.

## 0. Pre-flight (T-15 min, all three) ☐

| who | check | command |
|---|---|---|
| Dev | relay is up | `./scripts/tunnel-relay.sh` running (or Railway); `curl -s https://<relay>/health` from each laptop |
| all | clocks agree (requests older than 30 s by the sender's clock are dropped) | `date -u` on all three, within 20 s |
| Tarush | daemon joined in the background, Figma works | one-liner from the room page (PowerShell, verified) or the downloaded `mesh-join-<room>.cmd`, then `node ~/.mesh/mesh.mjs status` → `● running`, presence shows `supabase(n) … figma.export vercel.deploy`; `./scripts/figma-export.sh "Onboarding/Step 2"` returns in <5 s |
| Tarush | overlay open (shipping tonight) | room page → **Pop out overlay** (Chrome/Edge); its footer shows daemon `localhost:7337 ✓` and relay `✓`; keep it on the side screen, never behind another window |
| Tarush | approval works | Dev: `pnpm -F daemon start ask tarush "echo warm" --why warm --room <room> --as dev --relay wss://<relay>` → request card in the overlay → **Approve** → `warm`. Close the overlay once and repeat: the OS dialog (Windows MessageBox) must appear. Reopen it. |
| Tarush | Codex watching (optional beat 2:32) | in Codex: *"Codex, watch mesh for the next 10 minutes."* → it calls `wait_for_events`; Dev's `echo warm` request is reported as information, never approved by Codex |
| Dev | daemon joined **inside the demo repo**, MCP registered, hooks installed | `pnpm -F daemon start join https://<relay>/r/<room> --as dev` (from the demo repo); banner `✓ Claude Code plugin: registered` (or `already`); fresh `claude` → `/mcp` shows the mesh tools; `grep -c mesh .claude/settings.json` ≥ 1 (plugin enabled + `permissions.ask` rule) |
| Abhi | feed on projector, shows both daemons | `pnpm -F feed start <room> --relay wss://<relay>` → presence shows `● tarush` and `● dev` |
| Abhi | fixtures ready as fallback | `pnpm -F feed mock` works in a spare tab |
| all | phones on silent, terminal font ≥ 24pt, dark background; **Tarush's notifications ON** (mesh uses them), everyone else's off | |

**Reset the room** before each run: the relay replays the last 200 frames to every joiner, so never reuse a room name. `mesh stop` (or Ctrl-C) on both daemons, rejoin `rho-<n>`, `/health` → `connections ≥ 3`. Don't restart the tunnel. Start a fresh Claude Code session on Dev's laptop so the transcript is clean.

## 1. Script

Timings are targets from rehearsal; update the "actual" column after each run.

| t | beat | who | say / do | projector shows |
|---|---|---|---|---|
| 0:00 | **hook** | Abhi | "Every one of us has a coding agent. None of them can talk to each other. Dev's agent has no Figma. Tarush's does. Dev's has no Supabase. Tarush's does. Today the fix is Slack: *hey, can you export that frame for me?*" | feed: presence block, `● tarush  supabase(n) figma.export vercel.deploy` / `● dev  …` |
| 0:20 | **one command** (optional) | Abhi | "Tarush joined with one command — no clone, no config. His MCP servers are already on offer." | room page: the one-liner; presence with Tarush's servers |
| 0:25 | **the ask** | Dev | types into Claude Code: *"Implement onboarding step 2 to match the Figma frame Onboarding/Step 2."* Hits enter. Hands off keyboard. | `dev 💬 prompt: Implement onboarding step 2…` (hooks) |
| 0:35 | | Abhi | "Dev's agent has no Figma access. Watch what it does instead of giving up." | `dev 🔧 tool: mcp__mesh__list_teammates` → `describe_capability` |
| 0:45 | **the request** | Abhi | "It found Tarush's Figma export, read Tarush's notes on how to use it, and asked." Point at the `why:` line. "Every request carries a reason." | `dev ──▶ tarush  $ ./scripts/figma-export.sh "Onboarding/Step 2"` / `why: need the frame to match` (yellow) |
| 0:55 | **the yes** | Tarush | overlay card lights up: `dev wants to run ./scripts/figma-export.sh "Onboarding/Step 2" · why: …  [Deny] [Approve]` → clicks **Approve**. Says nothing; never left what he was doing. (Overlay closed? The same text arrives as the OS dialog.) | `tarush ✅ approved` → output streams → `tarush ✔ exit 0 in 2.1s` |
| 1:05 | | Abhi | "Tarush's laptop ran it. Tarush's Figma token never left Tarush's laptop. The outline went straight back into Dev's agent, which is now coding." (The PNG stays on Tarush's disk; the text outline is what travels.) | `dev 📁 file: src/onboarding/Step2.tsx` |
| 1:25 | **the second ask** (MCP, auto) | Abhi | "Same thing works for any MCP server Tarush already has — we imported them, we didn't integrate them. Here the agent checks his Supabase schema; this one Tarush marked *always*, so no dialog." | `dev ──▶ tarush  supabase.list_tables {…}` → `tarush ⚡ auto-approved` → JSON result |
| 1:50 | **the no** | Abhi | "Now the part nobody else does." Dev's agent wants to ship. | `dev ──▶ tarush  $ vercel --prod` / `why: ship onboarding step 2` |
| 1:55 | | Tarush | overlay card → clicks **Deny**. | `tarush ❌ denied  (owner declined)` |
| 2:05 | | Abhi | "Dev's agent gets a clean 'denied', tells Dev, moves on. It does not retry. **Credentials never moved. Every request needed a yes.**" | `dev 📝 note: Prod deploy denied by tarush…` |
| 2:25 | **awareness** | Abhi | "One more thing — every prompt Dev types, every file his agent touches, is on this screen and in *Abhi's* agent's context. And agents can talk: Dev's just told Tarush's what it changed." | scroll back to `📁 file:` lines; `dev ✉ msg → tarush: …`; Tarush's overlay shows the message with a reply box |
| 2:32 | **watch mesh** (optional) | Abhi | "Tarush is on Codex, not Claude Code. Before we started he told it *'Codex, watch mesh for the next 10 minutes'* — so Dev's message just landed in his agent too. It can read, it can reply, it cannot approve. That stays with Tarush." | Tarush's Codex: `wait_for_events` returns Dev's message; `send_message` reply → `tarush ✉ msg → dev: …` |
| 2:40 | **close** | Abhi | "One command per laptop, nothing to install. No cloud sandbox, no shared vault, no new IDE — Claude Code, Codex and Cursor in the same room. Your team's machines become your agent's tools. *Borrow a teammate's machine, not their credentials.*" | presence block |
| 3:00 | | | Q&A | |

**Actual timings:** run 1 ___ · run 2 ___

Beats that must not be skipped if we're running long: 0:25 the ask → 0:55 the yes → 1:50 the no → close. Drop the Supabase beat (1:25), the one-command opener (0:20), watch mesh (2:32) and awareness (2:25) first.

## 2. Fallback ladder

Go down one rung at a time. Abhi keeps talking through every switch; nobody says "it's broken".

| symptom | fix | who | script line |
|---|---|---|---|
| Dev's agent doesn't call `ask_teammate` (goes off and does something else) | Dev types a more explicit prompt: *"Use the mesh tools to ask tarush to run figma-export for the frame Onboarding/Step 2."* | Dev | "Let me be explicit with it." |
| MCP call from Claude Code fails / hangs | Dev runs the same request by hand: `pnpm -F daemon start ask tarush './scripts/figma-export.sh "Onboarding/Step 2"' --why "need the frame" --room <room> --as dev --relay wss://<relay>` | Dev | "Same request, from the CLI — the agent just does this for you." |
| Overlay doesn't show the request (daemon `✗` in its footer, wrong port, popup blocked) | Tarush closes the overlay; the daemon falls back to the OS dialog (at once when nothing polls `/pending`, else 120 s after the request). Dev re-prompts. | Tarush | "Same approval, as a system dialog." |
| Tarush's dialog doesn't appear (or times out at 90 s → `owner did not answer`) | Tarush: `node ~/.mesh/mesh.mjs stop`, then in a real terminal (Terminal.app / PowerShell, not mintty) `MESH_APPROVE=tty node ~/.mesh/mesh.mjs join <room> --as tarush --relay wss://<relay>` → `[y/n]` in the terminal. Dev re-prompts. | Tarush | "Terminal approval — same thing, older UI." |
| Relay unreachable (ngrok died, venue wifi) | Dev: `pkill -x ngrok; ./scripts/tunnel-relay.sh` on a phone hotspot; everyone re-runs the one-liner (or `join`) from the new room page | Dev | "Relay is a stateless Node file — we just moved it." (~60 s) |
| Figma API down / script errors | Tarush: temporarily replace `scripts/figma-export.sh` on disk with a two-line stub that `cat`s `docs/fixtures/step2.txt` (the daemon runs the command the agent sent; the offer only decides the permission, so changing `team.json` does nothing). No rejoin needed. `FIGMA_FIXTURE` in the script is a stretch item. | Tarush | nothing — no one notices |
| Codex doesn't report the message (no `wait_for_events` call) | Skip beat 2:32; Abhi points at the overlay's message instead. | Abhi | — |
| Hooks don't fire (no `💬 prompt:` line) | Skip beat 0:35; Abhi narrates "Dev just typed …". Awareness beat becomes a spoken claim. | Abhi | — |
| Everything is down | Abhi runs `pnpm -F feed mock` in the projector tab. Feed replays the full scripted sequence at 700 ms/frame. Abhi narrates it beat for beat as above. Dev and Tarush mime. | Abhi | "This is a recording from our rehearsal an hour ago." Say it. Honest beats caught. |

Keep `docs/fixtures/sample-frames.jsonl` current with whatever the real run looks like so the recording matches the live narration.

## 3. Judge Q&A

Short answers. Sources: `docs/RESEARCH.md` §1–4.

**"Isn't this just SSH?"**
SSH gives you a shell and all of Tarush's credentials for the session. This gives your *agent* one command or one MCP tool, with Tarush seeing each request and clicking Approve or Deny. The unit is a bounded task with a reason, not a login.

**"Isn't this Superconductor / Cursor cloud / AQ?"**
Those move your team into a hosted sandbox and pool credentials in a shared vault. We connect the laptops you already use — one command, no sandbox, no vault, no new IDE — and every request needs the owner's yes. Local-first instead of cloud-first.

**"Cursor just shipped self-hosted machine pools."**
Same shape, different owner: Cursor pools let any worker claim any cloud-dispatched job, no human in the loop. Ours is peer-to-peer — a specific teammate, their own machine, their approval.

**"Zed Delta does live awareness."**
Delta syncs the whole worktree and conversation, but you have to live in Delta. Our feed and hooks are harness-agnostic — Claude Code, Codex and Cursor in the same room today — and inject awareness and teammate messages into the agent's context at prompt time, without adopting an editor.

**"Anthropic already has cross-session messaging and Remote Control."**
Yes — for *your own* sessions, same account, and a message can never trigger execution or approve anything. We're cross-person and cross-harness, and execution is the whole point.

**"Is `sh -c` on a teammate's machine safe?"**
The approval dialog is the safety layer: the owner sees the exact command and the reason before it runs, `never` permissions block a command class outright, and shell offers can be pinned to a script. It's the same trust you extend when a teammate says "can you run this for me" — made explicit and logged. Room name is the only auth today; we say that out loud.

**"Why a pop-out window and not inside the editor?"**
Because it works for every coding tool today with zero integration and never interrupts the owner: a small always-on-top window next to whatever they're doing, the OS dialog as fallback. Claude Code owners also get it inside the session (the plugin: the request lands in your session, you press 1). Codex and Cursor agents can watch the room with `wait_for_events`, but an approval never goes through a model.

**"Why not MCP Tasks?"**
Tasks is an extension that's still being redesigned and has no owner-approval semantics. Our job table is 40 lines.

**"What's next?"**
Scoped, expiring grants ("dev can run figma-export for the next hour without asking"); an audit log per room; and turning the awareness feed into pre-git conflict warnings — "Tarush's agent is editing `auth.ts`" — injected into every agent before it touches a file. In-session approvals for Codex and Cursor once their harnesses allow it.

## 4. Notes
- **Codex and Cursor owners appear in the feed via requests, decisions and messages they send.** Only Claude Code has hooks, so no `💬 prompt` / `📁 file` lines for Tarush if he's on Cursor; their agents read messages by calling `inbox` or by looping on `wait_for_events` ("Codex, watch mesh"); Tarush himself approves in the overlay. Fine for the demo: Tarush is the approver, not the requester.
- Room name is the only auth. Say it on stage before a judge does.
- Deny from the overlay or the dialog shows `owner declined` on the feed. A silence ends as `owner did not answer in 90 s` — after the overlay's own 120 s hand-off if it was open, so answer within two minutes.
- Feed shows observable events only — prompts, tool calls, files, requests, output, messages. Never hidden reasoning. If asked, that's a choice.
- Rho is a fintech audience: lead with "credentials never move" over "dev tooling" if the room feels non-technical.
