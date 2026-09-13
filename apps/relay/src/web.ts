/**
 * Web front door for the relay: a landing page that starts a session, a room page that shows
 * who's connected + a live feed, and two JSON routes the pages poll. Same port as the WebSocket.
 *
 *   GET  /                 landing: "Start a session" + "Join a room"
 *   POST /api/rooms        → 201 { room, key, link, ownerToken, ownerLink }  create a room (link = <origin>/r/<room>#k=<key>,
 *                            ownerLink = link + "&o=<ownerToken>", creator only; the only place the owner token is ever returned)
 *   GET  /api/rooms/:room  → { room, members, events }   live state (polled every 2 s); needs ?key= / x-mesh-key; 410 once ended
 *   POST /api/rooms/:room/end  key (?key= / x-mesh-key) + owner token (x-mesh-owner or body { owner }), body { by?, reason? }
 *                            → 200 { ok, room, ended: true, closed[, alreadyEnded] } | 400 | 401 | 403
 *   GET  /r/:room          room page (reads #k=<key> from the fragment; no key → "paste the room link" box)
 *   GET  /site             marketing page (website/index.html, loaded at relay start)
 *
 * One-command join (no clone / pnpm / npm account), all served from the same port:
 *   GET  /mesh.mjs         single-file daemon bundle (apps/daemon/dist/mesh.mjs, built by `pnpm -F daemon bundle`)
 *   GET  /emit.js          hooks/emit.js (the daemon installs it as ~/.mesh/emit.js for Claude Code hooks)
 *   GET  /install.sh       bash installer with THIS relay's public origin baked in (from Host / X-Forwarded-*):
 *                            curl -fsSL https://<host>/install.sh | bash -s -- <room> [--as handle]
 *   GET  /install.ps1      PowerShell equivalent:
 *                            & ([scriptblock]::Create((irm -Headers @{'ngrok-skip-browser-warning'='1'} https://<host>/install.ps1))) <room> [--as handle]
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { handleOverlay } from "./overlay.js";
import { KEY_RE, OWNER_RE, checkKey, keyFromRequest, ownerLink, ownerToken, roomKey, roomLink, verifyOwner } from "./keys.js";
import { clientIp, type RateLimiter } from "./limits.js";

export const ENDED_MESSAGE = "this session was ended by its owner";
export const NOT_OWNER_MESSAGE = "only the person who started this session can end it";

export interface WebRoomView {
  members: Array<{ user: string; role: string; offers: Array<{ name: string; kind?: string; permission?: string }> }>;
  history: string[]; // raw JSON frames, oldest first
}

/** Static files loaded at relay start (index.ts); undefined = missing on disk, routes answer 503 with a hint. */
export interface WebAssets {
  meshMjs?: Buffer;
  emitJs?: Buffer;
  pluginTgz?: Buffer;
  /** website/index.html (Abhi's marketing page), served at /site. */
  websiteHtml?: Buffer;
}

export interface WebDeps {
  getRoom(name: string): WebRoomView | undefined;
  /** "full" when the relay is at its room cap (MESH_MAX_ROOMS) even after sweeping idle rooms. */
  createRoom(name: string): "ok" | "full";
  /** End a room for everyone (index.ts): room_ended + close 4410 to every socket, forget it, tombstone the name. */
  endRoom(name: string, opts: { by?: string; reason?: string }): { closed: number; alreadyEnded: boolean };
  /** True while the name is tombstoned (ended, MESH_ENDED_TTL_MS). */
  isEnded(name: string): boolean;
  /** Per-IP limiter for POST /api/rooms (limits.ts); absent = unlimited. */
  roomLimiter?: RateLimiter;
  repoUrl: string;
  assets: WebAssets;
}

const ROOM_RE = /^[a-z0-9][a-z0-9-]{1,40}$/;
const WORDS = ["otter", "maple", "comet", "ember", "delta", "pixel", "quartz", "sonic", "tango", "vapor", "willow", "zephyr"];

function newRoomName(): string {
  const w = WORDS[randomBytes(1)[0]! % WORDS.length];
  // 32 random bits x 12 words: a key is derived from the name alone, so a reissued name would hand out a live room's key.
  return `${w}-${randomBytes(4).toString("hex")}`;
}

/**
 * A fresh room name, or "" after `tries` collisions. `isTaken` must cover live rooms AND ended (tombstoned) ones:
 * a key is derived from the name alone, so reissuing either would hand out a working key / owner token for it.
 */
export function allocateRoomName(isTaken: (name: string) => boolean, gen: () => string = newRoomName, tries = 50): string {
  for (let i = 0; i < tries; i++) {
    const candidate = gen();
    if (!isTaken(candidate)) return candidate;
  }
  return "";
}

/** `by` for room_ended: a mesh handle or nothing. */
export function cleanBy(raw: unknown): string | undefined {
  const s = typeof raw === "string" ? raw.trim() : "";
  return /^[a-z0-9_-]{1,32}$/.test(s) ? s : undefined;
}

/** `reason` for room_ended: one line, ≤ 140 chars, or nothing. */
export function cleanReason(raw: unknown): string | undefined {
  const s = typeof raw === "string" ? raw.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, 140).trim() : "";
  return s || undefined;
}

const END_BODY_MAX = 4096;

function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", "access-control-allow-origin": "*", ...headers });
  res.end(JSON.stringify(body));
}

function html(res: ServerResponse, body: string): void {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  res.end(body);
}

function text(res: ServerResponse, status: number, body: string | Buffer, contentType = "text/plain; charset=utf-8"): void {
  res.writeHead(status, { "content-type": contentType, "cache-control": "no-store", "access-control-allow-origin": "*" });
  res.end(body);
}

function asset(res: ServerResponse, body: Buffer | undefined, hint: string, contentType: string): void {
  if (!body) { text(res, 503, `${hint}\n`); return; }
  text(res, 200, body, contentType);
}

const LOCAL_HOST_RE = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|0\.0\.0\.0|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)(:\d+)?$/i;

/**
 * The relay's public origin as the *client* sees it. Behind ngrok / Railway the socket is plain http but
 * X-Forwarded-Proto says https; with no forwarding header, a bare public hostname is assumed to be TLS-terminated
 * and localhost / private IPs / explicit ports are assumed to be plain http.
 */
export function publicOrigin(req: IncomingMessage): { http: string; ws: string; host: string } {
  const h = (name: string) => { const v = req.headers[name]; return (Array.isArray(v) ? v[0] : v)?.split(",")[0]?.trim() || undefined; };
  const host = h("x-forwarded-host") ?? h("host") ?? "localhost";
  const fwd = h("x-forwarded-proto");
  const secure = fwd ? fwd === "https" : !LOCAL_HOST_RE.test(host) && !/:\d+$/.test(host);
  return { http: `${secure ? "https" : "http"}://${host}`, ws: `${secure ? "wss" : "ws"}://${host}`, host };
}

/** Returns true if the request was handled. */
export function handleWeb(req: IncomingMessage, res: ServerResponse, url: URL, deps: WebDeps): boolean {
  const { pathname } = url;
  const method = req.method ?? "GET";

  if (method === "GET" && pathname === "/") { html(res, page({ repoUrl: deps.repoUrl })); return true; }
  if (method === "GET" && (pathname === "/site" || pathname === "/site/" || pathname === "/website")) {
    asset(res, deps.assets.websiteHtml, "the website is not on this relay (expected website/index.html)", "text/html; charset=utf-8");
    return true;
  }

  if (method === "GET" && pathname === "/mesh.mjs") {
    asset(res, deps.assets.meshMjs, "mesh.mjs is not built on this relay: run `pnpm -F daemon bundle` and restart the relay", "text/javascript; charset=utf-8");
    return true;
  }
  if (method === "GET" && pathname === "/plugin.tgz") {
    asset(res, deps.assets.pluginTgz, "plugin.tgz is missing on this relay", "application/gzip");
    return true;
  }
  if (method === "GET" && pathname === "/emit.js") {
    asset(res, deps.assets.emitJs, "emit.js is missing on this relay (expected hooks/emit.js or apps/relay/public/emit.js)", "text/javascript; charset=utf-8");
    return true;
  }
  if (method === "GET" && pathname === "/install.sh") { text(res, 200, installSh(publicOrigin(req)), "text/x-shellscript; charset=utf-8"); return true; }
  if (method === "GET" && pathname === "/install.ps1") { text(res, 200, installPs1(publicOrigin(req)), "text/plain; charset=utf-8"); return true; }
  if (handleOverlay(req, res, url)) return true; // GET /overlay?room=&port=  +  GET /overlay.js  (overlay.ts)

  if (method === "POST" && pathname === "/api/rooms") {
    const take = deps.roomLimiter?.take(clientIp(req));
    if (take && !take.ok) {
      json(res, 429, { error: `rate limited, retry in ${take.retryAfterSec}s` }, { "retry-after": String(take.retryAfterSec) });
      return true;
    }
    // Never fall through to a name that exists: its key would let this caller into someone else's room.
    // Ended names count as taken too: their tombstone must not be handed to a new creator.
    const name = allocateRoomName((candidate) => !!deps.getRoom(candidate) || deps.isEnded(candidate));
    if (!name) { json(res, 503, { error: "could not allocate a room name, retry" }, { "retry-after": "1" }); return true; }
    if (deps.createRoom(name) === "full") { json(res, 503, { error: "relay is full, try again later" }, { "retry-after": "60" }); return true; }
    const key = roomKey(name);
    const owner = ownerToken(name);
    const origin = publicOrigin(req).http;
    json(res, 201, { room: name, key, link: roomLink(origin, name, key), ownerToken: owner, ownerLink: ownerLink(origin, name, key, owner) });
    return true;
  }

  let m = pathname.match(/^\/api\/rooms\/([^/]+)\/end$/);
  if (m && method === "OPTIONS") {
    res.writeHead(204, { "access-control-allow-origin": "*", "access-control-allow-methods": "POST, OPTIONS", "access-control-allow-headers": "content-type, x-mesh-key, x-mesh-owner", "access-control-max-age": "600" });
    res.end();
    return true;
  }
  if (m && method === "POST") {
    let name = "";
    try { name = decodeURIComponent(m[1]!); } catch { name = ""; }
    if (!ROOM_RE.test(name)) { json(res, 400, { error: "bad room name" }); req.resume(); return true; }
    const gate = checkKey(name, keyFromRequest(req, url));
    if (!gate.ok) { json(res, 401, { error: gate.error }); req.resume(); return true; }
    const chunks: Buffer[] = [];
    let size = 0;
    let tooBig = false;
    req.on("data", (c: Buffer) => { size += c.length; if (size > END_BODY_MAX) tooBig = true; else chunks.push(c); });
    req.on("error", () => { if (!res.headersSent) json(res, 400, { error: "bad request body" }); });
    req.on("end", () => {
      if (tooBig) { json(res, 413, { error: "body too large" }); return; }
      let body: { owner?: unknown; by?: unknown; reason?: unknown } = {};
      const raw = Buffer.concat(chunks).toString("utf8").trim();
      if (raw) {
        try {
          const parsed = JSON.parse(raw) as unknown;
          if (parsed && typeof parsed === "object") body = parsed as typeof body;
        } catch { /* ignore: the owner token may still come in the header */ }
      }
      const h = req.headers["x-mesh-owner"];
      const headerOwner = ((Array.isArray(h) ? h[0] : h) ?? "").trim();
      const owner = headerOwner || (typeof body.owner === "string" ? body.owner.trim() : "");
      // Always required, even with MESH_REQUIRE_KEY=0: ending kicks everyone out.
      if (!verifyOwner(name, owner)) { json(res, 403, { error: NOT_OWNER_MESSAGE }); return; }
      const r = deps.endRoom(name, { by: cleanBy(body.by), reason: cleanReason(body.reason) });
      json(res, 200, r.alreadyEnded ? { ok: true, room: name, ended: true, closed: 0, alreadyEnded: true } : { ok: true, room: name, ended: true, closed: r.closed });
    });
    return true;
  }

  m = pathname.match(/^\/api\/rooms\/([^/]+)$/);
  if (method === "GET" && m) {
    const name = decodeURIComponent(m[1]!);
    if (!ROOM_RE.test(name)) { json(res, 400, { error: "bad room name" }); return true; }
    const gate = checkKey(name, keyFromRequest(req, url));
    if (!gate.ok) { json(res, 401, { error: gate.error }); return true; }
    if (deps.isEnded(name)) { json(res, 410, { error: ENDED_MESSAGE, ended: true }); return true; }
    const room = deps.getRoom(name);
    if (!room) { json(res, 200, { room: name, members: [], events: [], exists: false }); return true; }
    const since = Number(url.searchParams.get("since") ?? 0);
    const events = room.history
      .map((raw, i) => ({ i, raw }))
      .filter((e) => e.i >= since)
      .slice(-100)
      .map((e) => { try { return { i: e.i, ...(JSON.parse(e.raw) as object) }; } catch { return null; } })
      .filter(Boolean);
    json(res, 200, {
      room: name, exists: true,
      members: room.members.filter((mm) => mm.role !== "feed").map((mm) => ({ user: mm.user, offers: mm.offers })),
      watchers: room.members.filter((mm) => mm.role === "feed").length,
      events, next: room.history.length,
    });
    return true;
  }

  if (method === "GET" && (pathname === "/join.cmd" || pathname === "/join.command")) {
    const room = url.searchParams.get("room") ?? "";
    const as = (url.searchParams.get("as") ?? "").toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 32);
    if (!ROOM_RE.test(room)) { res.writeHead(400).end("bad room name"); return true; }
    const origin = publicOrigin(req).http;
    const key = (url.searchParams.get("key") ?? "").trim().toLowerCase();
    // The key is baked into the downloaded command so a double-click join works without the room page.
    const keyArg = KEY_RE.test(key) ? ` --key ${key}` : "";
    // The creator's download also carries the owner token (so their daemon can end the session); anyone else's never does.
    const owner = (url.searchParams.get("owner") ?? "").trim().toLowerCase();
    const ownerArg = OWNER_RE.test(owner) ? ` --owner ${owner}` : "";
    const asArg = keyArg + ownerArg + (as ? ` --as ${as}` : "");
    if (pathname === "/join.cmd") {
      const body = `@echo off\r\ntitle mesh: joining ${room}\r\necho Joining mesh room ${room}...\r\npowershell -NoProfile -ExecutionPolicy Bypass -Command "& ([scriptblock]::Create((irm -Headers @{'ngrok-skip-browser-warning'='1'} ${origin}/install.ps1))) ${room}${asArg}"\r\necho.\r\necho Done. Restart your coding agent session once. You can close this window.\r\npause\r\n`;
      res.writeHead(200, { "content-type": "application/octet-stream", "content-disposition": `attachment; filename="mesh-join-${room}.cmd"`, "cache-control": "no-store" });
      res.end(body);
    } else {
      const body = `#!/bin/bash\n# mesh: joins room ${room}. Double-click to run (right-click → Open the first time on macOS).\ncurl -fsSL ${origin}/install.sh | bash -s -- ${room}${asArg}\necho\nread -r -p "Done. Restart your coding agent session once. Press enter to close."\n`;
      res.writeHead(200, { "content-type": "application/octet-stream", "content-disposition": `attachment; filename="mesh-join-${room}.command"`, "cache-control": "no-store" });
      res.end(body);
    }
    return true;
  }

  m = pathname.match(/^\/r\/([^/]+)$/);
  if (method === "GET" && m) {
    const name = decodeURIComponent(m[1]!);
    if (!ROOM_RE.test(name)) { res.writeHead(400).end("bad room name"); return true; }
    html(res, page({ repoUrl: deps.repoUrl, room: name }));
    return true;
  }
  return false;
}

// ---------- installers ----------

/** bash: `curl -fsSL <origin>/install.sh | bash -s -- <room> [--as handle] [--port n]` */
export function installSh(o: { http: string; ws: string; host: string }): string {
  return `#!/usr/bin/env bash
# mesh one-command join. Downloads the daemon bundle into ~/.mesh and joins a room.
#
#   curl -fsSL ${o.http}/install.sh | bash -s -- <room> [--as handle] [--port 7337]
#
# Needs: node >= 20 (https://nodejs.org), curl. No clone, no pnpm, no npm account.
# Re-running refreshes ~/.mesh/mesh.mjs and ~/.mesh/emit.js from this relay.
set -euo pipefail

ORIGIN="${o.http}"
RELAY="${o.ws}"
MESH_HOME="\${MESH_HOME:-$HOME/.mesh}"

if [ $# -lt 1 ] || [ -z "$1" ] || [ "\${1#-}" != "$1" ]; then
  echo "usage: curl -fsSL $ORIGIN/install.sh | bash -s -- <room> [--as handle] [--port 7337]" >&2
  exit 64
fi
ROOM="$1"; shift

if ! command -v node >/dev/null 2>&1; then
  echo "mesh: node is not installed. Install Node.js 20 or newer from https://nodejs.org and re-run." >&2
  exit 1
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "mesh: node $(node -v) is too old; need 20 or newer (https://nodejs.org)." >&2
  exit 1
fi
if ! command -v curl >/dev/null 2>&1; then
  echo "mesh: curl is required." >&2
  exit 1
fi

mkdir -p "$MESH_HOME"
echo "mesh: downloading $ORIGIN/mesh.mjs -> $MESH_HOME/mesh.mjs"
curl -fsSL -H "ngrok-skip-browser-warning: 1" "$ORIGIN/mesh.mjs" -o "$MESH_HOME/mesh.mjs.tmp"
mv -f "$MESH_HOME/mesh.mjs.tmp" "$MESH_HOME/mesh.mjs"
curl -fsSL -H "ngrok-skip-browser-warning: 1" "$ORIGIN/emit.js" -o "$MESH_HOME/emit.js.tmp" \\
  && mv -f "$MESH_HOME/emit.js.tmp" "$MESH_HOME/emit.js" \\
  || { rm -f "$MESH_HOME/emit.js.tmp"; echo "mesh: emit.js not available on this relay; hooks will be skipped" >&2; }
chmod +x "$MESH_HOME/mesh.mjs" "$MESH_HOME/emit.js" 2>/dev/null || true

if [ "\${MESH_FOREGROUND:-}" = "1" ]; then
  echo "mesh: joining room '$ROOM' via $RELAY (foreground; approvals in this terminal)"
else
  if [ "$(uname -s)" = "Linux" ] && ! command -v zenity >/dev/null 2>&1; then
    echo "mesh: no 'zenity' on this Linux box, so approvals need a terminal; running in the foreground (install zenity for background mode)"
    exec node "$MESH_HOME/mesh.mjs" join "$ROOM" --relay "$RELAY" "$@" </dev/tty
  fi
  node "$MESH_HOME/mesh.mjs" stop >/dev/null 2>&1 || true   # re-running the installer updates + restarts
  echo "mesh: joining room '$ROOM' via $RELAY in the background (approvals pop up as system dialogs)"
  rc=0
  node "$MESH_HOME/mesh.mjs" join "$ROOM" --relay "$RELAY" --background "$@" || rc=$?
  if [ $rc -eq 0 ]; then
    echo "mesh: done. Restart your coding agent session once so it picks up the mesh tools.  (status/stop: node ~/.mesh/mesh.mjs status)"
  else
    echo "mesh: join failed (exit $rc). See ~/.mesh/daemon.log" >&2
  fi
  exit $rc
fi
# When piped through \`curl | bash\` stdin is the script, not the terminal; the daemon needs a TTY to ask y/n.
if [ ! -t 0 ] && ( : </dev/tty ) 2>/dev/null; then
  exec node "$MESH_HOME/mesh.mjs" join "$ROOM" --relay "$RELAY" "$@" </dev/tty
fi
exec node "$MESH_HOME/mesh.mjs" join "$ROOM" --relay "$RELAY" "$@"
`;
}

/** PowerShell: `& ([scriptblock]::Create((irm -Headers @{'ngrok-skip-browser-warning'='1'} <origin>/install.ps1))) <room> [--as handle]` */
export function installPs1(o: { http: string; ws: string; host: string }): string {
  return `# mesh one-command join (PowerShell). Downloads the daemon bundle into %USERPROFILE%\\.mesh and joins a room.
#
#   & ([scriptblock]::Create((irm -Headers @{'ngrok-skip-browser-warning'='1'} ${o.http}/install.ps1))) <room> [--as handle] [--port 7337]
#
# Needs: node >= 20 (https://nodejs.org). No clone, no pnpm, no npm account.
$ErrorActionPreference = "Stop"
$Origin = "${o.http}"
$Relay = "${o.ws}"
$MeshHome = Join-Path $env:USERPROFILE ".mesh"

if ($args.Count -lt 1 -or [string]::IsNullOrWhiteSpace([string]$args[0]) -or ([string]$args[0]).StartsWith("-")) {
  Write-Error "usage: & ([scriptblock]::Create((irm -Headers @{'ngrok-skip-browser-warning'='1'} $Origin/install.ps1))) <room> [--as handle] [--port 7337]"
  exit 64
}
$Room = [string]$args[0]
$Rest = @()
if ($args.Count -gt 1) { $Rest = @($args[1..($args.Count - 1)]) }

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Write-Error "mesh: node is not installed. Install Node.js 20 or newer from https://nodejs.org and re-run."
  exit 1
}
# node -v prints e.g. v24.13.1; parse in PowerShell (no quotes cross the process boundary; Windows PowerShell strips them).
$ver = (& node -v).Trim().TrimStart('v')
$major = [int]($ver.Split('.')[0])
if ($major -lt 20) {
  Write-Error "mesh: node $(& node -v) is too old; need 20 or newer (https://nodejs.org)."
  exit 1
}

New-Item -ItemType Directory -Force -Path $MeshHome | Out-Null
$headers = @{ "ngrok-skip-browser-warning" = "1" }
Write-Host "mesh: downloading $Origin/mesh.mjs -> $MeshHome\\mesh.mjs"
Invoke-WebRequest -UseBasicParsing -Headers $headers -Uri "$Origin/mesh.mjs" -OutFile (Join-Path $MeshHome "mesh.mjs")
try {
  Invoke-WebRequest -UseBasicParsing -Headers $headers -Uri "$Origin/emit.js" -OutFile (Join-Path $MeshHome "emit.js")
} catch {
  Write-Warning "mesh: emit.js not available on this relay; hooks will be skipped"
}

& node (Join-Path $MeshHome "mesh.mjs") stop 2>$null | Out-Null   # re-running the installer updates + restarts
Write-Host "mesh: joining room '$Room' via $Relay in the background (approvals pop up as dialogs)"
& node (Join-Path $MeshHome "mesh.mjs") join $Room --relay $Relay --background @Rest
$joinExit = $LASTEXITCODE
if ($joinExit -ne 0) {
  Write-Host "mesh: join failed (exit $joinExit). Check the error above, then re-run the installer." -ForegroundColor Red
  exit $joinExit
}
Write-Host ('mesh: done. Restart your coding agent session once so it picks up the mesh tools.  (status: node "' + (Join-Path $MeshHome 'mesh.mjs') + '" status)')
exit 0
`;
}

// ---------- page ----------

function page(opts: { repoUrl: string; room?: string }): string {
  const room = opts.room ? JSON.stringify(opts.room) : "null";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>mesh${opts.room ? " · " + opts.room : ""}</title>
<style>
  /* Apple-style tokens, light + dark. Legacy names (--fg, --dim, --acc, --warn, --err, --link, --line) stay: the script uses some inline. */
  :root{--bg:#fff;--grouped:#f5f5f7;--surface:#fff;--surface-2:#fbfbfd;--label:#1d1d1f;--label-2:#6e6e73;--label-3:#86868b;
    --sep:rgba(0,0,0,.08);--sep-2:rgba(0,0,0,.14);--fill:rgba(0,0,0,.04);--fill-2:rgba(0,0,0,.07);
    --accent:#0071e3;--accent-text:#0066cc;--green:#1f9d3a;--green-dot:#28cd41;--amber:#b25f00;--red:#d70015;--glass:rgba(255,255,255,.72);
    --shadow:0 1px 2px rgba(0,0,0,.04),0 8px 24px -8px rgba(0,0,0,.08);
    --term:#0b0b0d;--term-bar:#1a1a1d;--term-text:#e4e4e7;--term-dim:#8a8a93;--term-line:rgba(255,255,255,.07);--term-edge:transparent;
    --r-lg:20px;--r-md:14px;--r-sm:10px;
    --fg:var(--label);--dim:var(--label-2);--acc:var(--green);--warn:var(--amber);--err:var(--red);--link:var(--accent-text);--line:var(--sep-2);
    --font:-apple-system,BlinkMacSystemFont,"SF Pro Text","SF Pro Display",Inter,"Helvetica Neue","Segoe UI",system-ui,sans-serif;
    --mono:ui-monospace,"SF Mono",SFMono-Regular,Menlo,Consolas,monospace}
  @media (prefers-color-scheme:dark){:root{--bg:#000;--grouped:#000;--surface:#161618;--surface-2:#1c1c1e;--label:#f5f5f7;--label-2:#a1a1a6;--label-3:#8e8e93;
    --sep:rgba(255,255,255,.1);--sep-2:rgba(255,255,255,.18);--fill:rgba(255,255,255,.06);--fill-2:rgba(255,255,255,.11);
    --accent:#0a84ff;--accent-text:#409cff;--green:#30d158;--green-dot:#30d158;--amber:#ffb340;--red:#ff6961;--glass:rgba(22,22,24,.72);
    --shadow:0 1px 2px rgba(0,0,0,.4),0 8px 24px -8px rgba(0,0,0,.6);--term:#0a0a0c;--term-bar:#141417;--term-edge:rgba(255,255,255,.08)}}
  *,*::before,*::after{box-sizing:border-box}[hidden]{display:none!important}
  html{-webkit-text-size-adjust:100%}
  body{margin:0;min-height:100vh;background:var(--grouped);color:var(--label);font:15px/1.5 var(--font);letter-spacing:-.01em;-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale}
  h1,h2,p,ol,ul{margin:0}ol,ul{padding:0;list-style:none}
  :focus-visible{outline:3px solid color-mix(in srgb,var(--accent) 55%,transparent);outline-offset:2px;border-radius:8px}
  a{color:var(--link);text-decoration:none}a:hover{text-decoration:underline}
  code{font:.9em/1.4 var(--mono);padding:1px 5px;border-radius:6px;background:var(--fill);overflow-wrap:anywhere}
  q{font-style:normal;color:var(--label)}q::before,q::after{content:none}
  .muted,.dim{color:var(--label-2)}.small{font-size:13px}
  .err{color:var(--red);font-size:13px;margin-top:8px}.err:empty{display:none}

  /* nav: the only glass */
  .nav{position:sticky;top:0;z-index:10;background:var(--glass);-webkit-backdrop-filter:saturate(180%) blur(20px);backdrop-filter:saturate(180%) blur(20px);border-bottom:1px solid var(--sep)}
  @media (prefers-reduced-transparency:reduce){.nav{background:var(--bg);-webkit-backdrop-filter:none;backdrop-filter:none}}
  .nav-inner{max-width:1080px;margin:0 auto;padding:0 24px;height:52px;display:flex;align-items:center;gap:10px}
  .brand{display:flex;align-items:center;gap:10px;color:var(--label);font-weight:600;font-size:19px;letter-spacing:-.02em}.brand:hover{text-decoration:none}
  .brand-mark{width:26px;height:26px;border-radius:7px;display:grid;place-items:center;background:var(--label);color:var(--bg)}.brand-mark svg{width:16px;height:16px}
  .badge{font:500 12px/1.6 var(--mono);color:var(--label-2);padding:1px 9px;border-radius:999px;background:var(--fill);border:1px solid var(--sep);letter-spacing:0;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .status{margin-left:auto;display:inline-flex;align-items:center;gap:7px;font-size:13px;color:var(--label-2);white-space:nowrap}
  .dot{width:8px;height:8px;border-radius:50%;background:var(--label-3);flex:none}
  .dot.live{background:var(--green-dot);box-shadow:0 0 0 3px color-mix(in srgb,var(--green-dot) 22%,transparent)}
  .dot.warn{background:var(--amber)}

  main{max-width:1080px;margin:0 auto;padding:0 24px 96px}
  @media (max-width:520px){main,.nav-inner{padding-left:16px;padding-right:16px}}

  /* page heads */
  .head{padding:44px 0 28px}
  .head.center{text-align:center;padding:84px 0 44px}
  .eyebrow{font-size:14px;font-weight:600;color:var(--accent-text);margin-bottom:10px}
  h1{font-size:clamp(30px,4.4vw,42px);line-height:1.08;font-weight:700;letter-spacing:-.032em;text-wrap:balance}
  .head.center h1{font-size:clamp(38px,6.6vw,64px);line-height:1.04;letter-spacing:-.04em}
  .lede{margin-top:12px;font-size:17px;line-height:1.45;color:var(--label-2);max-width:600px;text-wrap:pretty}
  .head.center .lede{margin:16px auto 0;font-size:clamp(17px,2vw,21px)}
  @media (max-width:520px){.head{padding:28px 0 20px}.head.center{padding:48px 0 32px}}

  /* surfaces */
  .card{background:var(--surface);border:1px solid var(--sep);border-radius:var(--r-lg);box-shadow:var(--shadow)}
  .pad{padding:22px 24px}
  @media (max-width:520px){.pad{padding:18px}.card{border-radius:18px}}
  h2{font-size:17px;font-weight:600;line-height:1.3;letter-spacing:-.02em}
  .card-head{display:flex;align-items:baseline;justify-content:space-between;gap:4px 12px;flex-wrap:wrap;margin-bottom:14px}
  .pill:empty{display:none}
  .pill{display:inline-block;padding:1px 9px;border-radius:999px;background:var(--fill);color:var(--label-2);font:500 12px/1.6 var(--font);letter-spacing:0;white-space:nowrap}

  /* controls */
  button,.btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:44px;background:var(--accent);color:#fff;border:1px solid transparent;border-radius:999px;padding:0 20px;font:500 15px/1.2 var(--font);letter-spacing:-.01em;cursor:pointer;text-align:center;transition:background-color .15s,transform .15s,color .15s}
  button:hover,.btn:hover{background:color-mix(in srgb,var(--accent) 88%,#000);text-decoration:none}
  button:active{transform:scale(.98)}
  button:disabled{opacity:.55;cursor:default;transform:none}
  button.ghost,.btn.ghost{min-height:36px;background:var(--fill);color:var(--label);border-color:var(--sep);padding:0 14px;font-size:14px}
  button.ghost:hover,.btn.ghost:hover{background:var(--fill-2)}
  button.danger{color:var(--red);background:transparent;border-color:color-mix(in srgb,var(--red) 30%,transparent)}
  button.danger:hover{background:color-mix(in srgb,var(--red) 8%,transparent)}
  button.danger.armed{background:var(--red);color:#fff;border-color:var(--red)}
  input{min-height:44px;width:100%;min-width:0;background:var(--surface);color:var(--label);border:1px solid var(--sep-2);border-radius:12px;padding:10px 14px;font:15px var(--font);letter-spacing:-.01em}
  input::placeholder{color:var(--label-3)}
  input:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--accent) 25%,transparent)}
  .field{display:flex;gap:8px;flex-wrap:wrap}.field input{flex:1 1 200px}.field button{min-height:44px;flex:none}
  details>summary{list-style:none;display:inline-flex;align-items:center;gap:8px;min-height:32px;cursor:pointer;color:var(--accent-text);font-size:14px;font-weight:500;border-radius:8px}
  details>summary::-webkit-details-marker{display:none}
  details>summary::before{content:"";width:6px;height:6px;margin:0 2px;border-right:1.6px solid currentColor;border-bottom:1.6px solid currentColor;transform:rotate(-45deg);transition:transform .15s}
  details[open]>summary::before{transform:rotate(45deg);margin-top:-3px}
  details[open]>summary{margin-bottom:8px}
  @media (prefers-reduced-motion:reduce){*,*::before,*::after{transition:none!important;animation:none!important}}

  /* code snippets (manual setup) */
  .snippet{display:flex;align-items:flex-start;gap:12px;background:var(--term);color:var(--term-text);border:1px solid var(--term-edge);border-radius:12px;padding:10px 10px 10px 16px;margin:8px 0 14px}
  .snippet code{flex:1;min-width:0;padding:6px 0;background:none;color:inherit;font:12.5px/1.6 var(--mono);white-space:pre-wrap;word-break:break-all}
  .copy{flex:none;white-space:nowrap}
  .snippet .copy,.term .copy{background:rgba(255,255,255,.1);color:#fff;border-color:rgba(255,255,255,.14)}
  .snippet .copy:hover,.term .copy:hover{background:rgba(255,255,255,.18)}

  /* ---------- front door ---------- */
  .door{display:grid;grid-template-columns:1fr 1fr;max-width:880px;margin:0 auto}
  .door>div{padding:28px 30px}
  .door>div+div{border-left:1px solid var(--sep)}
  .door p.muted{margin:6px 0 18px}
  .door #start{min-height:48px;padding:0 26px;font-size:16px}
  .door details{margin-top:4px}
  .door details .field{margin-top:4px}.door details input{flex-basis:120px}
  @media (max-width:720px){.door{grid-template-columns:1fr}.door>div{padding:22px 20px}.door>div+div{border-left:0;border-top:1px solid var(--sep)}}
  .how{max-width:880px;margin:56px auto 0}
  .how>h2{font-size:13px;font-weight:600;color:var(--label-2);letter-spacing:0;margin:0 0 14px 2px}
  .how ol{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;counter-reset:how}
  .how li{counter-increment:how;padding:18px;border-radius:var(--r-md);background:var(--surface);border:1px solid var(--sep)}
  .how li::before{content:counter(how);display:grid;place-items:center;width:24px;height:24px;margin-bottom:12px;border-radius:50%;background:var(--fill-2);color:var(--label);font:600 12px/1 var(--font)}
  .how li b{display:block;font-size:15px;font-weight:600;margin-bottom:4px;letter-spacing:-.015em}
  .how li span{display:block;font-size:13px;line-height:1.45;color:var(--label-2)}
  .how .foot{margin-top:18px;text-align:center;font-size:13px;color:var(--label-2)}
  @media (max-width:820px){.how ol{grid-template-columns:1fr 1fr}}
  @media (max-width:480px){.how{margin-top:36px}.how ol{grid-template-columns:1fr}.how li{display:grid;grid-template-columns:24px 1fr;column-gap:14px;padding:14px 16px}.how li::before{grid-row:span 2;margin:0}}

  /* ---------- room ---------- */
  .room{display:grid;grid-template-columns:minmax(0,1fr) 340px;grid-template-areas:"steps side" "feed side";gap:20px;align-items:start}
  .steps-card{grid-area:steps}.activity{grid-area:feed}
  .side{grid-area:side;display:flex;flex-direction:column;gap:20px}
  @media (max-width:900px){.room{grid-template-columns:minmax(0,1fr);grid-template-areas:none;gap:16px}.side{display:contents}.steps-card,.activity{grid-area:auto}
    .invite{order:1}.steps-card{order:2}.people{order:3}.activity{order:4}}

  /* invite */
  .linkbox{padding:10px 12px;border-radius:12px;background:var(--fill);border:1px solid var(--sep);font:12.5px/1.5 var(--mono);color:var(--label);word-break:break-all;user-select:all}
  .invite-actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px}
  .invite-actions .copy{min-height:36px;padding:0 16px;font-size:14px}
  .invite .note{margin-top:12px}
  .owner{margin-top:14px;padding-top:14px;border-top:1px solid var(--sep)}
  .owner p{margin-top:8px}
  .owner .err{min-height:0}

  /* steps */
  .step{position:relative;display:grid;grid-template-columns:28px minmax(0,1fr);column-gap:16px;padding:20px 24px}
  .step+.step{border-top:1px solid var(--sep)}
  .step-num{position:relative;z-index:1;display:grid;place-items:center;width:28px;height:28px;border-radius:50%;font:600 13px/1 var(--font);letter-spacing:0;background:var(--surface);color:var(--label-2);box-shadow:inset 0 0 0 1.5px var(--sep-2);transition:background-color .2s,color .2s}
  .step-num svg{display:none;width:14px;height:14px}
  .step[data-state="current"] .step-num{background:var(--label);color:var(--bg);box-shadow:none}
  .step[data-state="done"] .step-num{background:var(--green);color:#fff;box-shadow:none}
  .step[data-state="done"] .step-num span{display:none}.step[data-state="done"] .step-num svg{display:block}
  h2.step-title{font-size:17px}
  button.step-toggle{all:unset;box-sizing:border-box;display:flex;align-items:center;gap:10px;width:100%;min-height:28px;cursor:pointer;color:var(--label);font:600 17px/1.3 var(--font);letter-spacing:-.02em;border-radius:8px}
  button.step-toggle:focus-visible{outline:3px solid color-mix(in srgb,var(--accent) 55%,transparent);outline-offset:4px}
  .step-sum{font:400 14px/1.3 var(--font);color:var(--label-2);letter-spacing:-.01em;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .step-sum:empty{display:none}
  .chev{margin-left:auto;flex:none;width:8px;height:8px;border-right:1.6px solid var(--label-3);border-bottom:1.6px solid var(--label-3);transform:rotate(45deg) translate(-2px,-2px);transition:transform .15s}
  button.step-toggle[aria-expanded="false"] .chev{transform:rotate(-45deg)}
  .step-body{grid-column:2;padding-top:10px}
  .step-body>p{margin-bottom:12px}.step-body>p:last-child{margin-bottom:0}
  .step-body .field-help{margin-top:8px}
  .step-body .field input{max-width:320px}
  .more{display:flex;flex-direction:column;align-items:flex-start;gap:2px;margin-top:10px}
  .more details{width:100%}.more details p{margin:0 0 8px}
  @media (max-width:520px){.step{padding:18px;column-gap:12px}.step-body{grid-column:1/-1}}

  /* install terminal: the hero of step 2 */
  .term{background:var(--term);color:var(--term-text);border:1px solid var(--term-edge);border-radius:var(--r-md);overflow:hidden;box-shadow:0 12px 32px -18px rgba(0,0,0,.5)}
  .term-bar{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px;padding:8px 8px 8px 10px;background:var(--term-bar);border-bottom:1px solid var(--term-line)}
  .tabs{display:inline-flex;padding:2px;border-radius:9px;background:rgba(255,255,255,.07)}
  .tabs button{white-space:nowrap;min-height:30px;padding:0 12px;border:0;border-radius:7px;background:transparent;color:var(--term-dim);font-size:13px}
  .tabs button:hover{background:rgba(255,255,255,.06);color:var(--term-text)}
  .tabs button.on{background:rgba(255,255,255,.16);color:#fff}
  .term-code{display:flex;gap:10px;margin:0;padding:16px 18px 18px;font:13.5px/1.65 var(--mono)}
  .term-code .prompt{flex:none;color:var(--term-dim);user-select:none}
  .term-code code{flex:1;min-width:0;padding:0;background:none;color:inherit;font:inherit;white-space:pre-wrap;word-break:break-all}
  .step-hint{margin-top:10px}
  .ok-note{display:flex;gap:10px;align-items:flex-start;margin-top:12px;padding:10px 12px;border-radius:12px;background:color-mix(in srgb,var(--green) 9%,transparent);font-size:13px;color:var(--label)}
  .ok-note::before{content:"";flex:none;width:8px;height:8px;margin-top:6px;border-radius:50%;background:var(--green-dot)}
  .ok-note code{white-space:nowrap;background:color-mix(in srgb,var(--green) 12%,transparent)}
  .tip{margin:0 0 6px;padding:12px 14px;border-radius:12px;background:var(--fill);font-size:14px}
  .tip b{display:block;font-size:13px;margin-bottom:2px}
  .examples li{display:grid;grid-template-columns:150px minmax(0,1fr);gap:4px 16px;padding:10px 0;font-size:14px}
  .examples li+li{border-top:1px solid var(--sep)}
  .examples li:first-child{padding-top:2px}.examples li:last-child{padding-bottom:0}
  .examples b{font-weight:600}.examples span{color:var(--label-2)}
  @media (max-width:600px){.examples li{grid-template-columns:1fr}}

  /* teammates */
  .members{display:flex;flex-direction:column}
  .m{display:grid;grid-template-columns:36px minmax(0,1fr);column-gap:12px;padding:10px 0;align-items:start}
  .m+.m{border-top:1px solid var(--sep)}
  .m:first-child{padding-top:0}
  .avatar{position:relative;display:grid;place-items:center;width:36px;height:36px;border-radius:50%;background:var(--fill-2);color:var(--label);font:600 14px/1 var(--font);text-transform:uppercase;letter-spacing:0}
  .avatar i{position:absolute;right:-1px;bottom:-1px;width:11px;height:11px;border-radius:50%;background:var(--label-3);border:2px solid var(--surface)}
  .m.on .avatar i{background:var(--green-dot)}
  .m.off .avatar,.m.off .m-name{opacity:.6}
  .m-top{display:flex;align-items:center;gap:8px;min-height:36px;flex-wrap:wrap}
  .m-name{font-size:15px;font-weight:600;min-width:0;overflow-wrap:anywhere}
  .you{font:500 11px/1.6 var(--font);padding:0 7px;border-radius:999px;background:color-mix(in srgb,var(--accent) 12%,transparent);color:var(--accent-text)}
  .m-state{margin-left:auto;font-size:12px;color:var(--label-3);white-space:nowrap}
  .m.on .m-state{color:var(--green)}
  .m-tools{grid-column:2;margin-top:-4px;font-size:13px}
  .m-tools details>summary{font-size:13px;min-height:26px}
  .offers{display:flex;flex-wrap:wrap;gap:5px}
  .offer{display:inline-block;max-width:100%;padding:2px 9px;border-radius:999px;font:12px/1.5 var(--mono);color:var(--label-2);background:var(--fill);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .offer.always{color:var(--green);background:color-mix(in srgb,var(--green) 12%,transparent)}
  .offer.ask{color:var(--amber);background:color-mix(in srgb,var(--amber) 12%,transparent)}
  .offer.never{color:var(--red);background:color-mix(in srgb,var(--red) 12%,transparent)}
  .legend{display:flex;flex-wrap:wrap;gap:4px 12px;margin-top:12px;font-size:12px;color:var(--label-2)}
  .legend span{display:inline-flex;align-items:center;gap:5px}.legend i{width:7px;height:7px;border-radius:50%}
  .empty{padding:18px 16px;border-radius:12px;background:var(--fill);text-align:center}
  .empty b{display:block;font-size:14px;margin-bottom:2px}
  .empty span{display:block;font-size:13px;color:var(--label-2);text-wrap:pretty}
  .popout{display:flex;align-items:center;justify-content:space-between;gap:10px 14px;flex-wrap:wrap;margin-top:16px;padding-top:16px;border-top:1px solid var(--sep)}
  .popout div{flex:1 1 170px}.popout b{display:block;font-size:14px;font-weight:600}.popout p{font-size:13px;color:var(--label-2)}

  /* live feed: a terminal in both themes, so its colors are fixed */
  .feed{background:var(--term);color:var(--term-text);border:1px solid var(--term-edge);border-radius:var(--r-md);padding:8px 16px;font:12.5px/1.6 var(--mono);min-height:132px;max-height:440px;overflow:auto;overscroll-behavior:contain}
  .feed-empty{display:grid;place-items:center;min-height:114px;text-align:center;color:var(--term-dim);font:13px/1.5 var(--font);text-wrap:balance}
  .ev{display:grid;grid-template-columns:64px 88px minmax(0,1fr);column-gap:12px;padding:6px 0;border-top:1px solid var(--term-line)}
  .ev:first-child{border-top:0}
  .ev .b{min-width:0;white-space:pre-wrap;overflow-wrap:anywhere}
  .ev.out{border-top:0;padding-top:0}.ev.out .b{grid-column:3}
  .feed .t{color:var(--term-dim)}.feed .u{color:#7cc4ff;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .feed .req{color:#fbbf24}.feed .ok{color:#4ade80}.feed .no{color:#fb7185}.feed .out{color:var(--term-dim)}.feed .k{color:var(--term-dim)}
  .feed .why{display:block;color:var(--term-dim)}
  .feed .chip{border-color:rgba(255,255,255,.16);background:rgba(255,255,255,.08);color:#7cc4ff}.feed .chip .sz{color:var(--term-dim)}
  @media (max-width:560px){.ev{grid-template-columns:auto minmax(0,1fr)}.ev .b,.ev.out .b{grid-column:1/-1}}
  .chip{display:inline-block;margin:4px 4px 0 0;padding:1px 9px;border-radius:999px;border:1px solid var(--sep-2);background:var(--fill);color:var(--link);font:12px/1.5 var(--font);text-decoration:none;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;vertical-align:middle}
  .chip:hover{border-color:var(--link);text-decoration:none}.chip .sz{color:var(--label-2)}.chips{display:block}

  /* single-message states: ended, needs a link */
  .notice{max-width:520px;margin:72px auto 0;padding:32px;text-align:center}
  .notice .glyph{display:grid;place-items:center;width:48px;height:48px;margin:0 auto 16px;border-radius:50%;background:var(--fill-2);color:var(--label-2)}
  .notice .glyph svg{width:22px;height:22px}
  .notice h1{font-size:26px;letter-spacing:-.025em}
  .notice p{margin-top:8px;color:var(--label-2);text-wrap:pretty}
  .notice .field{margin-top:20px;text-align:left}
  .notice .actions{margin-top:22px}
  .notice .err{margin-top:10px}
  .notice .hint{margin-top:10px;font-size:13px;color:var(--label-2)}
  @media (max-width:520px){.notice{margin-top:32px;padding:24px 18px}.notice .field{flex-direction:column}.notice .field input{flex-basis:auto}}
</style></head><body>
<header class="nav"><div class="nav-inner">
  <a class="brand" href="/" aria-label="mesh home"><span class="brand-mark" aria-hidden="true"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="3.5" cy="4" r="2"/><circle cx="12.5" cy="4" r="2"/><circle cx="8" cy="12.5" r="2"/><path d="M5.5 4h5M4.6 5.8l2.3 5M11.4 5.8l-2.3 5"/></svg></span>mesh</a>
  ${opts.room ? '<span class="badge">' + opts.room + '</span>' : ''}
  <span class="status" id="status" role="status" hidden><span class="dot" id="status-dot"></span><span id="status-text"></span></span>
</div></header>
<main id="app"><noscript><section class="notice card"><h1>mesh needs JavaScript</h1><p>Turn on JavaScript to start or join a room.</p></section></noscript></main>
<script>
const ROOM = ${room};
const REPO = ${JSON.stringify(opts.repoUrl)};
const RELAY = (location.protocol === "https:" ? "wss://" : "ws://") + location.host;
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const ICON = {
  check: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7"/></svg>',
  stop: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><circle cx="12" cy="12" r="9"/><rect x="9" y="9" width="6" height="6" rx="1" fill="currentColor" stroke="none"/></svg>',
  link: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M10 14a4.5 4.5 0 006.4 0l3-3a4.5 4.5 0 00-6.4-6.4l-1 1"/><path d="M14 10a4.5 4.5 0 00-6.4 0l-3 3a4.5 4.5 0 006.4 6.4l1-1"/></svg>',
};
// Copy buttons carry their text in data-copy; one delegated handler copies (clipboard API, execCommand fallback on plain http).
function copyBtn(txt, label, cls){ label = label || "Copy"; return '<button type="button" class="' + (cls || "ghost") + ' copy" data-copy="' + esc(txt) + '" data-label="' + esc(label) + '">' + esc(label) + '</button>'; }
function pre(txt){ return '<div class="snippet"><code>' + esc(txt) + '</code>' + copyBtn(txt) + '</div>'; }
document.addEventListener("click", (e) => {
  const b = e.target && e.target.closest ? e.target.closest("[data-copy]") : null;
  if (!b) return;
  const txt = b.getAttribute("data-copy") || "", label = b.getAttribute("data-label") || "Copy";
  const done = (ok) => { b.textContent = ok ? "Copied" : "Copy failed"; clearTimeout(b._t); b._t = setTimeout(() => { b.textContent = label; }, 1400); };
  const fallback = () => {
    const ta = document.createElement("textarea"); ta.value = txt; ta.setAttribute("readonly", ""); ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.appendChild(ta); ta.select(); let ok = false; try { ok = document.execCommand("copy"); } catch (err) {} ta.remove(); done(ok);
  };
  if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(txt).then(() => done(true), fallback); else fallback();
});
function setStatus(state, text){
  const s = $("#status"); if (!s) return;
  s.hidden = false; $("#status-text").textContent = text;
  $("#status-dot").className = "dot" + (state === "live" ? " live" : state === "warn" ? " warn" : "");
}
function notice(icon, title, body, extra){
  return '<section class="notice card"><div class="glyph">' + icon + '</div><h1>' + title + '</h1>' + body + (extra || "") + '</section>';
}

// ---- room key (docs/ROOM-KEYS.md): it lives in the URL fragment, never in a request line ----
const KEY_RE = /^[a-z2-7]{16}$/;
// "#k=abc", "k=abc", "…/r/room#k=abc" or a bare key → the key, or "".
function keyFromHash(h) {
  const s = String(h || "").replace(/^[^#]*#/, "").replace(/^#/, "");
  for (const part of s.split(/[&;]/)) { const m = /^k=(.+)$/.exec(part.trim()); if (m) return decodeURIComponent(m[1]).trim().toLowerCase(); }
  return "";
}
// Owner token (End session): "#k=…&o=<token>" on the creator's link only → the token, or "".
const OWNER_RE = /^[a-z2-7]{16}$/;
function ownerFromHash(h) {
  const s = String(h || "").replace(/^[^#]*#/, "").replace(/^#/, "");
  for (const part of s.split(/[&;]/)) { const m = /^o=(.+)$/.exec(part.trim()); if (m) { const v = decodeURIComponent(m[1]).trim().toLowerCase(); return OWNER_RE.test(v) ? v : ""; } }
  return "";
}
/** Parse anything a teammate might paste: a full room link, a "room#k=key", or a bare key. */
function parseRoomLink(raw) {
  const v = String(raw || "").trim();
  if (!v) return null;
  if (KEY_RE.test(v)) return { room: "", key: v };
  let u = null;
  try { u = new URL(v, location.origin); } catch (e) { u = null; }
  if (u) {
    const m = /^\\/r\\/([a-z0-9][a-z0-9-]{1,40})$/.exec(u.pathname);
    if (m) return { room: m[1], key: keyFromHash(u.hash), owner: ownerFromHash(u.hash), origin: u.origin };
  }
  const m2 = /^([a-z0-9][a-z0-9-]{1,40})(?:#|\\?)?/.exec(v);
  return m2 ? { room: m2[1], key: keyFromHash(v), owner: ownerFromHash(v) } : null;
}
const keyed = (u, key) => (key && String(u).indexOf("/api/files/") >= 0 ? u + (String(u).indexOf("?") >= 0 ? "&" : "?") + "key=" + encodeURIComponent(key) : u);
function lsGet(k){ try { return localStorage.getItem(k) || ""; } catch (e) { return ""; } }
function lsSet(k, v){ try { localStorage.setItem(k, v); } catch (e) {} }
// The key comes from the fragment; we remember it so a bare /r/<room> keeps working in this browser.
const HASH_KEY = ROOM ? keyFromHash(location.hash) : "";
if (ROOM && HASH_KEY) lsSet("mesh.key." + ROOM, HASH_KEY);
const KEY = ROOM ? (HASH_KEY || lsGet("mesh.key." + ROOM)) : "";
function lsDel(k){ try { localStorage.removeItem(k); } catch (e) {} }
// The owner token rides in the creator's fragment once: remember it, then scrub it from the address bar so copying
// the URL never leaks it. The displayed/copyable share link never contains it.
const HASH_OWNER = ROOM ? ownerFromHash(location.hash) : "";
if (ROOM && HASH_OWNER) lsSet("mesh.owner." + ROOM, HASH_OWNER);
if (ROOM && /(^|[#&;])o=/.test(location.hash)) {
  try { history.replaceState(null, "", location.pathname + location.search + (HASH_KEY ? "#k=" + HASH_KEY : "")); } catch (e) {}
}
const OWNER = ROOM ? (HASH_OWNER || lsGet("mesh.owner." + ROOM)) : "";

if (!ROOM) {
  // ---------- front door ----------
  $("#app").innerHTML = \`
    <section class="head center"><p class="eyebrow">For Claude Code, Codex and Cursor</p>
      <h1>A meeting room<br>for your coding agents.</h1>
      <p class="lede">Everyone’s assistant joins one room and borrows each other’s tools, with a click to approve. Passwords and keys never move.</p></section>
    <section class="door card">
      <div><h2>Start a session</h2>
        <p class="muted">Creates a room and gives you a link to send your team.</p>
        <button id="start" type="button">Start a session</button>
        <p class="err" id="serr" role="alert"></p></div>
      <div><h2>Join a room</h2>
        <p class="muted">Someone sent you a link? Paste it here.</p>
        <div class="field"><input id="jlink" aria-label="Room link" placeholder="https://…/r/room#k=…" autocomplete="off" spellcheck="false"><button class="ghost" id="jgo" type="button">Open</button></div>
        <p class="err" id="jerr" role="alert"></p>
        <details><summary>I only have the room name and key</summary>
          <div class="field"><input id="jroom" aria-label="Room name" placeholder="room" maxlength="42" autocomplete="off" spellcheck="false"><input id="jkey" aria-label="Room key" placeholder="key" maxlength="32" autocomplete="off" spellcheck="false"><button class="ghost" id="jgo2" type="button">Open</button></div>
        </details></div>
    </section>
    <section class="how" aria-labelledby="how-title"><h2 id="how-title">What happens</h2>
      <ol>
        <li><b>Start a room, send the link</b><span>The link is the only password, so send it only to your team.</span></li>
        <li><b>Everyone runs one command</b><span>Paste it in a terminal. About 20 seconds, needs only Node.js.</span></li>
        <li><b>Everyone restarts their assistant</b><span>Claude Code, Codex, or Cursor. Now it knows who’s in the room.</span></li>
        <li><b>Ask for what you need</b><span>A teammate clicks Approve, it runs on their computer, and the result comes back to you.</span></li>
      </ol>
      <p class="foot">No accounts. Tools run on their owner’s computer, and keys never leave it.</p>
    </section>\`;
  $("#start").onclick = async () => {
    const b = $("#start"), err = $("#serr");
    b.disabled = true; b.textContent = "Starting…"; err.textContent = "";
    try {
      const res = await fetch("/api/rooms", { method: "POST" });
      const r = await res.json().catch(() => ({}));
      if (!res.ok || !r.room) throw new Error((r && r.error) || ("HTTP " + res.status));
      // The creator lands on the owner link (#k=<key>&o=<owner>); the room page stores the owner token and scrubs it.
      location.href = "/r/" + r.room + (r.key ? "#k=" + r.key + (r.ownerToken ? "&o=" + r.ownerToken : "") : "");
    } catch (e) {
      b.disabled = false; b.textContent = "Start a session";
      err.textContent = "Couldn’t start a session: " + ((e && e.message) || "the relay did not answer") + ".";
    }
  };
  const go = (raw) => {
    const p = parseRoomLink(raw);
    const err = $("#jerr");
    if (!p || !p.room) { err.textContent = "That doesn't look like a room link. It should end in /r/<room>#k=<key>."; return; }
    const base = p.origin && p.origin !== location.origin ? p.origin : "";
    location.href = base + "/r/" + p.room + (p.key ? "#k=" + p.key + (p.owner ? "&o=" + p.owner : "") : "");
  };
  $("#jgo").onclick = () => go($("#jlink").value);
  $("#jlink").onkeydown = (e) => { if (e.key === "Enter") go($("#jlink").value); };
  const go2 = () => {
    const room = $("#jroom").value.trim().toLowerCase(), key = $("#jkey").value.trim().toLowerCase();
    go(room + (key ? "#k=" + key : ""));
  };
  $("#jgo2").onclick = go2;
  $("#jkey").onkeydown = (e) => { if (e.key === "Enter") go2(); };
} else if (!KEY) {
  // No key in the fragment and none remembered: this page shows nothing about the room until it has the link.
  $("#app").innerHTML = notice(ICON.link, "Open room " + esc(ROOM),
    '<p>You’ll need the room link. Paste the link your teammate sent you to continue.</p>',
    '<div class="field"><input id="k" aria-label="Room link" placeholder="Paste the room link" autocomplete="off" spellcheck="false"><button id="kgo" type="button">Open room</button></div>' +
    '<p class="err" id="kerr" role="alert"></p>' +
    '<p class="hint">It looks like <code>' + esc(location.origin) + '/r/' + esc(ROOM) + '#k=…</code><br>Ask whoever started the session to send it to you.</p>');
  const use = () => {
    const p = parseRoomLink($("#k").value);
    if (!p || !p.key) { $("#kerr").textContent = "No key found in that. The link ends in #k=<key>."; return; }
    if (p.room && p.room !== ROOM) { location.href = (p.origin && p.origin !== location.origin ? p.origin : "") + "/r/" + p.room + "#k=" + p.key; return; }
    lsSet("mesh.key." + ROOM, p.key);
    if (p.owner) lsSet("mesh.owner." + ROOM, p.owner);
    location.hash = "k=" + p.key;
    location.reload();
  };
  $("#kgo").onclick = use;
  $("#k").onkeydown = (e) => { if (e.key === "Enter") use(); };
} else {
  const LINK = location.origin + "/r/" + ROOM + "#k=" + KEY;
  let me = lsGet("mesh.user");
  let shell = lsGet("mesh.shell") || (navigator.userAgent.includes("Windows") ? "ps" : "bash");
  const asFlag = () => " --key " + KEY + (OWNER ? " --owner " + OWNER : "") + (me ? " --as " + me : "");
  let ended = false;
  let meOnline = false;
  // Polling got 410 or this page ended the session: stop for good and say so.
  const showEnded = (msg) => {
    ended = true;
    lsDel("mesh.owner." + ROOM);
    setStatus("off", "Ended");
    $("#app").innerHTML = notice(ICON.stop, "This session has ended",
      '<p>' + esc(msg || "The person who started it ended it for everyone. Everyone was disconnected and this link no longer works.") + '</p>',
      '<div class="actions"><a class="btn" href="/">Start a new session</a></div>');
  };
  let endArmed = false, endTimer = null;
  const END_LABEL = "End session for everyone";
  const endSession = async (b) => {
    const err = $("#enderr"), warn = $("#endwarn");
    if (!endArmed) {
      endArmed = true; b.textContent = "Click again to end it for everyone"; b.classList.add("armed");
      if (warn) warn.hidden = false;
      endTimer = setTimeout(() => { endArmed = false; b.textContent = END_LABEL; b.classList.remove("armed"); if (warn) warn.hidden = true; }, 6000);
      return;
    }
    clearTimeout(endTimer); endArmed = false; b.disabled = true; b.textContent = "Ending…";
    try {
      const res = await fetch("/api/rooms/" + encodeURIComponent(ROOM) + "/end?key=" + encodeURIComponent(KEY), {
        method: "POST", headers: { "content-type": "application/json", "x-mesh-owner": OWNER },
        body: JSON.stringify({ by: lsGet("mesh.user") || undefined }),
      });
      const j = await res.json().catch(() => ({}));
      if (res.ok) { showEnded("You ended the session. Everyone was disconnected and this link no longer works."); return; }
      b.disabled = false; b.textContent = END_LABEL; b.classList.remove("armed"); if (warn) warn.hidden = true;
      if (err) err.textContent = (j && j.error) || ("Could not end the session (HTTP " + res.status + ").");
    } catch (e) {
      b.disabled = false; b.textContent = END_LABEL; b.classList.remove("armed"); if (warn) warn.hidden = true;
      if (err) err.textContent = "Could not reach the relay. Try again.";
    }
  };
  const joinCmd = (sh) => sh === "ps"
    ? "& ([scriptblock]::Create((irm -Headers @{'ngrok-skip-browser-warning'='1'} " + location.origin + "/install.ps1))) " + ROOM + asFlag()
    : "curl -fsSL " + location.origin + "/install.sh | bash -s -- " + ROOM + asFlag();
  const renderJoin = () => {
    const el = $("#join"); if (!el) return;
    const cmd = joinCmd(shell);
    el.textContent = cmd;
    const pr = $("#join-prompt"); if (pr) pr.textContent = shell === "ps" ? "PS>" : "$";
    const cp = $("#join-copy"); if (cp) cp.innerHTML = copyBtn(cmd, "Copy command");
    document.querySelectorAll(".tabs button").forEach((b) => { const on = b.dataset.sh === shell; b.classList.toggle("on", on); b.setAttribute("aria-pressed", on ? "true" : "false"); });
    const help = $("#platform-help");
    if (help) help.textContent = shell === "ps"
      ? "Open PowerShell in your project folder, paste the command, and press Enter."
      : "Open Terminal in your project folder, paste the command, and press Enter.";
  };

  // Steps: number → check as they complete. Steps 1–2 fold away once this browser's name shows up in the room.
  const touched = new Set();
  let autoFolded = false;
  const setOpen = (n, open) => {
    const t = $("#s" + n + "-toggle"), body = $("#s" + n + "-body");
    if (!t || !body) return;
    t.setAttribute("aria-expanded", open ? "true" : "false"); body.hidden = !open;
  };
  const updateSteps = () => {
    const state = (n) => n === 1 ? (me ? "done" : "current")
      : n === 2 ? (meOnline ? "done" : me ? "current" : "todo")
      : n === 3 ? (meOnline ? "current" : "todo") : "todo";
    for (const n of [1, 2, 3, 4]) { const s = $("#s" + n); if (s) s.dataset.state = state(n); }
    const s1 = $("#s1-sum"); if (s1) s1.textContent = me ? "· " + me : "";
    const s2 = $("#s2-sum"); if (s2) s2.textContent = meOnline ? "· Connected" : "";
    const title = $("#room-title"), lede = $("#room-lede");
    if (title) title.textContent = meOnline ? "You’re in the room." : "Bring your coding assistant into the room.";
    if (lede) lede.textContent = meOnline
      ? "Your assistant can now ask teammates for help. Requests and results show up under Room activity."
      : "Four steps, about a minute. Then your assistant can borrow teammates’ tools, with their OK.";
    if (meOnline && !autoFolded) {
      autoFolded = true;
      const inStep1 = document.activeElement && document.activeElement.id === "me";
      if (!touched.has(1) && !inStep1) setOpen(1, false);
      if (!touched.has(2)) setOpen(2, false);
    }
  };
  const step = (n, title, body) =>
    '<li class="step" id="s' + n + '" data-state="todo"><span class="step-num" aria-hidden="true"><span>' + n + '</span>' + ICON.check + '</span>' +
    '<div><h2 class="step-title"><button type="button" class="step-toggle" id="s' + n + '-toggle" aria-expanded="true" aria-controls="s' + n + '-body">' +
    title + '<span class="step-sum" id="s' + n + '-sum"></span><span class="chev" aria-hidden="true"></span></button></h2></div>' +
    '<div class="step-body" id="s' + n + '-body">' + body + '</div></li>';

  const render = () => {
    setStatus("warn", "Connecting…");
    $("#app").innerHTML = \`
      <section class="head"><p class="eyebrow">Room \${esc(ROOM)}</p>
        <h1 id="room-title">Bring your coding assistant into the room.</h1>
        <p class="lede" id="room-lede">Four steps, about a minute. Then your assistant can borrow teammates’ tools, with their OK.</p></section>
      <div class="room">
        <section class="card steps-card" aria-label="Setup"><ol class="steps">
        \${step(1, "Choose your name", \`
          <div class="field"><input id="me" aria-label="Your name" value="\${esc(me)}" placeholder="e.g. tarush" maxlength="32" autocomplete="off" spellcheck="false" autocapitalize="off"></div>
          <p class="small muted field-help">Short, lowercase, no spaces. Teammates’ assistants use it to find you.</p>\`)}
        \${step(2, "Install mesh", \`
          <p class="muted">One command, about 20 seconds. Needs <a href="https://nodejs.org" target="_blank" rel="noopener">Node.js 20 or newer</a>.</p>
          <div class="term">
            <div class="term-bar"><div class="tabs" role="group" aria-label="Your computer"><button type="button" data-sh="bash">macOS / Linux</button><button type="button" data-sh="ps">Windows</button></div><span id="join-copy"></span></div>
            <pre class="term-code"><span class="prompt" id="join-prompt" aria-hidden="true">$</span><code id="join"></code></pre>
          </div>
          <p class="small muted step-hint" id="platform-help"></p>
          <p class="ok-note"><span>When you see <code>● mesh running in the background</code>, you’re in. Your name appears under Teammates, and you can close the terminal.</span></p>
          <div class="more">
            <details><summary>Use a downloadable file instead</summary>
              <p class="small"><b>Windows:</b> download <a id="dl-cmd" href="#">mesh-join-\${esc(ROOM)}.cmd</a> and double-click it.</p>
              <p class="small"><b>macOS:</b> download <a id="dl-command" href="#">mesh-join-\${esc(ROOM)}.command</a>, then right-click it and choose Open.</p></details>
            <details><summary>What does this command do?</summary>
              <p class="small muted">It downloads mesh to your home folder, starts it in the background, and connects this room to your coding assistant. Your existing MCP tools are shared with permission set to “ask,” so you approve every request before it runs. Check on it with <code>node ~/.mesh/mesh.mjs status</code>; leave with <code>node ~/.mesh/mesh.mjs stop</code>.</p></details>
          </div>\`)}
        \${step(3, "Restart your coding assistant", \`
          <p class="muted">Open a new Claude Code, Codex, or Cursor session in the same project folder so it can find mesh.</p>
          <div class="tip"><b>Check that it worked</b>Ask your assistant: <q>“List my mesh teammates.”</q> It should name the people under Teammates.</div>
          <div class="more"><details><summary>Manual setup (if the check fails)</summary>
            <p class="small">Claude Code, in a terminal in your project folder:</p>
            \${pre("claude mcp add --transport http mesh http://localhost:7337/mcp")}
            <p class="small">Codex CLI, in any terminal:</p>
            \${pre("codex mcp add mesh --url http://localhost:7337/mcp")}
            <p class="small">Cursor: create <code>.cursor/mcp.json</code> in your project with this content, then restart Cursor:</p>
            \${pre('{ "mcpServers": { "mesh": { "url": "http://localhost:7337/mcp" } } }')}
            <p class="small muted">Working on mesh itself? Run from the repo instead: <code>pnpm -F daemon start join \${esc(ROOM)} --key \${esc(KEY)}\${OWNER ? " --owner " + esc(OWNER) : ""} --as &lt;you&gt; --relay \${esc(RELAY)}</code> (see <a href="\${esc(REPO)}">the repo</a>).</p>
          </details></div>\`)}
        \${step(4, "Start collaborating", \`
          <ul class="examples">
            <li><b>Borrow a tool</b><span>Ask your assistant for what you need: <q>“Ask Tarush to export the Onboarding frame from Figma.”</q></span></li>
            <li><b>Approve a request</b><span>When a teammate needs one of your tools, choose Approve or Deny in the overlay or the system dialog.</span></li>
            <li><b>Send a message</b><span><q>“Tell Abhi I’m changing the login page.”</q> In Codex or Cursor, ask <q>“Check my mesh inbox”</q> to read replies.</span></li>
          </ul>\`)}
        </ol></section>

        <aside class="side">
          <section class="card pad invite" aria-labelledby="invite-title">
            <div class="card-head"><h2 id="invite-title">Invite your team</h2></div>
            <div class="linkbox" id="link">\${esc(LINK)}</div>
            <div class="invite-actions">\${copyBtn(LINK, "Copy link", "primary")}</div>
            <p class="small muted note">Anyone with this link can join. Share it only with your team.</p>
            \${OWNER ? '<div class="owner"><button class="ghost danger" id="endbtn" type="button">' + END_LABEL + '</button><p class="small muted">You started this session, so only you can end it.</p><p class="small" id="endwarn" style="color:var(--err)" hidden>Everyone is disconnected and this link stops working.</p><p class="err" id="enderr" role="alert"></p></div>' : ""}
          </section>
          <section class="card pad people" aria-labelledby="people-title">
            <div class="card-head"><h2 id="people-title">Teammates</h2><span id="watchers" class="pill"></span></div>
            <ul id="members" class="members"></ul>
            <p class="legend" id="legend" hidden><span><i style="background:var(--amber)"></i>Asks first</span><span><i style="background:var(--green)"></i>Runs without asking</span><span><i style="background:var(--red)"></i>Not allowed</span></p>
            <div class="popout"><div><b>Approvals window</b><p>Keeps requests and messages on top of your other windows. Needs mesh running on this computer.</p></div>
              <button class="ghost" id="popout" type="button" title="Open an always-on-top window for approvals and messages">Pop out overlay</button></div>
          </section>
        </aside>

        <section class="card pad activity" aria-labelledby="feed-title">
          <div class="card-head"><h2 id="feed-title">Room activity</h2><span class="small muted">Requests, approvals, messages, and results</span></div>
          <div id="feed" class="feed" role="log" aria-live="polite" aria-relevant="additions"><p class="feed-empty">Nothing yet. When an assistant in this room asks for something, it shows up here.</p></div>
        </section>
      </div>\`;
    const dl = () => { const q = "?room=" + encodeURIComponent(ROOM) + "&key=" + encodeURIComponent(KEY) + (OWNER ? "&owner=" + encodeURIComponent(OWNER) : "") + (me ?"&as=" + encodeURIComponent(me) : ""); const a = $("#dl-cmd"), b = $("#dl-command"); if (a) a.href = "/join.cmd" + q; if (b) b.href = "/join.command" + q; };
    dl();
    $("#me").oninput = (e) => { me = e.target.value.trim().toLowerCase().replace(/[^a-z0-9_-]/g, ""); lsSet("mesh.user", me); dl(); renderJoin(); updateSteps(); renderMembers(true); };
    document.querySelectorAll(".tabs button").forEach((b) => { b.onclick = () => { shell = b.dataset.sh; lsSet("mesh.shell", shell); renderJoin(); }; });
    for (const n of [1, 2, 3, 4]) {
      const t = $("#s" + n + "-toggle");
      if (t) t.onclick = () => { touched.add(n); setOpen(n, t.getAttribute("aria-expanded") !== "true"); };
    }
    renderJoin();
    updateSteps();
    const po = $("#popout"); if (po) po.onclick = popOutOverlay;
    const eb = $("#endbtn"); if (eb) eb.onclick = () => endSession(eb);
  };

  // Teammates: who is connected now, plus anyone seen earlier on this page who has since left.
  const known = new Map(); // user → { offers, on, left }
  let membersSig = "";
  const PERM = { always: "Runs without asking", ask: "Asks first", never: "Not allowed" };
  const offerPill = (o) => '<span class="offer ' + esc(o.permission || "") + '" title="' + esc(PERM[o.permission] || o.permission || "") + '">' + esc(o.name) + '</span>';
  function renderMembers(force) {
    const mem = $("#members"); if (!mem) return;
    const list = Array.from(known.entries()).map(([user, v]) => ({ user, ...v }))
      .sort((a, b) => (b.on - a.on) || ((b.user === me) - (a.user === me)) || a.user.localeCompare(b.user));
    const sig = JSON.stringify([me, list]);
    if (!force && sig === membersSig) return;
    membersSig = sig;
    const open = new Set(Array.from(mem.querySelectorAll("details[open]")).map((d) => d.dataset.user));
    mem.innerHTML = list.length ? list.map((m) => {
      const offers = m.offers || [];
      const tools = offers.length
        ? '<details data-user="' + esc(m.user) + '"' + (open.has(m.user) ? " open" : "") + '><summary>' + offers.length + (offers.length === 1 ? " tool" : " tools") + ' shared</summary><div class="offers">' + offers.map(offerPill).join("") + '</div></details>'
        : '<span class="muted">No tools shared</span>';
      return '<li class="m ' + (m.on ? "on" : "off") + '"><span class="avatar" aria-hidden="true">' + esc(m.user.slice(0, 1)) + '<i></i></span>' +
        '<div class="m-top"><b class="m-name">' + esc(m.user) + '</b>' + (m.user === me ? '<span class="you">You</span>' : "") +
        '<span class="m-state">' + (m.on ? "Online" : "Left " + esc(m.left || "")) + '</span></div>' +
        '<div class="m-tools">' + tools + '</div></li>';
    }).join("")
      : '<li class="empty"><b>No teammates are connected yet.</b><span>Finish step 2 to join, then send the invite link to your team.</span></li>';
    const lg = $("#legend"); if (lg) lg.hidden = !list.some((m) => (m.offers || []).length);
  }

  render();
  renderMembers(true);

  // "Pop out overlay": Document Picture-in-Picture (Chrome/Edge 116+, always-on-top) with a plain popup fallback.
  // Daemon port lives in localStorage mesh.port (default 7337); the overlay footer can change it.
  let pipWin = null;
  async function popOutOverlay() {
    const port = Number(lsGet("mesh.port")) || 7337;
    // The overlay page is public HTML but every API call it makes carries the key — hand it over in the fragment.
    const q = "?room=" + encodeURIComponent(ROOM) + "&port=" + port + "#k=" + KEY;
    if (pipWin && !pipWin.closed) { try { pipWin.close(); } catch {} pipWin = null; }
    const fallback = () => { window.open("/overlay" + q, "mesh-overlay", "popup,width=380,height=560"); };
    if (!window.documentPictureInPicture || typeof documentPictureInPicture.requestWindow !== "function") { fallback(); return; }
    let pip;
    try { pip = await documentPictureInPicture.requestWindow({ width: 360, height: 520 }); }
    catch (e) { console.warn("mesh: PiP unavailable, using a popup:", e); fallback(); return; }
    pipWin = pip;
    const d = pip.document;
    try { d.title = "mesh · " + ROOM; } catch {}
    // A <script src> element appended to the PiP document executes there (innerHTML-inserted scripts never do).
    const s = d.createElement("script");
    s.src = location.origin + "/overlay.js";
    s.onload = () => {
      const api = pip.meshOverlay || window.meshOverlay;
      if (api) api.mountOverlay(d, { room: ROOM, port, relayOrigin: location.origin, key: KEY });
      else { try { pip.close(); } catch {} fallback(); }
    };
    s.onerror = () => { try { pip.close(); } catch {} fallback(); };
    d.head.appendChild(s);
    pip.addEventListener("pagehide", () => { if (pipWin === pip) pipWin = null; });
  }

  const seen = new Set(); let next = 0; let shown = 0;
  const fmtT = (ts) => { try { return new Date(ts).toTimeString().slice(0, 8); } catch { return ""; } };
  // artifact chips (docs/FILES-API.md): name · size → relay file URL (http(s) only; anything else is unlinked)
  const fmtSize = (n) => { n = Number(n) || 0; return n < 1024 ? n + " B" : n < 1048576 ? Math.round(n / 1024) + " KB" : (n / 1048576).toFixed(1).replace(/\\.0$/, "") + " MB"; };
  const chip = (a) => {
    if (!a || typeof a !== "object") return "";
    const label = esc(a.name || a.id || "file") + ' <span class="sz">· ' + esc(fmtSize(a.size)) + '</span>';
    const url = typeof a.url === "string" && /^https?:\\/\\//i.test(a.url) ? keyed(a.url, KEY) : "";
    return url ? '<a class="chip" href="' + esc(url) + '" target="_blank" rel="noopener" title="' + esc(a.mime || "") + '">' + label + '</a>' : '<span class="chip">' + label + '</span>';
  };
  const chips = (list) => Array.isArray(list) && list.length ? '<span class="chips">' + list.map(chip).join("") + '</span>' : "";
  const KIND = { prompt: "prompt", tool_call: "tool", file_touched: "file", status: "status", note: "note" };
  // One feed row: time · who · what. Returns the row's inner HTML, or null for frames the feed skips.
  const line = (f) => {
    const row = (body) => '<span class="t">' + fmtT(f.ts) + '</span><span class="u">' + esc(f.from || "") + '</span><span class="b">' + body + '</span>';
    if (f.type === "event" && f.kind === "message") return row('<span class="ok">→ ' + esc((f.data && f.data.to) || "all") + '</span>  ' + esc((f.data && f.data.text) || f.summary));
    if (f.type === "event" && f.kind === "file") {
      const art = f.data && f.data.artifact;
      const note = (f.data && f.data.note) || f.summary || ("sent " + ((art && art.name) || "a file"));
      return row('<span class="ok">file → ' + esc((f.data && f.data.to) || "all") + '</span>  ' + esc(note) + chips(art ? [art] : []));
    }
    if (f.type === "event") return row('<span class="k">' + esc(KIND[f.kind] || f.kind) + '</span>  ' + esc(f.summary));
    if (f.type === "request") return row('<span class="req">asks ' + esc(f.to) + ':  ' + esc(f.command ? "$ " + f.command : f.tool + " " + JSON.stringify(f.args || {})) + '</span>' + (f.why ? '<span class="why">why: ' + esc(f.why) + '</span>' : ""));
    if (f.type === "decision") return row(f.decision === "denied" ? '<span class="no">✕ denied' + (f.reason ? " (" + esc(f.reason) + ")" : "") + '</span>' : f.decision === "auto" ? '<span class="ok">✓ approved automatically</span>' : '<span class="ok">✓ approved</span>');
    if (f.type === "output") return '<span class="b out">' + esc(String(f.chunk == null ? "" : f.chunk).slice(0, 400)) + '</span>';
    if (f.type === "result") return row((f.exitCode === 0 ? '<span class="ok">✓ done, exit 0' : '<span class="no">✕ failed, exit ' + esc(f.exitCode)) + ' in ' + ((Number(f.durationMs) || 0) / 1000).toFixed(1) + 's' + (f.timedOut ? " (timed out)" : "") + '</span>' + chips(f.artifacts));
    return null;
  };
  async function poll() {
    if (ended) return;
    try {
      const res = await fetch("/api/rooms/" + ROOM + "?since=" + next + "&key=" + encodeURIComponent(KEY));
      if (ended) return;
      if (res.status === 410) { showEnded(); return; } // ended by its owner: stop polling for good
      if (res.status === 401) { // the key stopped working (relay restarted without ROOM_SECRET, or a stale one was remembered)
        lsSet("mesh.key." + ROOM, "");
        setStatus("off", "Link expired");
        $("#app").innerHTML = notice(ICON.link, "This room needs a new link",
          '<p>The saved link no longer works. Ask your teammate to share the current room link.</p>',
          '<div class="actions"><a class="btn" href="/r/' + esc(ROOM) + '">Reload and paste it</a></div>');
        return;
      }
      const r = await res.json();
      next = r.next || 0;
      setStatus("live", "Live");
      const now = new Set((r.members || []).map((m) => m.user));
      for (const m of r.members || []) known.set(m.user, { offers: m.offers || [], on: true, left: "" });
      for (const [user, v] of known) if (v.on && !now.has(user)) known.set(user, { ...v, on: false, left: fmtT(Date.now()).slice(0, 5) });
      const wasOnline = meOnline;
      meOnline = !!me && now.has(me);
      if (meOnline !== wasOnline) updateSteps();
      renderMembers(false);
      const w = $("#watchers"); if (w) w.textContent = r.watchers ? r.watchers + " watching" : "";
      const feed = $("#feed");
      const fresh = [];
      for (const f of r.events || []) { if (seen.has(f.i)) continue; seen.add(f.i); const l = line(f); if (l) fresh.push(f.type === "output" ? '<div class="ev out">' + l + '</div>' : '<div class="ev">' + l + '</div>'); }
      if (feed && fresh.length) {
        const atBottom = !shown || feed.scrollHeight - feed.scrollTop - feed.clientHeight < 40;
        if (!shown) feed.innerHTML = "";
        feed.insertAdjacentHTML("beforeend", fresh.join(""));
        shown += fresh.length;
        while (shown > 200 && feed.firstElementChild) { feed.firstElementChild.remove(); shown--; }
        if (atBottom) feed.scrollTop = feed.scrollHeight;
      }
    } catch { if (!ended) setStatus("warn", "Reconnecting…"); }
    if (!ended) setTimeout(poll, 2000);
  }
  poll();
}
</script></body></html>`;
}
