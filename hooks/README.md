# hooks — make Claude Code show up in the feed

`emit.js` turns Claude Code hook events into `event` frames via the local daemon (`POST localhost:7337/event`, CONTRACT §4). On every prompt it also pulls the last 10 minutes of team activity into the agent's context.

```bash
hooks/install.sh              # into ./.claude/settings.json (backs up first, idempotent)
hooks/install.sh ~/code/app   # into another repo
```

Test without Claude Code:
```bash
echo '{"prompt":"hello team","cwd":"/tmp","session_id":"abc123"}' | node hooks/emit.js prompt
echo '{"tool_name":"Edit","tool_input":{"file_path":"/tmp/src/a.ts"},"cwd":"/tmp"}' | node hooks/emit.js file_touched
```

Daemon on a non-default port? `MESH_DAEMON=http://localhost:7402 node hooks/emit.js prompt`.

No daemon running? It exits 0 silently. Slow daemon? 1 s timeout, exits 0. The hook can never block the agent.

Cursor has no hooks, so Cursor users appear in the feed only via requests and decisions.

Until Dev's daemon exists: `pnpm -F feed mock-daemon` fakes `/event` + `/activity` and forwards to the relay.
