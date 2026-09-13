# Mesh build log

## 2026-09-12 — current codebase sweep (`tarush` at `5eaf3c9`)

This is the current shared snapshot. The older, person-specific notes in `docs/tasks/TARUSH-BUILD-LOG.md` are historical; `docs/tasks/` was removed from tracked `main` at `a87fa94`. This sweep read the protocol, relay/web/installers, daemon/CLI/MCP/approvals, feed, hooks, plugin, tray, scripts, tests, and operating docs. It did not change product code.

### What the product does now

Mesh lets an agent ask to use a teammate's command or imported MCP tool on that teammate's machine. The owner daemon keeps the credential and working environment, applies the owner's offer and permission, and returns output to the requester. The relay carries room traffic and serves the web UI, installers, daemon bundle, plugin archive, and temporary files; it does not execute tools. A room name is the access secret; there is no account system. Jobs, room history, inboxes, and uploaded files are memory-only.

1. **Start a room and join.** `apps/relay/src/index.ts` runs HTTP and WebSocket on one port. `web.ts` serves `/`, `/r/:room`, `/api/rooms`, `/install.sh`, `/install.ps1`, `/mesh.mjs`, `/emit.js`, `/plugin.tgz`, and the overlay. A room page supplies a prefilled join command or downloadable Windows/Mac launcher. The installer saves `mesh.mjs` and `emit.js` under `~/.mesh`, stops an earlier background daemon, and joins the room. Joining from the repo uses `apps/daemon/src/cli.ts`. It reads optional `team.json` (current directory, remembered file, or `~/.mesh/team.json`), or creates a zero-config owner identity from the flags/room link. It imports available local Claude Code/Cursor MCP servers and advertises their tools and configured shell offers. Claude Code plugin/hooks and Codex/Cursor MCP registration are best effort; restart the agent session to discover new tools.
2. **Discover and request.** `packages/protocol/src/index.ts` owns the wire, config, and tool schemas. `apps/daemon/src/local-server.ts` exposes `http://127.0.0.1:7337/mcp` with **14 tools**: `list_teammates`, `describe_capability`, `ask_teammate`, `check_job`, `post_event`, `send_message`, `wait_for_events`, `inbox`, `send_file`, `fetch_artifact`, `team_activity`, `approve_request`, `switch_room`, and `leave_room`. The requester lists teammates, inspects an offer's schema/notes, and asks with a reason. The relay fans the request out by room and retains the newest 200 wire frames. The owner's `core.ts` checks addressee, age/replay, schema, and permissions before execution. A fixed command offer runs only the exact owner-defined line (or its offer name); extra arguments do not inherit it. An imported MCP call runs through the owner's local MCP client, so its token never moves to the requester.
3. **Approve and return.** `always` offers can run automatically, `never` offers are denied, and `ask` offers wait for a human. An attached overlay or Claude Code watcher receives the pending request first; on watcher timeout the daemon falls back to a native OS dialog, then terminal prompt where available. Windows dialogs now use an interactive-desktop foreground MessageBox; the native message alert was manually verified as readable and dismissible above Codex. The owner emits `decision`, optional shell `output` chunks, and `result` for the same job ID. The requester accepts the result only from the addressed owner; `ask_teammate` may return `running`, followed by `check_job`.
4. **Stay aware and communicate.** `apps/feed/src/index.ts` is a read-only terminal observer; the room page polls recent activity. Claude Code hooks/plugin send prompt, tool, status, and file-touch events to the loopback `/event` endpoint. For projects without those hooks, daemon `gitwatch.ts` polls Git status every 5 seconds and reports newly dirty paths. Claude Code's `pre_edit` hook checks `/touched` for another teammate's touch in the past 10 minutes and adds a nonblocking warning. `send_message` emits a room event; recipients see it in the overlay, native notification, and in-memory inbox (last 500). Claude Code's plugin monitor/prompt hook can surface it in-session; Codex/Cursor can call `inbox` or `wait_for_events`. The browser overlay (`/overlay?room=...&port=7337`) polls the local daemon for approvals/messages and the relay for feed; Chrome/Edge Document Picture-in-Picture is preferred, popup fallback is available. `apps/tray` is an optional Electron always-on-top shell for that page, run from source, without a packaged installer.
5. **Exchange files.** `apps/relay/src/files.ts` stores artifacts separately from WebSocket frames. A shell result line `MESH_FILE: <path>` or `PNG: <path>.png`, or an MCP image/blob result, triggers upload and a small descriptor on the result. `send_file` uploads an owner-local file under the project or `~/.mesh` and emits a `file` event to the recipient's inbox; `fetch_artifact` downloads into `./mesh-artifacts/<sender>/` and returns small images/text inline to the agent. Feed/overlay/room page display file chips. Relay limits are 25 MB/file, 200 MB total with LRU eviction, and 1 hour TTL. See `docs/FILES-API.md`.

The loopback daemon HTTP service (`/mcp`, `/health`, `/event`, `/pending`, `/decide`, `/message`, `/inbox`, `/activity`, `/touched`) is separate from the public relay. Overlay CORS permits the configured relay origin. The relay validates enough to route wire frames and enforce room separation; the owner daemons are the execution and approval boundary.

### Change since the previous `b04b75b` sweep

- `fa3d698` added `wait_for_events` and the browser overlay; `a13383b` added Picture-in-Picture/popup behavior and the Electron tray shell.
- `eb5e18a`, `1f65569`, and `bfb97ff` added artifact types, relay file storage, file chips, daemon upload/download, and `send_file`/`fetch_artifact`.
- `b59933d` added fixed command offers, Git-status file awareness, and Claude Code pre-edit warnings; `b9e4c27` put the new awareness tests in the daemon test script.
- `5eaf3c9` merged the Windows foreground native message-box fix. The user confirmed a `local-smoke` message appeared above Codex with a working OK button. That validates the notification path, not every approval or file path.
- `a87fa94` removed the three-person ownership rules and tracked person-specific task files. The old log has been preserved locally but is untracked; this file is the shared current record.

### How to run this checkout

On Windows, from the repo root, with Node 20+ and Corepack/pnpm available:

```powershell
corepack pnpm install
corepack pnpm -r --if-present typecheck
corepack pnpm -F daemon bundle
$env:PORT = '8090'
corepack pnpm -F relay start
```

Keep the relay terminal open. The bundle must exist **before** relay startup because the relay loads `/mesh.mjs` at startup. In a second PowerShell terminal, from the repo root:

```powershell
corepack pnpm -F daemon start join http://localhost:8090/r/demo --as tarush --background
corepack pnpm -F daemon start status
Invoke-RestMethod http://127.0.0.1:7337/health
```

For a daemon launched from source, replace `status` with `stop` or `log` in that CLI command when needed. For a relay-installed single-file daemon, use `node "$env:USERPROFILE\.mesh\mesh.mjs" status` (or replace `status` with `stop`/`log`). Start a separate observer with `corepack pnpm -F feed start demo --relay ws://localhost:8090`; run `corepack pnpm -F tray start` only if you want the optional floating panel. Open `http://localhost:8090/r/demo` for the room page and overlay. Restart Codex/Cursor/Claude Code after first registration. If port 7337 is occupied by an existing daemon, check its status or stop it before joining another room.

For teammates on other laptops, `localhost` is not reachable. Host the relay publicly via `scripts/tunnel-relay.sh` on a Bash machine with configured ngrok (bundles and starts relay on 8090) or the Railway Docker path, then share the full keyed link `https://<host>/r/<room>#k=<key>`. The Windows room page provides the PowerShell installer/`.cmd` launcher; it needs Node 20+ but no repo clone. Re-running the installer refreshes the bundle and restarts the daemon. From the repo, `corepack pnpm -F daemon start join 'https://<host>/r/<room>#k=<key>' --as <handle> --background` joins directly. A local `team.json` is optional for custom shell offers, permissions, working directory, or import filters. `--config` should be an absolute path when using `pnpm -F daemon start`.

On this machine at sweep time, `GET http://127.0.0.1:7337/health` returned `user=tarush`, `relay=connected`, and `members=2`; the existing background daemon is already usable. This health result does not establish that its downloaded bundle equals this checkout.

### Verification and remaining limits

```text
corepack pnpm -r --if-present typecheck       PASS (protocol, daemon, relay, feed, tray)
corepack pnpm -F daemon bundle                PASS (2.5 MB mesh.mjs)
corepack pnpm -F daemon start status          PASS (running, relay connected, two members)
corepack pnpm -F relay test                  PASS (wire/room and file-store/overlay suites)
tsx apps/daemon/test/mcp.test.ts             PASS (12 tools, import, MCP routes)
tsx apps/daemon/test/pending.test.ts         PASS (watcher approval and fallback)
tsx apps/daemon/test/touched.test.ts         PASS (coordination warning)
corepack pnpm -F daemon test                 FAIL (Windows slow-tree job still running after test's 10 s wait)
tsx apps/daemon/test/artifacts.test.ts       FAIL (test expects POSIX /work paths; shell fixture request denied, so transfer assertions abort)
tsx apps/daemon/test/gitwatch.test.ts        FAIL (Git returned slash-normalized Windows path, test expects backslashes; subsequent watcher assertions passed)
```

The artifact and Git-watch failures are Windows test portability/fixture problems based on their observed output; they do **not** prove the shipped file path works end to end on Windows. The daemon timeout failure was also in the previous sweep. `tsx` child processes sometimes hit sandbox `spawn EPERM`; the standalone failing tests above were rerun outside the sandbox. No live three-laptop artifact/MCP borrow or packaged tray verification was performed in this sweep.

Code/documentation follow-ups: `apps/relay/src/web.ts` uses ring-buffer array indexes for `/api/rooms/:room?since=`, so after 200 frames the room page's cursor can stop advancing (terminal feed uses live WebSocket). The prior disconnected-request queue/outcome concern remains to be tested. `docs/NEXT.md` still describes some shipped overlay/wait features as upcoming; reconcile its historical plan with `docs/OVERLAY-API.md`/`docs/FILES-API.md`. The permanent Railway deployment, a live Figma export, a keyed imported-MCP borrow, and a full multi-laptop rehearsal still need fresh evidence.

## 2026-09-13 — opt-in Codex wake from mesh messages

Tarush asked for an incoming mesh message to start Codex without opening another window. `team.json` now supports `codexWake` (default `false`; enabled in Tarush's ignored local config). When enabled, the daemon gives each fresh message/file to a separate hidden `codex exec` run, using the same saved Codex config and localhost mesh MCP registration. Runs are serial, replayed IDs are deduplicated in `~/.mesh/codex-wake-seen.json`, and the result appears in a native alert even when a browser overlay is attached. The background agent cannot approve mesh requests for the owner. `--no-codex-wake` temporarily disables the feature. This is a separate Codex run, not a new turn in an already-open Codex desktop thread. OpenAI's [non-interactive mode](https://developers.openai.com/codex/non-interactive-mode) documents the CLI, default config reuse, and JSONL output.

Evidence: the five-package typecheck, focused `codex-wake.test.ts`, and daemon MCP suite pass. A harmless hidden `codex exec` returned `MESH_WAKE_OK`; another used the registered `mesh.list_teammates` tool and returned `MESH_MCP_OK tarush`. After bundling and restarting Tarush's installed daemon in the same room, a self-addressed `wake-smoke` relay message was queued and completed automatically (`MESH_WAKE_LIVE_OK`, thread `01a09844-2eed-78b1-87bf-a92b3ec047cd`). The daemon stayed connected with two teammates, and the dedupe state stored one message ID. The existing Windows slow-tree timeout assertion still makes `pnpm -F daemon test` fail; no push was made. The native alert call was exercised by the live wake path, but this sweep did not independently observe the user's screen after that call.

## 2026-09-13 — hide the recurring Windows git poll; join keyed relay

The five-second git watcher launched a console `git status` without `windowsHide`, matching Tarush's recurring command-window flash. Both its poll and initial `git rev-parse` now use `windowsHide: true`; the Codex availability probe also hides its one-time `where.exe` launch. The hidden `codex exec` path is unchanged. The Git-watch test's Windows slash-normalization assertion was corrected, and the focused Git-watch and Codex-wake suites pass.

The partner relay began requiring room keys while Tarush's old daemon was still in a keyless room. This branch fast-forwarded to `origin/main`'s keyed room implementation and retained the Codex-wake/window changes. Tarush's new room name and key were saved only to ignored `team.json` and the daemon's private join config; no key is in tracked files. The installed bundle was rebuilt and restarted. `mesh status` reported `tarush@zephyr-a9cc`, `relay=connected`, and a teammate present; the log showed `Codex wake: on` and `git watch: on`. Five-package typecheck, the daemon key/MCP/Git-watch/Codex-wake suites, relay tests, bundle, and `git diff --check` passed. The full daemon test command retains its preexisting Windows slow-tree timeout failure.
