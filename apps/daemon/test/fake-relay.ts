/**
 * Minimal relay per CONTRACT §1, for the daemon's own tests only (the real one lives in apps/relay).
 * Rooms by query param; every frame forwarded to the other connections in the room; offers cached
 * from `hello`; `presence` broadcast on join/leave; last 200 frames replayed after hello.
 */
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

export function startFakeRelay(port: number): Promise<{ close(): Promise<void>; port: number }> {
  const rooms = new Map<string, Room>();
  const wss = new WebSocketServer({ port });

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
    wss.once("error", reject);
    wss.once("listening", () => {
      const addr = wss.address();
      const bound = typeof addr === "object" && addr ? addr.port : port;
      resolve({
        port: bound,
        close: () =>
          new Promise<void>((res) => {
            for (const c of wss.clients) c.terminate();
            wss.close(() => res());
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
