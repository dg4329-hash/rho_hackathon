/**
 * mesh relay — dumb WebSocket fan-out by room.
 * Spec: docs/tasks/TARUSH.md Step 1, docs/CONTRACT.md §1.
 *
 * Behaviour (all of it):
 *   connect  ws://host/?room=<room>&user=<user>&role=daemon|feed&key=<roomKey>
 *            → bad/missing params: `error` frame + close 1008; missing/wrong key: `error` frame + close 4401 (docs/ROOM-KEYS.md)
 *            → per-IP connect rate limit or room cap reached: `error` frame + close 1013
 *            → first hello from a role=daemon conn WITH offers while another offering daemon of the same user is in the room:
 *              the existing conn is pinged; if it answers within DUP_PROBE_MS the newcomer gets `error` + close 4409, otherwise
 *              the silent one is terminated and the newcomer proceeds (a reconnect after a dropped network must still get in).
 *              Frames sent meanwhile are buffered. No-offer daemons (`mesh ask` under the owner's own name) are never refused.
 *   hello    cache offers; on the FIRST hello replay the room's last HISTORY_LIMIT frames (as-is, in order),
 *            then broadcast `presence` to the whole room (sender included). hello is never forwarded or stored.
 *   other    push to history (ring buffer of HISTORY_LIMIT frames and ≤ HISTORY_MAX_BYTES), forward verbatim to every OTHER conn.
 *   close    remove conn, broadcast `presence`.
 *   ping     every PING_MS; a socket that missed the previous pong is terminated.
 *   sweep    rooms with no connections for ROOM_IDLE_MS are forgotten (only history is lost; keys are derived, links keep working).
 *   GET /health  → { rooms, connections }   (same port as the WebSocket server)
 *   GET /, /r/:room, /api/rooms…, /install.sh, /install.ps1, /mesh.mjs, /emit.js  → web.ts (front door + one-command join)
 *   POST/GET /api/files/:room[/:id[/meta]]  → files.ts (in-memory artifacts, docs/FILES-API.md)
 *
 * Presence lists only conns that have sent `hello`; a conn that connected but has not yet announced itself
 * is invisible so nobody ever sees a member with an empty offer list mid-handshake.
 */
import { handleWeb, type WebAssets } from "./web.js";
import { fileStoreFromEnv, handleFiles } from "./files.js";
import { checkKey, requireKey, roomSecret } from "./keys.js";
import { clientIp, rateLimitsFromEnv } from "./limits.js";
import fs from "node:fs";
import http from "node:http";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { URL, fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket, type RawData } from "ws";
import { HISTORY_LIMIT, type Offer, type Role } from "@mesh/protocol";

function envInt(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

const PORT = Number(process.env.PORT) || 8080;
const PING_MS = 25_000;
/** Public-relay guards (README "Relay limits"). All env-tunable, mainly for tests. */
const MAX_ROOMS = envInt("MESH_MAX_ROOMS", 10_000);
const ROOM_IDLE_MS = envInt("MESH_ROOM_IDLE_MS", 2 * 60 * 60 * 1000);
const DUP_PROBE_MS = envInt("MESH_DUP_PROBE_MS", 3000);
const MAX_FRAME_BYTES = envInt("MESH_MAX_FRAME_BYTES", 2 * 1024 * 1024);
const HISTORY_MAX_BYTES = envInt("MESH_HISTORY_MAX_BYTES", 4 * 1024 * 1024);
const MAX_PARAM_LEN = 128;
/** Private close code: this user name is already connected to the room as a daemon. */
const DUPLICATE_CLOSE_CODE = 4409;
/** RFC 6455 "Try Again Later". */
const TRY_AGAIN_CLOSE_CODE = 1013;

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
  historyBytes: number;
  lastActive: number;
}

const rooms = new Map<string, Room>();
const limits = rateLimitsFromEnv();

/** Forget rooms nobody has been connected to for ROOM_IDLE_MS. Returns how many were dropped. */
function sweepRooms(now = Date.now()): number {
  let dropped = 0;
  for (const [name, room] of rooms) {
    if (room.conns.size === 0 && now - room.lastActive >= ROOM_IDLE_MS) {
      rooms.delete(name);
      dropped++;
    }
  }
  return dropped;
}

/** The room, created on first use; undefined when the relay is at MAX_ROOMS even after a sweep. */
function getOrCreateRoom(name: string): Room | undefined {
  let room = rooms.get(name);
  if (!room) {
    if (rooms.size >= MAX_ROOMS) sweepRooms();
    if (rooms.size >= MAX_ROOMS) return undefined;
    room = { conns: new Set(), history: [], historyBytes: 0, lastActive: Date.now() };
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

function refuse(ws: WebSocket, code: number, message: string): void {
  sendError(ws, message);
  ws.close(code, message.slice(0, 120)); // close reasons are capped at 123 bytes
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
  if (room.conns.size === 0 && room.history.length === 0 && rooms.get(name) === room) rooms.delete(name);
}

function pushHistory(room: Room, raw: string): void {
  room.history.push(raw);
  room.historyBytes += Buffer.byteLength(raw);
  while (room.history.length > HISTORY_LIMIT || (room.historyBytes > HISTORY_MAX_BYTES && room.history.length > 1)) {
    room.historyBytes -= Buffer.byteLength(room.history.shift()!);
  }
}

const REPO_URL = process.env.MESH_REPO_URL ?? "https://github.com/dg4329-hash/rho_hackathon";

/**
 * Static files for the one-command join, loaded once at start. `pnpm -F daemon bundle` writes
 * apps/daemon/dist/mesh.mjs; we copy it (and hooks/emit.js) into apps/relay/public/ so the relay
 * can also run from a checkout that only has public/ populated (Docker). Missing files only warn:
 * the relay must still start without the bundle.
 */
/** Tar up the Claude Code plugin + marketplace manifest so the daemon can auto-install it. Returns the tgz path ("" on failure). */
function buildPluginTgz(repoRoot: string, publicDir: string): string {
  const out = path.join(publicDir, "plugin.tgz");
  try {
    if (!fs.existsSync(path.join(repoRoot, "plugin")) || !fs.existsSync(path.join(repoRoot, ".claude-plugin/marketplace.json"))) return "";
    fs.mkdirSync(publicDir, { recursive: true });
    const r = spawnSync("tar", ["-czf", out, "-C", repoRoot, ".claude-plugin/marketplace.json", "plugin"], { stdio: "ignore" });
    return r.status === 0 ? out : "";
  } catch { return ""; }
}

function loadAssets(): WebAssets {
  const here = path.dirname(fileURLToPath(import.meta.url)); // apps/relay/src (or dist)
  const repoRoot = path.resolve(here, "../../..");
  const publicDir = path.resolve(here, "../public");
  const sources: Array<{ name: keyof WebAssets; file: string; from: string; hint: string }> = [
    { name: "meshMjs", file: "mesh.mjs", from: path.join(repoRoot, "apps/daemon/dist/mesh.mjs"), hint: "run `pnpm -F daemon bundle`" },
    { name: "emitJs", file: "emit.js", from: path.join(repoRoot, "hooks/emit.js"), hint: "hooks/emit.js is missing" },
    { name: "pluginTgz", file: "plugin.tgz", from: buildPluginTgz(repoRoot, publicDir), hint: "plugin/ or .claude-plugin/ missing" },
  ];
  const assets: WebAssets = {};
  for (const src of sources) {
    const dest = path.join(publicDir, src.file);
    try {
      if (fs.existsSync(src.from) && (!fs.existsSync(dest) || fs.statSync(src.from).mtimeMs >= fs.statSync(dest).mtimeMs)) {
        fs.mkdirSync(publicDir, { recursive: true });
        fs.copyFileSync(src.from, dest);
      }
    } catch (e) {
      console.warn(`! could not copy ${src.from} → ${dest}: ${(e as Error).message}`);
    }
    try {
      assets[src.name] = fs.readFileSync(dest);
      console.log(`  serving /${src.file} (${(assets[src.name]!.length / 1024).toFixed(0)} KB)`);
    } catch {
      console.warn(`! /${src.file} unavailable: ${dest} not found (${src.hint}); one-command join will not work on this relay`);
    }
  }
  return assets;
}

const webDeps = {
  getRoom: (name: string) => {
    const room = rooms.get(name);
    if (!room) return undefined;
    return {
      members: [...room.conns].filter((c) => c.helloed).map((c) => ({ user: c.user, role: c.role, offers: c.offers })),
      history: room.history,
    };
  },
  createRoom: (name: string): "ok" | "full" => (getOrCreateRoom(name) ? "ok" : "full"),
  roomLimiter: limits.rooms,
  repoUrl: REPO_URL,
  assets: loadAssets(),
};

// Artifacts (docs/FILES-API.md): in memory, LRU-capped, TTL-swept. Not tied to the rooms map — a file outlives its room's history.
const files = fileStoreFromEnv();
files.startSweeper();

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  if (handleFiles(req, res, url, { store: files })) return;
  if (handleWeb(req, res, url, webDeps)) return;
  if ((req.method === "GET" || req.method === "HEAD") && url.pathname === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(req.method === "HEAD" ? undefined : JSON.stringify(counts()));
    return;
  }
  res.writeHead(404, { "content-type": "text/plain" });
  res.end("not found");
});

// maxPayload: an oversized frame closes the socket with 1009 instead of being buffered (ws defaults to 100 MiB).
const wss = new WebSocketServer({ server, maxPayload: MAX_FRAME_BYTES });

wss.on("connection", (ws, req) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const roomName = url.searchParams.get("room");
  const user = url.searchParams.get("user");
  const role = parseRole(url.searchParams.get("role"));

  if (!roomName || !user || !role || roomName.length > MAX_PARAM_LEN || user.length > MAX_PARAM_LEN) {
    refuse(ws, 1008, "missing or invalid query params: require room, user, role=daemon|feed");
    return;
  }

  const take = limits.ws.take(clientIp(req));
  if (!take.ok) {
    refuse(ws, TRY_AGAIN_CLOSE_CODE, `rate limited, retry in ${take.retryAfterSec}s`);
    return;
  }

  // Room key (docs/ROOM-KEYS.md): the link is the only password. 4401 is a private close code the daemon
  // recognises as "get the room link" rather than retrying forever.
  const gate = checkKey(roomName, url.searchParams.get("key"));
  if (!gate.ok) {
    refuse(ws, 4401, gate.error);
    return;
  }

  const room = getOrCreateRoom(roomName);
  if (!room) {
    refuse(ws, TRY_AGAIN_CLOSE_CODE, "relay is full, try again later");
    return;
  }
  room.lastActive = Date.now();

  const conn: Conn = { ws, user, role, offers: [], helloed: false, alive: true };
  room.conns.add(conn);
  console.log(`+ ${user} (${role}) joined room "${roomName}" — ${room.conns.size} conn(s)`);
  let cleaned = false;
  let probing = false;
  const buffered: string[] = []; // frames that arrive while a duplicate-name probe is running

  /**
   * Another daemon with this name that offers something. Only offering daemons count: `mesh ask` connects as
   * role=daemon under the owner's own name with no offers, alongside the owner's running daemon, and must keep working.
   */
  const liveDuplicate = (): Conn | undefined =>
    [...room.conns].find((c) => c !== conn && c.role === "daemon" && c.user === user && c.helloed && c.offers.length > 0 && c.ws.readyState === WebSocket.OPEN);

  /** Same offering daemon name already here: a live teammate (refuse us) or a ghost from a dropped network (replace it)? */
  const probe = (existing: Conn, helloRaw: string) => {
    probing = true;
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      existing.ws.off("pong", onPong);
      existing.ws.off("close", onGone);
      fn();
    };
    const proceed = () => {
      if (cleaned || ws.readyState !== WebSocket.OPEN) return;
      probing = false;
      handleFrame(helloRaw); // re-checks, in case yet another conn took the name meanwhile
      while (!probing && buffered.length > 0 && ws.readyState === WebSocket.OPEN) handleFrame(buffered.shift()!);
    };
    const onPong = () => settle(() => refuse(ws, DUPLICATE_CLOSE_CODE, duplicateMessage(user)));
    const onGone = () => settle(proceed);
    const timer = setTimeout(() => settle(() => {
      console.log(`! ${user} in "${roomName}" did not answer a ping — replacing it with the new connection`);
      existing.ws.terminate(); // its close handler removes it from the room and broadcasts presence
      proceed();
    }), DUP_PROBE_MS);
    existing.ws.on("pong", onPong);
    existing.ws.on("close", onGone);
    ws.once("close", () => settle(() => undefined));
    try {
      existing.ws.ping();
    } catch {
      settle(proceed);
    }
  };

  const handleFrame = (raw: string) => {
    room.lastActive = Date.now();
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
      const offers = Array.isArray(obj.offers) ? (obj.offers as Offer[]) : [];
      if (!conn.helloed && role === "daemon" && offers.length > 0) {
        const existing = liveDuplicate();
        if (existing) {
          probe(existing, raw);
          return;
        }
      }
      conn.offers = offers;
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

    pushHistory(room, raw);
    for (const other of room.conns) {
      if (other === conn) continue;
      if (other.ws.readyState === WebSocket.OPEN) other.ws.send(raw);
    }
  };

  ws.on("pong", () => {
    conn.alive = true;
  });

  ws.on("message", (data: RawData, isBinary: boolean) => {
    if (isBinary) return;
    const raw = rawToString(data);
    if (probing) {
      if (buffered.length < 1000) buffered.push(raw);
      return;
    }
    handleFrame(raw);
  });

  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    room.conns.delete(conn);
    room.lastActive = Date.now();
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

function duplicateMessage(user: string): string {
  return `user "${user.slice(0, 40)}" is already connected to this room as a daemon; pick another name with --as`;
}

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

const sweepInterval = setInterval(() => sweepRooms(), Math.max(100, Math.min(60_000, Math.floor(ROOM_IDLE_MS / 2))));
sweepInterval.unref?.();

server.listen(PORT, () => {
  if (requireKey()) roomSecret(); // warns once when ROOM_SECRET is unset (keys would reset on restart)
  else console.warn("! MESH_REQUIRE_KEY=0: room keys are NOT enforced on this relay");
  console.log(`mesh relay listening on :${PORT} (ws + web UI at / + GET /health + /install.sh)`);
});

function shutdown(signal: string): void {
  console.log(`${signal} — shutting down`);
  clearInterval(pingInterval);
  clearInterval(sweepInterval);
  files.stopSweeper();
  for (const c of wss.clients) c.terminate();
  wss.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000).unref();
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
