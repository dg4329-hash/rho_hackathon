# Instructions for coding agents working in this repo

Three people, three agents, one `main` branch. Follow this file exactly.

## Step 1 — find out who you are
Ask the user "Are you Dev, Tarush, or Abhi?" if it isn't obvious from the machine (`whoami`, git config user.name) or the conversation. Then open **only** your task file:

| person | role | task file | owns (may edit) |
|---|---|---|---|
| **Dev** | protocol + daemon + local MCP server | `docs/tasks/DEV.md` | `packages/protocol/**`, `apps/daemon/**`, `docs/tasks/DEV.md` |
| **Tarush** | relay + deploy + real MCP servers + Figma script | `docs/tasks/TARUSH.md` | `apps/relay/**`, `scripts/**`, `docs/tasks/TARUSH.md`, the relay URL line in `docs/PLAN.md` |
| **Abhi** | feed + hooks + demo/pitch | `docs/tasks/ABHI.md` | `apps/feed/**`, `hooks/**`, `docs/DEMO.md`, `docs/fixtures/**`, `docs/tasks/ABHI.md` |

Everything else (`docs/CONTRACT.md`, `docs/PLAN.md`, `README.md`, root configs, other people's dirs) is **read-only for you**. If you need a change there, stop and tell your user to message the owner (contract changes go to Dev).

## Step 2 — read, in order
1. `README.md` (2 min)
2. `docs/CONTRACT.md` — the protocol. Your code must match it and `packages/protocol/src/index.ts`. Import types from `@mesh/protocol`; never redefine them.
3. Your task file. Work through its steps in order. Each step has an acceptance test; run it before moving on.
4. `docs/PLAN.md` §3 for where your step sits in the build order.

## Step 3 — how to work
- Small commits, push often: `git pull --rebase origin main && git push`. No feature branches unless your user asks (current exception: the Claude Code plugin on `dev/plugin`).
- Commit message prefix: `relay:`, `daemon:`, `feed:`, `hooks:`, `protocol:`, `docs:`.
- Run `pnpm typecheck` before every push. Don't push red.
- Node 22, pnpm 10, TypeScript, ESM. `tsx` for dev. No new top-level dependencies without noting them in your task file.
- When a step's acceptance test passes, append a short "Evidence" note (command + output excerpt) to the bottom of your task file and commit it. That is how the others know you're done.
- Never commit secrets: `team.json`, `.env`, tokens. `team.json.example` is the only config that goes in git.
- If you're blocked on another person's piece, build against a mock (Abhi's fixtures, Dev's `mesh ask` CLI, a local relay) and say so in your Evidence note.

## What this project is (30 seconds)
`mesh` lets one teammate's coding agent use another teammate's tools and MCP servers through that teammate's own machine, with an owner approval (native OS dialog, or `[y/n]` in the terminal), without credentials ever moving. Three processes: a dumb WebSocket **relay** that also serves the room page and the one-command installers (Tarush), a per-laptop **daemon** installed by one `curl` that imports the owner's MCP servers, registers itself with Claude Code / Codex / Cursor, and hosts a local MCP server with eight tools (Dev), and a terminal **feed** plus hooks that make it visible (Abhi). Pitch: *borrow a teammate's machine, not their credentials.*

Facts that changed recently (keep docs consistent with these): join is zero-config (room name or room link, no `team.json` needed); registration and hooks are installed by `mesh join`; approvals are native dialogs first, TTY second; `mesh join --background` / `status` / `stop` / `log` exist; tools are eight (`send_message`, `inbox` added). `docs/CONTRACT.md` is authoritative.
