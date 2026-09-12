/**
 * Mock relay for developing `mesh feed` before the real relay (apps/relay) exists.
 *
 * Behaves like CONTRACT §1 from the feed's point of view:
 *   - accepts ws connections on /?room=&user=&role=
 *   - forwards any frame it receives to every other client in the room
 *   - on connect, replays docs/fixtures/sample-frames.jsonl with a delay between frames
 *
 * Usage:  pnpm -F feed mock            # port 8080, 700 ms between frames
 *         PORT=9000 DELAY_MS=200 pnpm -F feed mock
 *         pnpm -F feed mock -- --loop  # replay forever
 *         pnpm -F feed mock -- --file path/to/other.jsonl
 */
import { WebSocketServer, WebSocket } from "ws";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const argv = process.argv.slice(2);
const flag = (name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };

const port = Number(process.env.PORT ?? 8080);
const delayMs = Number(process.env.DELAY_MS ?? 700);
const loop = argv.includes("--loop");
const file = flag("--file") ?? resolve(import.meta.dirname, "../../../docs/fixtures/sample-frames.jsonl");

const frames = readFileSync(file, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const wss = new WebSocketServer({ port });
const clients = new Set<WebSocket>();

wss.on("connection", async (ws, req) => {
  const q = new URL(req.url ?? "/", "http://x").searchParams;
  const who = `${q.get("user") ?? "?"}/${q.get("role") ?? "?"}@${q.get("room") ?? "?"}`;
  console.log(`+ ${who} connected`);
  clients.add(ws);

  ws.on("message", (raw) => {
    const text = raw.toString();
    console.log(`  ${who} → ${text.slice(0, 80)}`);
    for (const c of clients) if (c !== ws && c.readyState === WebSocket.OPEN) c.send(text);
  });
  ws.on("close", () => { clients.delete(ws); console.log(`- ${who} disconnected`); });

  do {
    for (const f of frames) {
      if (ws.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify(f));
      await sleep(delayMs);
    }
  } while (loop && ws.readyState === WebSocket.OPEN);
});

console.log(`mock relay on ws://localhost:${port}  (${frames.length} frames from ${file}, ${delayMs} ms apart${loop ? ", looping" : ""})`);
