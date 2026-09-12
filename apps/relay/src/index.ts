/**
 * mesh relay — dumb WebSocket fan-out by room.
 * Spec: docs/tasks/TARUSH.md Step 1, docs/CONTRACT.md §1.
 */
import http from "node:http";
import { URL } from "node:url";
import { WebSocketServer, WebSocket, type RawData } from "ws";
import { HISTORY_LIMIT, type Offer, type Role } from "@mesh/protocol";

const PORT = Number(process.env.PORT) || 8080;

interface Conn {
  ws: WebSocket;
  user: string;
  role: Role;
  offers: Offer[];
  alive: boolean;
}

interface Room {
  conns: Set<Conn>;
  history: string[]; // raw JSON strings, ≤ HISTORY_LIMIT
}

const rooms = new Map<string, Room>();

function getOrCreateRoom(name: string): Room {
  let room = rooms.get(name);
  if (!room) {
    room = { conns: new Set(), history: [] };
    rooms.set(name, room);
  }
  return room;
}

function counts(): { rooms: number; connections: number } {
  let connections = 0;
  for (const room of rooms.values()) connections += room.conns.size;
  return { rooms: rooms.size, connections };
}

function presencePayload(room: Room): string {
  const members = [...room.conns].map((c) => ({
    user: c.user,
    role: c.role,
    offers: c.offers,
  }));
  return JSON.stringify({ type: "presence", members });
}

function broadcastPresence(room: Room): void {
  const payload = presencePayload(room);
  for (const c of room.conns) {
    if (c.ws.readyState === WebSocket.OPEN) c.ws.send(payload);
  }
}

function sendError(ws: WebSocket, message: string): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "error", message }));
  }
}

function parseRole(raw: string | null): Role | null {
  if (raw === "daemon" || raw === "feed") return raw;
  return null;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  if (req.method === "GET" && url.pathname === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(counts()));
    return;
  }
  res.writeHead(404, { "content-type": "text/plain" });
  res.end("not found");
});

const wss = new WebSocketServer({ server });

wss.on("connection", (ws, req) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const roomName = url.searchParams.get("room");
  const user = url.searchParams.get("user");
  const role = parseRole(url.searchParams.get("role"));

  if (!roomName || !user || !role) {
    sendError(ws, "missing or invalid query params: require room, user, role=daemon|feed");
    ws.close();
    return;
  }

  const room = getOrCreateRoom(roomName);
  const conn: Conn = { ws, user, role, offers: [], alive: true };
  room.conns.add(conn);

  ws.on("pong", () => {
    conn.alive = true;
  });

  ws.on("message", (data: RawData, isBinary: boolean) => {
    if (isBinary) return;
    const raw = typeof data === "string" ? data : data.toString("utf8");

    let type: unknown;
    try {
      const obj = JSON.parse(raw) as { type?: unknown; offers?: unknown };
      type = obj.type;
      if (type === "hello") {
        // Cache offers for presence; do not put hello in history or forward it.
        const offers = Array.isArray(obj.offers) ? (obj.offers as Offer[]) : [];
        conn.offers = offers;
        broadcastPresence(room);
        for (const frame of room.history) {
          if (ws.readyState === WebSocket.OPEN) ws.send(frame);
        }
        return;
      }
    } catch {
      // Malformed JSON: still forward verbatim below if we want? Task says parse only type.
      // If we can't read type, treat as non-hello and forward.
      type = undefined;
    }

    // Non-hello: history + forward to every other conn.
    room.history.push(raw);
    if (room.history.length > HISTORY_LIMIT) {
      room.history.splice(0, room.history.length - HISTORY_LIMIT);
    }
    for (const other of room.conns) {
      if (other === conn) continue;
      if (other.ws.readyState === WebSocket.OPEN) other.ws.send(raw);
    }
  });

  const cleanup = () => {
    room.conns.delete(conn);
    if (room.conns.size === 0) {
      rooms.delete(roomName);
    } else {
      broadcastPresence(room);
    }
  };

  ws.on("close", cleanup);
  ws.on("error", () => {
    try {
      ws.close();
    } catch {
      /* ignore */
    }
  });
});

// Ping every 25s; terminate dead sockets.
const pingInterval = setInterval(() => {
  for (const [name, room] of rooms) {
    let removed = false;
    for (const conn of [...room.conns]) {
      if (!conn.alive) {
        conn.ws.terminate();
        room.conns.delete(conn);
        removed = true;
        continue;
      }
      conn.alive = false;
      if (conn.ws.readyState === WebSocket.OPEN) conn.ws.ping();
    }
    if (room.conns.size === 0) rooms.delete(name);
    else if (removed) broadcastPresence(room);
  }
}, 25_000);

pingInterval.unref?.();

server.listen(PORT, () => {
  console.log(`mesh relay listening on :${PORT} (ws + GET /health)`);
});
