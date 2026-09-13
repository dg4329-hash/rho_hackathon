/**
 * In-memory artifact store for the relay (docs/FILES-API.md "Relay").
 *
 *   POST /api/files/:room            raw bytes; headers x-mesh-name, x-mesh-mime (default application/octet-stream), x-mesh-from
 *                                    → 201 { id, name, mime, size, url }     413 above MAX_FILE_BYTES
 *   GET  /api/files/:room/:id        bytes; content-type, content-disposition: inline; filename="…", cache-control: private, max-age=3600
 *   GET  /api/files/:room/:id/meta   → { id, name, mime, size, from, ts }
 *
 * Limits: 25 MB per file, 200 MB per relay (LRU eviction, oldest-read first), 1 h TTL (sweep timer, unref'd).
 * Nothing touches disk. Every route needs the room key (header x-mesh-key or ?key=, docs/ROOM-KEYS.md) → 401;
 * beyond that, access is gated by the room name, like everything else on the relay.
 * Env overrides (mainly for tests): MESH_FILE_MAX_BYTES, MESH_FILE_TOTAL_BYTES, MESH_FILE_TTL_MS.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { publicOrigin } from "./web.js";
import { checkKey, keyFromRequest } from "./keys.js";

export const MAX_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 200 * 1024 * 1024;
export const FILE_TTL_MS = 60 * 60 * 1000;

const ROOM_RE = /^[a-z0-9][a-z0-9-]{1,40}$/;
const ID_RE = /^[a-z0-9]{8,40}$/;

export interface FileMeta {
  id: string;
  room: string;
  name: string;
  mime: string;
  size: number;
  from: string;
  ts: string; // ISO upload time
}

interface Entry extends FileMeta {
  bytes: Buffer;
  expiresAt: number;
}

export interface FileStoreOptions {
  maxFileBytes?: number;
  maxTotalBytes?: number;
  ttlMs?: number;
  /** Clock, injectable for tests. */
  now?: () => number;
}

export class FileTooLargeError extends Error {
  constructor(size: number, limit: number) {
    super(`file is ${size} bytes; limit is ${limit}`);
    this.name = "FileTooLargeError";
  }
}

export interface FileStore {
  readonly maxFileBytes: number;
  readonly maxTotalBytes: number;
  readonly ttlMs: number;
  /** Store bytes; evicts least-recently-used entries until the total fits. Throws FileTooLargeError above maxFileBytes. */
  put(room: string, file: { name: string; mime: string; from: string; bytes: Buffer }): FileMeta;
  /** Bytes + meta, or undefined if unknown / wrong room / expired. Marks the entry most-recently-used. */
  get(room: string, id: string): (FileMeta & { bytes: Buffer }) | undefined;
  /** Meta only (also touches LRU order — a meta lookup is usually followed by a download). */
  meta(room: string, id: string): FileMeta | undefined;
  /** Drop expired entries. Returns how many were removed. */
  sweep(): number;
  stats(): { count: number; totalBytes: number };
  /** Periodic sweep; the timer is unref'd so it never keeps the process alive. */
  startSweeper(intervalMs?: number): void;
  stopSweeper(): void;
  clear(): void;
}

export function createFileStore(opts: FileStoreOptions = {}): FileStore {
  const maxFileBytes = opts.maxFileBytes ?? MAX_FILE_BYTES;
  const maxTotalBytes = opts.maxTotalBytes ?? MAX_TOTAL_BYTES;
  const ttlMs = opts.ttlMs ?? FILE_TTL_MS;
  const now = opts.now ?? Date.now;
  // Map preserves insertion order: first entry = least recently used. Reads delete + re-insert to bump.
  const entries = new Map<string, Entry>();
  let totalBytes = 0;
  let timer: NodeJS.Timeout | undefined;

  function drop(id: string): void {
    const e = entries.get(id);
    if (!e) return;
    entries.delete(id);
    totalBytes -= e.size;
  }

  function live(room: string, id: string): Entry | undefined {
    const e = entries.get(id);
    if (!e) return undefined;
    if (e.expiresAt <= now()) { drop(id); return undefined; }
    if (e.room !== room) return undefined; // room-name gating: the id alone is not enough
    entries.delete(id); entries.set(id, e); // bump to most-recently-used
    return e;
  }

  const strip = (e: Entry): FileMeta => ({ id: e.id, room: e.room, name: e.name, mime: e.mime, size: e.size, from: e.from, ts: e.ts });

  const store: FileStore = {
    maxFileBytes, maxTotalBytes, ttlMs,
    put(room, file) {
      const size = file.bytes.length;
      if (size > maxFileBytes) throw new FileTooLargeError(size, maxFileBytes);
      store.sweep();
      while (totalBytes + size > maxTotalBytes && entries.size > 0) {
        const oldest = entries.keys().next().value as string;
        drop(oldest);
      }
      let id = randomBytes(8).toString("hex");
      while (entries.has(id)) id = randomBytes(8).toString("hex");
      const t = now();
      const e: Entry = { id, room, name: file.name, mime: file.mime, size, from: file.from, ts: new Date(t).toISOString(), bytes: file.bytes, expiresAt: t + ttlMs };
      entries.set(id, e);
      totalBytes += size;
      return strip(e);
    },
    get(room, id) {
      const e = live(room, id);
      return e ? { ...strip(e), bytes: e.bytes } : undefined;
    },
    meta(room, id) {
      const e = live(room, id);
      return e ? strip(e) : undefined;
    },
    sweep() {
      const t = now();
      let n = 0;
      for (const [id, e] of entries) {
        if (e.expiresAt <= t) { drop(id); n++; }
      }
      return n;
    },
    stats() { return { count: entries.size, totalBytes }; },
    startSweeper(intervalMs = Math.max(1000, Math.min(ttlMs, 60_000))) {
      store.stopSweeper();
      timer = setInterval(() => { store.sweep(); }, intervalMs);
      timer.unref?.();
    },
    stopSweeper() { if (timer) { clearInterval(timer); timer = undefined; } },
    clear() { entries.clear(); totalBytes = 0; },
  };
  return store;
}

/** Store built from env overrides (index.ts). */
export function fileStoreFromEnv(env: NodeJS.ProcessEnv = process.env): FileStore {
  const num = (k: string, d: number) => { const n = Number(env[k]); return Number.isFinite(n) && n > 0 ? n : d; };
  return createFileStore({
    maxFileBytes: num("MESH_FILE_MAX_BYTES", MAX_FILE_BYTES),
    maxTotalBytes: num("MESH_FILE_TOTAL_BYTES", MAX_TOTAL_BYTES),
    ttlMs: num("MESH_FILE_TTL_MS", FILE_TTL_MS),
  });
}

// ---------- HTTP ----------

const CORS = { "access-control-allow-origin": "*" } as const; // same policy as the other /api routes (web.ts json())

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...CORS });
  res.end(JSON.stringify(body));
}

function header(req: IncomingMessage, name: string): string {
  const v = req.headers[name];
  return (Array.isArray(v) ? v[0] : v) ?? "";
}

/** A safe display/file name: basename only, no control chars, bounded length; percent-decoded when it looks encoded. */
export function cleanName(raw: string): string {
  let s = raw.trim();
  // Node hands header bytes over as latin1; a daemon that sent raw UTF-8 shows up as "hÃ©llo". Undo that when the
  // bytes are valid UTF-8 (the round-trip is lossless for genuine latin1 that happens to be UTF-8-invalid).
  if (/[-ÿ]/.test(s) && !/[Ā-￿]/.test(s)) {
    const utf8 = Buffer.from(s, "latin1").toString("utf8");
    if (!utf8.includes("�")) s = utf8;
  }
  if (/%[0-9A-Fa-f]{2}/.test(s)) { try { s = decodeURIComponent(s); } catch { /* keep raw */ } }
  s = s.split(/[\\/]/).pop() ?? "";
  // eslint-disable-next-line no-control-regex
  s = s.replace(/[\x00-\x1f\x7f"]/g, "").trim();
  if (!s || s === "." || s === "..") s = "file";
  return s.length > 200 ? s.slice(-200) : s;
}

function cleanMime(raw: string): string {
  const s = raw.trim().toLowerCase();
  return /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+(;\s*[a-z0-9-]+=[a-z0-9._-]+)*$/.test(s) && s.length <= 120 ? s : "application/octet-stream";
}

function cleanFrom(raw: string): string {
  return raw.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 32);
}

/** RFC 6266: ASCII fallback in filename=, full UTF-8 name in filename*= when needed. */
export function contentDisposition(name: string): string {
  // eslint-disable-next-line no-control-regex
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  const needsExt = ascii !== name;
  return `inline; filename="${ascii}"` + (needsExt ? `; filename*=UTF-8''${encodeURIComponent(name)}` : "");
}

function readBody(req: IncomingMessage, limit: number): Promise<Buffer | "too-large"> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    req.on("data", (chunk: Buffer) => {
      if (done) return;
      size += chunk.length;
      if (size > limit) { done = true; resolve("too-large"); return; }
      chunks.push(chunk);
    });
    req.on("end", () => { if (!done) { done = true; resolve(Buffer.concat(chunks)); } });
    req.on("error", (e) => { if (!done) { done = true; reject(e); } });
  });
}

export interface FilesDeps {
  store: FileStore;
  /** Absolute origin for artifact URLs; defaults to publicOrigin(req).http (web.ts). */
  origin?: (req: IncomingMessage) => string;
}

/**
 * Returns true if the request was handled (any method on /api/files/…). Mount from the http handler in index.ts.
 * POST replies are sent asynchronously once the body is read; the boolean is still returned synchronously.
 */
export function handleFiles(req: IncomingMessage, res: ServerResponse, url: URL, deps: FilesDeps): boolean {
  const { pathname } = url;
  if (!pathname.startsWith("/api/files/")) return false;
  const method = req.method ?? "GET";
  const { store } = deps;

  if (method === "OPTIONS") {
    // Preflight carries no custom headers of its own — never gated, or the browser could never send x-mesh-key.
    res.writeHead(204, { ...CORS, "access-control-allow-methods": "GET, HEAD, POST, OPTIONS", "access-control-allow-headers": "content-type, x-mesh-name, x-mesh-mime, x-mesh-from, x-mesh-key", "access-control-max-age": "600" });
    res.end();
    return true;
  }

  // Room key (docs/ROOM-KEYS.md): every /api/files/:room… route needs it (header x-mesh-key or ?key=).
  const seg = pathname.match(/^\/api\/files\/([^/]+)/);
  if (seg) {
    const gate = checkKey(decodeURIComponent(seg[1]!), keyFromRequest(req, url));
    if (!gate.ok) { json(res, 401, { error: gate.error }); req.resume(); return true; }
  }

  // POST /api/files/:room
  let m = pathname.match(/^\/api\/files\/([^/]+)$/);
  if (m) {
    const room = decodeURIComponent(m[1]!);
    if (method !== "POST") { json(res, 405, { error: "method not allowed" }); return true; }
    if (!ROOM_RE.test(room)) { json(res, 400, { error: "bad room name" }); return true; }
    const declared = Number(header(req, "content-length"));
    if (Number.isFinite(declared) && declared > store.maxFileBytes) {
      json(res, 413, { error: `file too large (limit ${store.maxFileBytes} bytes)` });
      req.resume();
      return true;
    }
    readBody(req, store.maxFileBytes).then((body) => {
      if (body === "too-large") {
        json(res, 413, { error: `file too large (limit ${store.maxFileBytes} bytes)` });
        req.destroy();
        return;
      }
      if (body.length === 0) { json(res, 400, { error: "empty body" }); return; }
      const name = cleanName(header(req, "x-mesh-name"));
      const mime = cleanMime(header(req, "x-mesh-mime"));
      const from = cleanFrom(header(req, "x-mesh-from"));
      let meta: FileMeta;
      try {
        meta = store.put(room, { name, mime, from, bytes: body });
      } catch (e) {
        if (e instanceof FileTooLargeError) { json(res, 413, { error: e.message }); return; }
        throw e;
      }
      const origin = deps.origin ? deps.origin(req) : publicOrigin(req).http;
      json(res, 201, { id: meta.id, name: meta.name, mime: meta.mime, size: meta.size, url: `${origin}/api/files/${room}/${meta.id}` });
    }).catch((e: Error) => {
      if (!res.headersSent) json(res, 500, { error: e.message });
      else res.end();
    });
    return true;
  }

  // GET /api/files/:room/:id/meta
  m = pathname.match(/^\/api\/files\/([^/]+)\/([^/]+)\/meta$/);
  if (m) {
    if (method !== "GET" && method !== "HEAD") { json(res, 405, { error: "method not allowed" }); return true; }
    const room = decodeURIComponent(m[1]!), id = m[2]!;
    if (!ROOM_RE.test(room) || !ID_RE.test(id)) { json(res, 404, { error: "not found" }); return true; }
    const meta = store.meta(room, id);
    if (!meta) { json(res, 404, { error: "not found" }); return true; }
    json(res, 200, { id: meta.id, name: meta.name, mime: meta.mime, size: meta.size, from: meta.from, ts: meta.ts });
    return true;
  }

  // GET /api/files/:room/:id
  m = pathname.match(/^\/api\/files\/([^/]+)\/([^/]+)$/);
  if (m) {
    if (method !== "GET" && method !== "HEAD") { json(res, 405, { error: "method not allowed" }); return true; }
    const room = decodeURIComponent(m[1]!), id = m[2]!;
    if (!ROOM_RE.test(room) || !ID_RE.test(id)) { json(res, 404, { error: "not found" }); return true; }
    const f = store.get(room, id);
    if (!f) { json(res, 404, { error: "not found" }); return true; }
    res.writeHead(200, {
      "content-type": f.mime,
      "content-length": f.size,
      "content-disposition": contentDisposition(f.name),
      "cache-control": "private, max-age=3600",
      "x-content-type-options": "nosniff",
      ...CORS,
    });
    res.end(method === "HEAD" ? undefined : f.bytes);
    return true;
  }

  json(res, 404, { error: "not found" });
  return true;
}
