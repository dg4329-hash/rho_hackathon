# Tarush — `apps/relay`, deploy, `team.json` tooling, Figma script

Subscription: Cursor Pro (if you actually have the Claude Pro seat, swap files with Abhi; nothing else changes). Your relay unblocks everyone, so step 1 first and fast.

## Deliverables
1. `apps/relay` — the WebSocket relay. (Step 1, target: first hour.)
2. Relay deployed with a public `wss://` URL, pasted into `docs/PLAN.md` §2 and Slack/group chat.
3. `scripts/figma-export.sh` — offered command for the headline demo. (Step 6.)
4. S1: `check_job` long-job path tested end to end with Dev.
5. `mesh init` starter `team.json` content + a `pnpm -F relay validate ./team.json` script using `packages/protocol` schemas.

## Step 1 — relay (acceptance: two `wscat` clients in the same room see each other's frames; a third that joins late receives the replayed history)
- Node 22 + `ws`. One file, `apps/relay/src/index.ts`, `tsx` in dev, `PORT` env.
- On connection: parse `room`, `user`, `role` from the query string; reject with an `error` frame + close if missing.
- Maintain `rooms: Map<room, { conns: Set<{ws,user,role,offers}>, history: Frame[] (≤200) }>`.
- On first `hello` frame from a conn: store its `offers`, then broadcast `presence` (CONTRACT §1) to the whole room including the sender.
- Every other frame: push to history, forward verbatim to every *other* conn in the room. Don't parse beyond `type`.
- On close: remove conn, broadcast `presence`.
- Replay history to a new conn right after its `hello`.
- Ping every 25 s; terminate dead sockets.
- `GET /health` on the same port → `{ rooms: n, connections: n }`.
Test locally: `npx wscat -c "ws://localhost:8080/?room=x&user=a&role=daemon"` twice.

## Deploy (right after step 1 passes)
Railway or Fly, whichever you've used. Fallback: `ngrok http 8080` from your laptop and keep the terminal open. Post the URL. Verify from a phone hotspot that `/health` responds (the venue wifi may block ws on odd ports; Railway's 443 is safest).

## Step 6a — real MCP servers on your laptop (acceptance: `mesh join` prints them as imported; `describe_capability` output for 3 tools reads well)
- Configure 2-3 stdio MCP servers with API keys in your `~/.claude.json` or `.cursor/mcp.json`: Supabase (`@supabase/mcp-server-supabase`), GitHub (`@modelcontextprotocol/server-github`), Linear, or whatever you already have. These are what Dev's agent will borrow in the demo.
- Write `notes` in your `team.json` for the ones the demo uses: project IDs, table names, conventions. Good notes are the difference between the demo agent nailing the call and guessing.
- Set `permissions`: reads `always`, writes `ask`, deletes `never`. We show all three on stage.
- Confirm with Dev which servers imported and which were skipped (OAuth remotes will be).

## Step 6b — `scripts/figma-export.sh <fileKey> <nodeId>` (OAuth fallback for Figma; acceptance: prints a PNG path and a one-paragraph description)
- Needs `FIGMA_TOKEN` in your env only. Never commit it.
- `GET https://api.figma.com/v1/images/:fileKey?ids=:nodeId&format=png&scale=2` → image URL → `curl -o /tmp/mesh-figma-<nodeId>.png`. Print the path.
- `GET https://api.figma.com/v1/files/:fileKey/nodes?ids=:nodeId` → walk `children`, print names, text content, and bounding boxes as a short indented outline. This text is what Dev's agent actually uses to code the screen, so make it readable.
- Verify against the real frame you'll demo **on day one**. This script is the single point of failure for the headline demo.
- Stretch: `scripts/figma-comment.sh <fileKey> "<text>"` to post a comment back to the file (POST `/v1/files/:key/comments`), so the demo shows a write too.

## S1 — long jobs
With Dev: `ask_teammate` on `sleep 70 && echo done` must return `{ status: 'running', jobId }` at 45 s, then `check_job` returns `done`. File any relay-side issues (e.g. frame ordering) you find.

## Don'ts
- Don't add auth, rooms persistence, or a database. Room name is the secret.
- Don't touch `apps/daemon` or `apps/feed`; if you need a protocol change, edit CONTRACT.md + tell Dev.

## Definition of done
Relay deployed and stable for a 30-minute session with three laptops connected. Figma script demoed to the team. Paste `wscat` transcript and Figma script output under "Evidence" below.
