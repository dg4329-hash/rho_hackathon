/**
 * Minimal relay per CONTRACT §1, for the daemon's own tests only (the real one lives in apps/relay).
 * Rooms by query param; every frame forwarded to the other connections in the room; offers cached
 * from `hello`; `presence` broadcast on join/leave; last 200 frames replayed after hello.
 * Plus the two artifact routes of docs/FILES-API.md, in memory: POST /api/files/<room>, GET /api/files/<room>/<id>[/meta].
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import { HISTORY_LIMIT, type Offer, type Role } from "@mesh/protocol";

interface Conn {
  ws: WebSocket;
  user: string;
  role: Role;
  offers: Offer[];
  helloed: boolean;
}

interface Room {
  conns: Set<Conn>;
  history: string[];
}

interface StoredFile { id: string; name: string; mime: string; size: number; from: string; ts: string; bytes: Buffer }
const FILE_LIMIT = 25 * 1024 * 1024;

export function startFakeRelay(port: number): Promise<{ close(): Promise<void>; port: number }> {
  const rooms = new Map<string, Room>();
  const files = new Map<string, Map<string, StoredFile>>(); // room → id → file
  const http = createServer((req, res) => handleFiles(req, res));
  const wss = new WebSocketServer({ server: http });

  function handleFiles(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url ?? "/", "http://x");
    const m = url.pathname.match(/^\/api\/files\/([^/]+)(?:\/([^/]+))?(\/meta)?$/);
    if (!m) { res.writeHead(404).end("not found"); return; }
    const roomName = decodeURIComponent(m[1]!);
    const id = m[2] ? decodeURIComponent(m[2]) : undefined;
    if (req.method === "POST" && !id) {
      const chunks: Buffer[] = [];
      let total = 0;
      req.on("data", (c: Buffer) => { chunks.push(c); total += c.length; if (total > FILE_LIMIT) { res.writeHead(413).end("too large"); req.destroy(); } });
      req.on("end", () => {
        if (res.writableEnded) return;
        const bytes = Buffer.concat(chunks);
        const file: StoredFile = {
          id: randomUUID().slice(0, 12),
          name: String(req.headers["x-mesh-name"] ?? "file"),
          mime: String(req.headers["x-mesh-mime"] ?? "application/octet-stream"),
          size: bytes.length,
          from: String(req.headers["x-mesh-from"] ?? "?"),
          ts: new Date().toISOString(),
          bytes,
        };
        let r = files.get(roomName);
        if (!r) files.set(roomName, (r = new Map()));
        r.set(file.id, file);
        const addr = http.address();
        const p = typeof addr === "object" && addr ? addr.port : port;
        const body = JSON.stringify({ id: file.id, name: file.name, mime: file.mime, size: file.size, url: `http://127.0.0.1:${p}/api/files/${encodeURIComponent(roomName)}/${file.id}` });
        res.writeHead(201, { "content-type": "application/json" }).end(body);
      });
      return;
    }
    if (req.method === "GET" && id) {
      const file = files.get(roomName)?.get(id);
      if (!file) { res.writeHead(404).end("gone"); return; }
      if (m[3]) {
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ id: file.id, name: file.name, mime: file.mime, size: file.size, from: file.from, ts: file.ts }));
        return;
      }
      res.writeHead(200, {
        "content-type": file.mime,
        "content-length": String(file.size),
        "content-disposition": `inline; filename="${file.name.replace(/"/g, "")}"`,
        "cache-control": "private, max-age=3600",
      }).end(file.bytes);
      return;
    }
    res.writeHead(405).end("method not allowed");
  }

  const room = (name: string): Room => {
    let r = rooms.get(name);
    if (!r) rooms.set(name, (r = { conns: new Set(), history: [] }));
    return r;
  };
  const presence = (r: Room) =>
    JSON.stringify({
      type: "presence",
      members: [...r.conns].filter((c) => c.helloed).map((c) => ({ user: c.user, role: c.role, offers: c.offers })),
    });
  const broadcast = (r: Room, raw: string, except?: Conn) => {
    for (const c of r.conns) if (c !== except && c.ws.readyState === WebSocket.OPEN) c.ws.send(raw);
  };

  wss.on("connection", (ws, req) => {
    const url = new URL(req.url ?? "/", "http://x");
    const roomName = url.searchParams.get("room");
    const user = url.searchParams.get("user");
    const role = url.searchParams.get("role");
    if (!roomName || !user || (role !== "daemon" && role !== "feed")) {
      ws.send(JSON.stringify({ type: "error", message: "room, user and role=daemon|feed are required" }));
      ws.close();
      return;
    }
    const r = room(roomName);
    const conn: Conn = { ws, user, role, offers: [], helloed: false };
    r.conns.add(conn);

    ws.on("message", (data) => {
      const raw = data.toString();
      let frame: { type?: string; offers?: Offer[] };
      try {
        frame = JSON.parse(raw);
      } catch {
        return;
      }
      if (frame.type === "hello") {
        conn.offers = Array.isArray(frame.offers) ? frame.offers : [];
        const first = !conn.helloed;
        conn.helloed = true;
        if (first) for (const h of r.history) ws.send(h);
        broadcast(r, presence(r));
        r.history.push(raw);
      } else {
        r.history.push(raw);
        broadcast(r, raw, conn);
      }
      if (r.history.length > HISTORY_LIMIT) r.history.splice(0, r.history.length - HISTORY_LIMIT);
    });
    ws.on("close", () => {
      r.conns.delete(conn);
      broadcast(r, presence(r));
    });
  });

  return new Promise((resolve, reject) => {
    http.once("error", reject);
    http.listen(port, () => {
      const addr = http.address();
      const bound = typeof addr === "object" && addr ? addr.port : port;
      resolve({
        port: bound,
        close: () =>
          new Promise<void>((res) => {
            for (const c of wss.clients) c.terminate();
            wss.close(() => { http.closeAllConnections?.(); http.close(() => res()); });
          }),
      });
    });
  });
}

// Standalone: `tsx test/fake-relay.ts [port]`
const invokedDirectly = process.argv[1] && /fake-relay\.[cm]?[jt]s$/.test(process.argv[1]);
if (invokedDirectly) {
  const port = Number(process.argv[2]) || 8080;
  startFakeRelay(port).then(({ port: p }) => console.log(`fake relay listening on ws://localhost:${p}`));
}
