/**
 * mesh relay — dumb WebSocket fan-out by room.
 * Spec: docs/tasks/TARUSH.md Step 1, docs/CONTRACT.md §1.
 *
 * Behaviour (all of it):
 *   connect  ws://host/?room=<room>&user=<user>&role=daemon|feed   → bad/missing params: `error` frame + close
 *   hello    cache offers; on the FIRST hello replay the room's last HISTORY_LIMIT frames (as-is, in order),
 *            then broadcast `presence` to the whole room (sender included). hello is never forwarded or stored.
 *   other    push to history (ring buffer of HISTORY_LIMIT), forward verbatim to every OTHER conn in the room.
 *   close    remove conn, broadcast `presence`.
 *   ping     every PING_MS; a socket that missed the previous pong is terminated.
 *   GET /health  → { rooms, connections }   (same port as the WebSocket server)
 *
 * Presence lists only conns that have sent `hello`; a conn that connected but has not yet announced itself
 * is invisible so nobody ever sees a member with an empty offer list mid-handshake.
 */
import http from "node:http";
import { URL } from "node:url";
import { WebSocketServer, WebSocket, type RawData } from "ws";
import { HISTORY_LIMIT, type Offer, type Role } from "@mesh/protocol";

const PORT = Number(process.env.PORT) || 8080;
const PING_MS = 25_000;

interface Conn {
  ws: WebSocket;
  user: string;
  role: Role;
  offers: Offer[];
  helloed: boolean;
  alive: boolean;
}

interface Room {
  conns: Set<Conn>;
  history: string[]; // raw JSON strings, ≤ HISTORY_LIMIT, oldest first
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

/** Rooms with at least one live connection (an empty room keeps its history until pruned). */
function counts(): { rooms: number; connections: number } {
  let activeRooms = 0;
  let connections = 0;
  for (const room of rooms.values()) {
    if (room.conns.size > 0) activeRooms++;
    connections += room.conns.size;
  }
  return { rooms: activeRooms, connections };
}

function presencePayload(room: Room): string {
  const members = [...room.conns]
    .filter((c) => c.helloed)
    .map((c) => ({ user: c.user, role: c.role, offers: c.offers }));
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

function rawToString(data: RawData): string {
  if (typeof data === "string") return data;
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  return Buffer.from(data).toString("utf8");
}

/** Drop an empty room once its history is gone too, so the map cannot grow forever. */
function maybePrune(name: string, room: Room): void {
  if (room.conns.size === 0 && room.history.length === 0) rooms.delete(name);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  if ((req.method === "GET" || req.method === "HEAD") && url.pathname === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(req.method === "HEAD" ? undefined : JSON.stringify(counts()));
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
    ws.close(1008, "bad query params");
    return;
  }

  const room = getOrCreateRoom(roomName);
  const conn: Conn = { ws, user, role, offers: [], helloed: false, alive: true };
  room.conns.add(conn);
  console.log(`+ ${user} (${role}) joined room "${roomName}" — ${room.conns.size} conn(s)`);

  ws.on("pong", () => {
    conn.alive = true;
  });

  ws.on("message", (data: RawData, isBinary: boolean) => {
    if (isBinary) return;
    const raw = rawToString(data);

    // Parse only far enough to read `type` (and `offers` for hello). Everything else is opaque.
    let obj: { type?: unknown; offers?: unknown };
    try {
      obj = JSON.parse(raw) as { type?: unknown; offers?: unknown };
    } catch {
      sendError(ws, "frame is not valid JSON; dropped");
      return;
    }
    if (typeof obj !== "object" || obj === null) {
      sendError(ws, "frame is not a JSON object; dropped");
      return;
    }

    if (obj.type === "hello") {
      conn.offers = Array.isArray(obj.offers) ? (obj.offers as Offer[]) : [];
      const first = !conn.helloed;
      conn.helloed = true;
      if (first) {
        for (const frame of room.history) {
          if (ws.readyState === WebSocket.OPEN) ws.send(frame);
        }
      }
      broadcastPresence(room);
      return;
    }

    room.history.push(raw);
    if (room.history.length > HISTORY_LIMIT) {
      room.history.splice(0, room.history.length - HISTORY_LIMIT);
    }
    for (const other of room.conns) {
      if (other === conn) continue;
      if (other.ws.readyState === WebSocket.OPEN) other.ws.send(raw);
    }
  });

  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    room.conns.delete(conn);
    console.log(`- ${user} (${role}) left room "${roomName}" — ${room.conns.size} conn(s)`);
    if (conn.helloed) broadcastPresence(room);
    maybePrune(roomName, room);
  };

  ws.on("close", cleanup);
  ws.on("error", (err) => {
    console.error(`ws error for ${user} in "${roomName}": ${err.message}`);
    try {
      ws.terminate();
    } catch {
      /* ignore */
    }
    cleanup();
  });
});

// Ping every PING_MS; terminate sockets that missed the previous pong (their `close` handler does the cleanup).
const pingInterval = setInterval(() => {
  for (const room of rooms.values()) {
    for (const conn of [...room.conns]) {
      if (!conn.alive) {
        console.log(`! ${conn.user} missed pong — terminating`);
        conn.ws.terminate();
        continue;
      }
      conn.alive = false;
      if (conn.ws.readyState === WebSocket.OPEN) conn.ws.ping();
    }
  }
}, PING_MS);
pingInterval.unref?.();

server.listen(PORT, () => {
  console.log(`mesh relay listening on :${PORT} (ws + GET /health)`);
});

function shutdown(signal: string): void {
  console.log(`${signal} — shutting down`);
  clearInterval(pingInterval);
  for (const c of wss.clients) c.terminate();
  wss.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000).unref();
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
