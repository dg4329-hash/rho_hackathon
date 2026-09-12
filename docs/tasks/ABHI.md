# Abhi — `apps/feed`, `hooks/`, demo & pitch

Subscription: Claude Pro (if you actually have Cursor Pro, swap files with Tarush). Claude Pro has the tightest rate limits, so this stream is deliberately the smallest in code and the biggest in polish. You are the person on the mic.

## Deliverables
1. `apps/feed` — `mesh feed <room>`: the live terminal UI on the projector. (Step 4.)
2. `hooks/` — Claude Code hook scripts + one-command installer. (Step 5.)
3. `docs/DEMO.md` — the rehearsed script, timings, fallbacks, and the judge Q&A sheet. Draft from PLAN.md §5 and RESEARCH.md §3.
4. S3 (only if 4-7 done): a single-page web dashboard reading the same relay.

## Step 4 — feed (acceptance: on a third laptop, shows request → approval → streamed output → result live, and presence changes)
- Node 22, `ws`, `chalk`, optionally `ink` if you want boxes; plain chalk lines are fine and safer.
- Connect `relay?room=&user=abhi&role=feed`, send `hello` with `offers: []`, then render every frame:
  - `presence` → one line listing online users and their offer names.
  - `event` → `HH:MM:SS  dev      › prompt: Implement onboarding step 2…` (kind-specific icons/colors: prompt 💬, tool_call 🔧, file_touched 📁, status ⏸, note 📝)
  - `request` → `dev ──▶ tarush  figma-export 8fA 12:34   (why: need the frame)` in yellow
  - `decision` → `tarush ✅ approved` / `❌ denied (reason)` / `⚡ auto`
  - `output` → dim, indented, prefixed with the short id; cap at 20 lines per job on screen, then `…`
  - `result` → `tarush ✔ exit 0 in 2.1s` green, or red on nonzero/timeout
- Replayed history on join renders the same way (the relay sends it after `hello`).
- Until Tarush's relay exists, run against a tiny local mock: a script that opens a ws server and replays `docs/fixtures/sample-frames.jsonl` (write 15-20 sample frames yourself from CONTRACT §1).
- Make it look good at 24pt font on a projector: wide gutters, user names padded, colors with enough contrast on a dark background.

## Step 5 — hooks (acceptance: a prompt typed in Claude Code on any laptop appears in the feed within 2 s)
- `hooks/emit.js <kind>`: reads hook JSON from stdin, builds `{ kind, summary, data }` per CONTRACT §4, POSTs to `http://localhost:7337/event`. Must never fail the hook: swallow errors, exit 0, 1 s timeout.
- For `UserPromptSubmit`: additionally `GET /activity?sinceMinutes=10` and print a compact block to stdout (that becomes context for the agent): `Team activity (last 10 min):\n- 14:02 tarush prompt: …\n- 14:03 tarush file: auth.ts`.
- `hooks/install.sh`: merges the four hook entries into `.claude/settings.json` in the current repo (use `jq`; back up first). Print what it did.
- Cursor has no hooks; Cursor users appear in the feed via requests/decisions only. Note this in DEMO.md.

## docs/DEMO.md
- Minute-by-minute script with who says what (start from PLAN.md §5).
- Fallback ladder: if MCP flakes → Dev runs `mesh ask` by hand; if relay dies → Tarush's `ngrok`; if Figma API is down → offer `cat docs/fixtures/step2.txt` as the "export".
- Judge Q&A: Superconductor / Cursor Machines / Zed Delta / "isn't this just ssh" / security of `sh -c` / what's next. One or two sentences each, sourced from RESEARCH.md.

## Don'ts
- Don't touch `apps/daemon` or `apps/relay`. Protocol changes go through CONTRACT.md + Dev.
- Don't start S3 until steps 4, 5, and a full rehearsal are done.

## Definition of done
Feed running on the projector laptop through a full rehearsal; hooks installed on Dev's and your laptops; DEMO.md rehearsed twice with timings recorded under "Evidence" below.
