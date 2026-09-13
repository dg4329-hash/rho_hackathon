/**
 * Artifacts (docs/FILES-API.md): files never travel in WebSocket frames. The owner's daemon uploads them
 * to the relay (`POST /api/files/<room>`), frames carry small `Artifact` descriptors, the requester's daemon
 * downloads on demand (`GET /api/files/<room>/<id>`).
 */
import fs from "node:fs";
import path from "node:path";
import { Artifact } from "@mesh/protocol";

export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 60_000;
/** ngrok's browser interstitial is HTML, not our bytes; this header opts out (harmless elsewhere). */
const NGROK_HEADER = { "ngrok-skip-browser-warning": "1" } as const;

/** Room key header for the relay's file routes (docs/ROOM-KEYS.md). Absent when the room has no key. */
export function keyHeader(key?: string): Record<string, string> {
  return key ? { "x-mesh-key": key } : {};
}

const MIME_BY_EXT: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml",
  bmp: "image/bmp", ico: "image/x-icon", tif: "image/tiff", tiff: "image/tiff", avif: "image/avif",
  pdf: "application/pdf", json: "application/json", zip: "application/zip", gz: "application/gzip", tar: "application/x-tar",
  txt: "text/plain", md: "text/markdown", csv: "text/csv", html: "text/html", htm: "text/html", css: "text/css", xml: "text/xml",
  js: "text/javascript", mjs: "text/javascript", ts: "text/plain", tsx: "text/plain", jsx: "text/javascript", py: "text/x-python",
  sh: "text/x-shellscript", yaml: "text/yaml", yml: "text/yaml", log: "text/plain", sql: "text/plain",
  mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", m4a: "audio/mp4",
  mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime",
  woff: "font/woff", woff2: "font/woff2", ttf: "font/ttf",
};

/** MIME type from a file name's extension; application/octet-stream when unknown. */
export function mimeFor(name: string): string {
  const ext = path.extname(name).slice(1).toLowerCase();
  return (ext && MIME_BY_EXT[ext]) || "application/octet-stream";
}

/** File extension for a MIME type (`png` for image/png); falls back to the subtype or `bin`. */
export function extFor(mime: string): string {
  const clean = mime.split(";")[0]!.trim().toLowerCase();
  for (const [ext, m] of Object.entries(MIME_BY_EXT)) if (m === clean) return ext;
  const sub = clean.split("/")[1];
  return sub && /^[a-z0-9]+$/.test(sub) ? sub : "bin";
}

/** `wss://relay.example` → `https://relay.example` (and ws → http). Trailing slashes dropped. */
export function httpOrigin(relayWsUrl: string): string {
  return relayWsUrl.replace(/^wss:/i, "https:").replace(/^ws:/i, "http:").replace(/\/+$/, "");
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Upload bytes as one artifact. Throws with a readable message on any failure (caller decides how to report). */
export async function uploadBytes(
  relayWsUrl: string, room: string, from: string, name: string, bytes: Uint8Array, mime?: string, key?: string,
): Promise<Artifact> {
  if (bytes.byteLength > MAX_UPLOAD_BYTES) {
    throw new Error(`${name} is ${formatSize(bytes.byteLength)}; the relay accepts at most ${formatSize(MAX_UPLOAD_BYTES)} per file`);
  }
  const origin = httpOrigin(relayWsUrl);
  const url = `${origin}/api/files/${encodeURIComponent(room)}`;
  const safeName = path.basename(name).replace(/[\r\n"]/g, "_") || "file";
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": mime ?? mimeFor(safeName),
        "x-mesh-name": safeName,
        "x-mesh-mime": mime ?? mimeFor(safeName),
        "x-mesh-from": from,
        ...keyHeader(key),
        ...NGROK_HEADER,
      },
      body: new Blob([bytes as BlobPart]),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (e) {
    throw new Error(`upload of ${safeName} to ${origin} failed: ${(e as Error).message}`);
  }
  if (res.status !== 201 && res.status !== 200) {
    const body = (await res.text().catch(() => "")).slice(0, 200);
    throw new Error(`upload of ${safeName} rejected by relay: HTTP ${res.status}${body ? ` ${body}` : ""}`);
  }
  const raw = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  const candidate = {
    id: String(raw.id ?? ""),
    name: String(raw.name ?? safeName),
    mime: String(raw.mime ?? mime ?? mimeFor(safeName)),
    size: typeof raw.size === "number" ? raw.size : bytes.byteLength,
    // The relay returns an absolute URL; tolerate a relative one by resolving it against the relay origin.
    url: typeof raw.url === "string" && raw.url ? new URL(raw.url, origin + "/").toString() : `${url}/${encodeURIComponent(String(raw.id ?? ""))}`,
    ...(typeof raw.sha256 === "string" ? { sha256: raw.sha256 } : {}),
  };
  const parsed = Artifact.safeParse(candidate);
  if (!parsed.success || !candidate.id) throw new Error(`relay returned a malformed artifact for ${safeName}: ${JSON.stringify(raw).slice(0, 200)}`);
  return parsed.data;
}

/** Upload a file from disk. Size-checked before reading so a 2 GB file never lands in memory. */
export async function uploadFile(relayWsUrl: string, room: string, from: string, filePath: string, mime?: string, key?: string): Promise<Artifact> {
  let st: fs.Stats;
  try {
    st = fs.statSync(filePath);
  } catch {
    throw new Error(`${filePath}: no such file`);
  }
  if (!st.isFile()) throw new Error(`${filePath}: not a regular file`);
  if (st.size > MAX_UPLOAD_BYTES) {
    throw new Error(`${path.basename(filePath)} is ${formatSize(st.size)}; the relay accepts at most ${formatSize(MAX_UPLOAD_BYTES)} per file`);
  }
  const bytes = fs.readFileSync(filePath);
  return uploadBytes(relayWsUrl, room, from, path.basename(filePath), bytes, mime ?? mimeFor(filePath), key);
}

/** Download an artifact to destPath (parent dirs created). Returns the byte count and the served content-type. */
export async function downloadArtifact(url: string, destPath: string, key?: string): Promise<{ size: number; mime: string }> {
  let res: Response;
  try {
    res = await fetch(url, { headers: { ...keyHeader(key), ...NGROK_HEADER }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch (e) {
    throw new Error(`download of ${url} failed: ${(e as Error).message}`);
  }
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) throw new Error(`download of ${url} refused (HTTP ${res.status}): this room needs its key — rejoin with the room link (https://<relay>/r/<room>#k=<key>)`);
    throw new Error(res.status === 404 ? `artifact is gone (404): the relay keeps files for about an hour` : `download of ${url} failed: HTTP ${res.status}`);
  }
  const bytes = Buffer.from(await res.arrayBuffer());
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.writeFileSync(destPath, bytes);
  const mime = (res.headers.get("content-type") ?? "").split(";")[0]!.trim() || "application/octet-stream";
  return { size: bytes.byteLength, mime };
}

/** `GET /api/files/<room>/<id>/meta` → who uploaded it (undefined when the relay doesn't know or doesn't serve meta). */
export async function artifactMeta(url: string, key?: string): Promise<{ from?: string; name?: string; mime?: string; size?: number } | undefined> {
  try {
    const res = await fetch(url.replace(/\/+$/, "") + "/meta", { headers: { ...keyHeader(key), ...NGROK_HEADER }, signal: AbortSignal.timeout(5_000) });
    if (!res.ok) return undefined;
    const j = (await res.json()) as Record<string, unknown>;
    return {
      from: typeof j.from === "string" ? j.from : undefined,
      name: typeof j.name === "string" ? j.name : undefined,
      mime: typeof j.mime === "string" ? j.mime : undefined,
      size: typeof j.size === "number" ? j.size : undefined,
    };
  } catch {
    return undefined;
  }
}

/** Lines like `MESH_FILE: out/report.pdf` or `PNG: shot.png` in command output → file paths (resolved against cwd, deduped). */
export function scanOutputForFiles(output: string, cwd: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const re = /^(MESH_FILE|PNG):[ \t]*(.+?)[ \t\r]*$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(output)) !== null) {
    const tag = m[1]!;
    const raw = m[2]!.replace(/^["']|["']$/g, "");
    if (!raw) continue;
    if (tag === "PNG" && !/\.png$/i.test(raw)) continue;
    const resolved = path.resolve(cwd, raw);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    out.push(resolved);
  }
  return out;
}
