# mesh — borrow a teammate's machine, not their credentials

> Working name. Rename freely; nothing depends on it.

Your coding agent (Claude Code, Cursor, Codex) can ask a teammate's laptop to run a command
it doesn't have the tools or credentials for. The teammate sees `dev wants to run: figma-export …  [y/n]`,
hits **y**, and the output streams back to your agent. Credentials never leave the owner's machine.
Every terminal in the room sees what every agent is doing.

## Assignments
| person | role | task file |
|---|---|---|
| **Dev** | `packages/protocol`, `apps/daemon` (join, approvals, MCP import, local MCP server) | [docs/tasks/DEV.md](docs/tasks/DEV.md) |
| **Tarush** | `apps/relay`, deploy, real MCP servers on his laptop, `scripts/figma-export.sh` | [docs/tasks/TARUSH.md](docs/tasks/TARUSH.md) |
| **Abhi** | `apps/feed`, `hooks/`, `docs/DEMO.md`, pitch | [docs/tasks/ABHI.md](docs/tasks/ABHI.md) |

Agents: read `AGENTS.md` first. It tells you which files you may touch.

**Read in this order:**
1. `docs/PLAN.md` — pitch, architecture, build order, checkpoints, demo script
2. `docs/CONTRACT.md` — the wire protocol, MCP tools, and `team.json`. Everyone codes against this.
3. Your task file: `docs/tasks/DEV.md`, `docs/tasks/TARUSH.md`, `docs/tasks/ABHI.md`
4. `docs/RESEARCH.md` — competitors and why we're different (read before the pitch)

## Layout
```
apps/relay      WebSocket relay with rooms                     — Tarush
apps/daemon     `mesh join` + local MCP server + approvals     — Dev
apps/feed       `mesh feed`, hooks, demo                        — Abhi
packages/protocol   shared TS types for every message/tool     — Dev writes, everyone imports
scripts/        figma-export.sh and other offered commands     — Tarush
docs/
```

## Rules that keep three agents from colliding
- Only edit your own `apps/<yours>` dir, `scripts/` (Tarush), and `docs/tasks/<YOU>.md`.
- `packages/protocol` and `docs/CONTRACT.md` change only by editing CONTRACT.md **and telling the other two**.
- Commit small, push often, `git pull --rebase` before push. No long-lived branches; work on `main`.
- Each step in PLAN.md has an acceptance test. Don't move on until it passes.

## Quick start (once things exist)
```bash
pnpm install
pnpm -F relay dev                              # Tarush's laptop or Railway
pnpm -F daemon start join rho --as dev      # each laptop, reads ./team.json
claude mcp add --transport http mesh http://localhost:7337/mcp
pnpm -F feed start rho                      # optional second pane: live team feed
```
