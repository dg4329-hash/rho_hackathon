# Instructions for coding agents working in this repo

One `main` branch; anyone may edit anything. Keep changes small and tested.

## Read, in order
1. `README.md` — what mesh is and how to run it.
2. `docs/CONTRACT.md` — the protocol, MCP tools, config, and CLI. Code must match it; import types from `@mesh/protocol`, never redefine them. If you change behaviour, change the contract in the same commit.
3. `docs/NEXT.md` — current state and what's left.

## How to work
- `pnpm install` once; `pnpm -r typecheck` and the suites (`pnpm -F daemon test`, `pnpm -F daemon exec tsx test/mcp.test.ts`, `pnpm -F relay test`) must pass before every push.
- Small commits, push often: `git pull --rebase origin main && git push`. Commit prefixes: `daemon:`, `relay:`, `feed:`, `hooks:`, `protocol:`, `plugin:`, `overlay:`, `docs:`.
- Never commit secrets: `team.json`, `.env`, tokens. `team.json.example` is the only config in git.
- After changing the daemon, run `pnpm -F daemon bundle` (the relay serves that bundle to everyone who installs).
- If you're blocked on a running service, build against a mock (`apps/daemon/test/fake-relay.ts`, the fixture MCP server) and say so in your commit message.

## What this project is (30 seconds)
`mesh` lets one teammate's coding agent use another teammate's tools, MCP servers, and files through that teammate's own machine, with a one-click approval (overlay, Claude Code prompt, or OS dialog), without credentials ever moving. Three processes: a dumb WebSocket relay that also serves the web front door and the installer, a per-laptop daemon that imports the owner's MCP servers and hosts a local MCP server for their agent, and an optional overlay/feed for visibility. Pitch: *borrow a teammate's machine, not their credentials.*
