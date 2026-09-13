/**
 * Minimal relay per CONTRACT §1, for the daemon's own tests only (the real one lives in apps/relay).
 * Rooms by query param; every frame forwarded to the other connections in the room; offers cached
 * from `hello`; `presence` broadcast on join/leave; last 200 frames replayed after hello.
 * Plus the two artifact routes of docs/FILES-API.md, in memory: POST /api/files/<room>, GET /api/files/<room>/<id>[/meta].
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
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

const B32 = "abcdefghijklmnopqrstuvwxyz234567"; // RFC 4648, lowercase

/** docs/ROOM-KEYS.md: `base32lower(HMAC-SHA256(ROOM_SECRET, room))[:16]`. Must match the relay's. */
export function roomKey(secret: string, room: string): string {
  const mac = createHmac("sha256", secret).update(room).digest();
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of mac) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    if (out.length >= 16) break;
  }
  return out.slice(0, 16);
}

function sameKey(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export interface FakeRelayOptions {
  /** Enforce room keys exactly as docs/ROOM-KEYS.md describes (default: off). */
  requireKey?: boolean;
  /** ROOM_SECRET the keys are derived from. */
  secret?: string;
}

export interface FakeRelay {
  close(): Promise<void>;
  port: number;
  /** WebSocket connection attempts seen (to prove a rejected client does not reconnect). */
  wsAttempts(): number;
  /** `x-mesh-key` / `?key=` seen on the file routes, oldest first (`null` = none sent). */
  fileKeys(): Array<string | null>;
  /**
   * End a room like the real relay: `room_ended` to every socket, close 4410, forget history, and refuse later connects
   * (error frame + 4410). Returns the number of sockets closed.
   */
  endRoom(room: string, by?: string, reason?: string): number;
  /** `POST /api/rooms/<room>/end` calls seen, oldest first. */
  endCalls(): Array<{ room: string; key: string | null; owner: string | null; body: Record<string, unknown> }>;
}

/** Owner token as the relay derives it: `base32lower(HMAC-SHA256(ROOM_SECRET, "owner:" + room))[:16]`. */
export function ownerToken(secret: string, room: string): string {
  return roomKey(secret, `owner:${room}`);
}
const ENDED_MESSAGE = "this session was ended by its owner";
const ROOM_ENDED_CLOSE = 4410;

export function startFakeRelay(port: number, options: FakeRelayOptions = {}): Promise<FakeRelay> {
  const requireKey = options.requireKey === true;
  const secret = options.secret ?? "test-secret";
  const expected = (room: string) => roomKey(secret, room);
  let wsAttempts = 0;
  const fileKeys: Array<string | null> = [];
  const rooms = new Map<string, Room>();
  const files = new Map<string, Map<string, StoredFile>>(); // room → id → file
  const ended = new Set<string>();
  const endCalls: Array<{ room: string; key: string | null; owner: string | null; body: Record<string, unknown> }> = [];
  const http = createServer((req, res) => handleFiles(req, res));
  const wss = new WebSocketServer({ server: http });

  function endRoom(roomName: string, by?: string, reason?: string): number {
    const message = `${by ?? "the host"} ended the session${reason ? `: ${reason}` : ""}`;
    const frame = JSON.stringify({ type: "room_ended", room: roomName, ...(by ? { by } : {}), message, ts: new Date().toISOString() });
    ended.add(roomName);
    const r = rooms.get(roomName);
    rooms.delete(roomName);
    let closed = 0;
    for (const c of r?.conns ?? []) {
      if (c.ws.readyState !== WebSocket.OPEN) continue;
      c.ws.send(frame);
      c.ws.close(ROOM_ENDED_CLOSE, message.slice(0, 120));
      closed++;
    }
    return closed;
  }

  function handleEnd(req: IncomingMessage, res: ServerResponse, roomName: string, url: URL): void {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      let body: Record<string, unknown> = {};
      try { body = JSON.parse(Buffer.concat(chunks).toString() || "{}"); } catch { /* keep empty */ }
      const key = (req.headers["x-mesh-key"] ? String(req.headers["x-mesh-key"]) : url.searchParams.get("key")) ?? null;
      const owner = (req.headers["x-mesh-owner"] ? String(req.headers["x-mesh-owner"]) : typeof body.owner === "string" ? body.owner : null) ?? null;
      endCalls.push({ room: roomName, key, owner, body });
      const json = (status: number, obj: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(obj));
      if (requireKey && (!key || !sameKey(key, expected(roomName)))) return json(401, { error: key ? "wrong room key" : "room key required" });
      if (!owner || !sameKey(owner, ownerToken(secret, roomName))) return json(403, { error: "only the person who started this session can end it" });
      if (ended.has(roomName)) return json(200, { ok: true, room: roomName, ended: true, closed: 0, alreadyEnded: true });
      const by = typeof body.by === "string" && /^[a-z0-9_-]{1,32}$/.test(body.by) ? body.by : undefined;
      const reason = typeof body.reason === "string" ? body.reason.slice(0, 140) : undefined;
      // Answer after the sockets are closed, like the real relay (the ender's own daemon sees 4410 before this reply).
      const closed = endRoom(roomName, by, reason);
      json(200, { ok: true, room: roomName, ended: true, closed });
    });
  }

  function handleFiles(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url ?? "/", "http://x");
    const end = url.pathname.match(/^\/api\/rooms\/([^/]+)\/end$/);
    if (end && req.method === "POST") { handleEnd(req, res, decodeURIComponent(end[1]!), url); return; }
    const m = url.pathname.match(/^\/api\/files\/([^/]+)(?:\/([^/]+))?(\/meta)?$/);
    if (!m) { res.writeHead(404).end("not found"); return; }
    const roomName = decodeURIComponent(m[1]!);
    const id = m[2] ? decodeURIComponent(m[2]) : undefined;
    const sent = (req.headers["x-mesh-key"] ? String(req.headers["x-mesh-key"]) : url.searchParams.get("key")) ?? null;
    fileKeys.push(sent);
    if (requireKey) {
      if (!sent) { res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: "room key required" })); return; }
      if (!sameKey(sent, expected(roomName))) { res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: "wrong room key" })); return; }
    }
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
    wsAttempts++;
    const url = new URL(req.url ?? "/", "http://x");
    const roomName = url.searchParams.get("room");
    const user = url.searchParams.get("user");
    const role = url.searchParams.get("role");
    if (!roomName || !user || (role !== "daemon" && role !== "feed")) {
      ws.send(JSON.stringify({ type: "error", message: "room, user and role=daemon|feed are required" }));
      ws.close();
      return;
    }
    if (requireKey) {
      const sent = url.searchParams.get("key");
      const message = !sent ? "room key required" : !sameKey(sent, expected(roomName)) ? "wrong room key" : undefined;
      if (message) {
        ws.send(JSON.stringify({ type: "error", message }));
        ws.close(4401, message);
        return;
      }
    }
    if (ended.has(roomName)) {
      ws.send(JSON.stringify({ type: "error", message: ENDED_MESSAGE }));
      ws.close(ROOM_ENDED_CLOSE, ENDED_MESSAGE);
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
        wsAttempts: () => wsAttempts,
        fileKeys: () => fileKeys.slice(),
        endRoom,
        endCalls: () => endCalls.slice(),
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
  const secret = process.env.ROOM_SECRET;
  startFakeRelay(port, secret ? { requireKey: true, secret } : {}).then(({ port: p }) =>
    console.log(`fake relay listening on ws://localhost:${p}${secret ? " (room keys enforced)" : ""}`));
}
