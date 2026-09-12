# Dev — `packages/protocol` + `apps/daemon`

Subscription: Claude Max 20x. You are on the critical path for steps 0, 2, 3. Run two Claude Code sessions in parallel git worktrees if useful: one on `packages/protocol` (fast), one on the daemon.

## Deliverables
1. `packages/protocol/src/index.ts` — every type in CONTRACT.md §1-3 plus zod schemas for each `Frame` and each MCP tool input. Export `parseFrame(json: unknown): Frame` that throws on invalid. (Step 0, target: first hour.)
2. `apps/daemon` — `mesh join`, `mesh ask`, `mesh init`, local MCP server. (Steps 2-3.)
3. S2: deny path polished (clear error text in tool result), `never` permission demoable.

## Stack
Node 22, TypeScript, `tsx` for dev, `ws`, `@modelcontextprotocol/sdk` (StreamableHTTPServerTransport), `zod`, `commander`, `shell-quote` (for the offer-matching first token), `chalk`. One `package.json` in `apps/daemon` with `bin: { mesh: ./dist/cli.js }`; `pnpm -F daemon start -- join rho --as dev` during the hackathon, `npx` packaging only if time.

## Step 2 — daemon without MCP (acceptance: `mesh ask tarush "echo hi"` from your laptop prints `hi` on both)
- `mesh join`: load `team.json` (path flag or `./team.json` or `~/.mesh/team.json`), validate with the protocol schema, connect to `relay?room=&user=&role=daemon`, send `hello` with offers, reconnect with backoff on close.
- On `request` where `to === me`: run the matching rule (CONTRACT §2). For `ask`: print
  `\n⚡ dev wants to run: figma-export 8fA 12:34\n   why: need the frame to match\n   [y/n] ` and read one keypress (raw mode, `process.stdin`). Emit `decision`.
- On approve/auto: `spawn('/bin/sh', ['-c', command], { cwd, timeout })`, forward stdout/stderr as `output` frames (chunk ≤ 4 KB, coalesce with a 50 ms flush), then `result` with exitCode, durationMs, timedOut, tail.
- `mesh ask <who> "<cmd>" --why "…"`: connects as a throwaway daemon with no offers, emits `request`, prints streamed output, exits with the remote exit code. This is the demo fallback if MCP misbehaves.
- Keep a `jobs: Map<id, Job>` and a ring buffer of the last 200 frames seen (`activity`).
- Log every frame you send/receive at debug level behind `MESH_DEBUG=1`.

## Step 3 — MCP server (acceptance: Claude Code calls `ask_teammate` and gets stdout in the tool result)
- Express or Node http on `--port` (default 7337). Mount `StreamableHTTPServerTransport` at `/mcp` (stateless mode is fine). Also `POST /event`, `GET /activity`, `GET /health` per CONTRACT §5.
- Implement the five tools with the exact descriptions from CONTRACT §3. `ask_teammate` awaits a promise that resolves on `result` or `decision: denied`, with `waitSeconds` timeout returning `{ status: 'running' }`.
- Test: `claude mcp add --transport http mesh http://localhost:7337/mcp`, then in Claude Code: "list my teammates" → "ask tarush to run echo hello". Confirm the tool result contains `hello`.
- Watch for: Claude Code caches tool lists per session — restart the session after changing tool schemas. MCP tool calls time out client-side; keep default `waitSeconds` at 45.

## Don'ts
- Don't touch `apps/relay`, `apps/feed`, `hooks/`, `scripts/`.
- Don't add auth, config UIs, persistence, or a web server beyond `/mcp` + three routes.
- Don't try to stream partial output into the MCP tool result; return on completion or `running`.

## Definition of done
Steps 0, 2, 3 acceptance tests pass with Tarush's deployed relay, from two different laptops. `MESH_DEBUG=1` log of a full request→result cycle pasted into `docs/tasks/DEV.md` under "Evidence".
