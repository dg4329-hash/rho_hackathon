/**
 * Mock daemon — stands in for apps/daemon's local HTTP surface (CONTRACT §4/§5) so the
 * hooks can be tested end-to-end before Dev's daemon exists. No MCP, no approvals.
 *
 *   POST /event                    { kind, summary, data? } → broadcast as an `event` frame
 *   GET  /activity?sinceMinutes=10 { events: [{ ts, from, type, summary }] }
 *   GET  /health                   { user, room, relay, members }
 *
 * Usage:  pnpm -F feed mock-daemon                         # user dev, room rho, ws://localhost:8080
 *         MESH_USER=tarush MESH_RELAY=wss://… pnpm -F feed mock-daemon
 */
import { createServer } from "node:http";
import WebSocket from "ws";
import { parseFrame, DEFAULT_PORT, HISTORY_LIMIT } from "@mesh/protocol";
import type { Frame } from "@mesh/protocol";

const user = process.env.MESH_USER ?? "dev";
const room = process.env.MESH_ROOM ?? "rho";
const relay = process.env.MESH_RELAY ?? "ws://localhost:8080";
const port = Number(process.env.PORT ?? DEFAULT_PORT);

type Activity = { ts: string; from: string; type: string; summary: string };
const activity: Activity[] = [];
let members = 0;
let ws: WebSocket | null = null;

function remember(a: Activity) {
  activity.push(a);
  if (activity.length > HISTORY_LIMIT) activity.shift();
}

/** Flatten any frame into one activity line, like team_activity does. */
function toActivity(f: Frame): Activity | null {
  switch (f.type) {
    case "event": return { ts: f.ts, from: f.from, type: f.kind, summary: f.summary };
    case "request": return { ts: f.ts, from: f.from, type: "request", summary: `→ ${f.to}: ${f.command ?? `${f.tool} ${JSON.stringify(f.args ?? {})}`}` };
    case "decision": return { ts: f.ts, from: f.from, type: "decision", summary: f.decision + (f.reason ? ` (${f.reason})` : "") };
    case "result": return { ts: f.ts, from: f.from, type: "result", summary: f.timedOut ? "timed out" : `exit ${f.exitCode}` };
    default: return null;
  }
}

function connect() {
  ws = new WebSocket(`${relay.replace(/\/$/, "")}/?room=${room}&user=${user}&role=daemon`);
  ws.on("open", () => {
    ws!.send(JSON.stringify({ type: "hello", from: user, ts: new Date().toISOString(), role: "daemon", offers: [] }));
    console.log(`relay connected ${relay} as ${user}@${room}`);
  });
  ws.on("message", (raw) => {
    try {
      const f = parseFrame(raw.toString());
      if (f.type === "presence") members = f.members.length;
      const a = toActivity(f);
      if (a) remember(a);
    } catch { /* ignore junk */ }
  });
  ws.on("error", () => {});
  ws.on("close", () => { console.log("relay disconnected, retrying in 2s"); setTimeout(connect, 2000); });
}
connect();

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  const json = (code: number, body: unknown) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };

  if (req.method === "POST" && url.pathname === "/event") {
    let buf = "";
    for await (const c of req) buf += c;
    try {
      const { kind, summary, data } = JSON.parse(buf);
      const frame = { type: "event", from: user, ts: new Date().toISOString(), kind, summary, data };
      parseFrame(frame); // validate against the contract
      remember({ ts: frame.ts, from: user, type: kind, summary });
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame));
      console.log(`event  ${kind}: ${String(summary).slice(0, 80)}`);
      return json(200, { ok: true });
    } catch (e) {
      return json(400, { ok: false, error: String(e) });
    }
  }
  if (req.method === "GET" && url.pathname === "/activity") {
    const since = Date.now() - Number(url.searchParams.get("sinceMinutes") ?? 10) * 60_000;
    return json(200, { events: activity.filter((a) => Date.parse(a.ts) >= since).slice(-100) });
  }
  if (req.method === "GET" && url.pathname === "/health") {
    return json(200, { user, room, relay: ws?.readyState === WebSocket.OPEN ? "connected" : "disconnected", members });
  }
  json(404, { error: "not found" });
}).listen(port, () => console.log(`mock daemon on http://localhost:${port}  (POST /event, GET /activity, GET /health)`));
