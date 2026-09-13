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
    --accent:#0071e3;--accent-text:#0066cc;--green:#1f9d3a;--amber:#b25f00;--red:#d70015;--glass:rgba(255,255,255,.72);
    --shadow:0 1px 2px rgba(0,0,0,.04),0 8px 24px -8px rgba(0,0,0,.08);
    --term:#0b0b0d;--term-text:#e4e4e7;--term-dim:#8a8a93;
    --fg:var(--label);--dim:var(--label-2);--acc:var(--green);--warn:var(--amber);--err:var(--red);--link:var(--accent-text);--line:var(--sep-2);
    --font:-apple-system,BlinkMacSystemFont,"SF Pro Text","SF Pro Display",Inter,"Helvetica Neue","Segoe UI",system-ui,sans-serif;
    --mono:ui-monospace,"SF Mono",SFMono-Regular,Menlo,Consolas,monospace}
  @media (prefers-color-scheme:dark){:root{--bg:#000;--grouped:#0d0d0f;--surface:#161618;--surface-2:#1c1c1e;--label:#f5f5f7;--label-2:#a1a1a6;--label-3:#8e8e93;
    --sep:rgba(255,255,255,.1);--sep-2:rgba(255,255,255,.18);--fill:rgba(255,255,255,.06);--fill-2:rgba(255,255,255,.1);
    --accent:#0a84ff;--accent-text:#409cff;--green:#30d158;--amber:#ffb340;--red:#ff6961;--glass:rgba(22,22,24,.72);
    --shadow:0 1px 2px rgba(0,0,0,.4),0 8px 24px -8px rgba(0,0,0,.6)}}
  *{box-sizing:border-box}[hidden]{display:none!important}
  body{margin:0;background:var(--grouped);color:var(--label);font:15px/1.55 var(--font);letter-spacing:-.01em;-webkit-font-smoothing:antialiased}
  :focus-visible{outline:3px solid color-mix(in srgb,var(--accent) 55%,transparent);outline-offset:2px;border-radius:8px}
  a{color:var(--link);text-decoration:none}a:hover{text-decoration:underline}
  code{font:.92em var(--mono);padding:1px 5px;border-radius:6px;background:var(--fill)}
  /* functional layer: the only glass */
  .nav{position:sticky;top:0;z-index:10;background:var(--glass);-webkit-backdrop-filter:saturate(180%) blur(20px);backdrop-filter:saturate(180%) blur(20px);border-bottom:1px solid var(--sep)}
  @media (prefers-reduced-transparency:reduce){.nav{background:var(--bg);-webkit-backdrop-filter:none;backdrop-filter:none}}
  .nav-inner{max-width:880px;margin:0 auto;padding:0 20px;height:52px;display:flex;align-items:center;gap:10px}
  .brand{display:flex;align-items:center;gap:10px;color:var(--label);font-weight:600;font-size:19px;letter-spacing:-.02em}.brand:hover{text-decoration:none}
  .brand-mark{width:26px;height:26px;border-radius:7px;display:grid;place-items:center;background:var(--label);color:var(--bg)}.brand-mark svg{width:16px;height:16px}
  .badge{font-size:12px;font-weight:500;color:var(--label-2);padding:2px 9px;border-radius:999px;background:var(--fill);border:1px solid var(--sep);font-family:var(--mono);letter-spacing:0}
  main{max-width:880px;margin:0 auto;padding:8px 20px 96px}
  @media (max-width:480px){main,.nav-inner{padding-left:16px;padding-right:16px}}
  .hero{text-align:center;padding:64px 0 40px}
  .hero.compact{text-align:left;padding:36px 0 12px}
  .eyebrow{font-size:14px;font-weight:600;color:var(--accent-text);margin:0 0 10px}
  h1{margin:0;font-size:clamp(38px,6vw,60px);line-height:1.05;font-weight:700;letter-spacing:-.035em}
  .hero.compact h1{font-size:clamp(28px,4.4vw,40px)}
  .tag{font-size:clamp(17px,2vw,21px);line-height:1.45;color:var(--label-2);margin:16px auto 0;max-width:600px;letter-spacing:-.015em}
  .hero.compact .tag{margin-left:0;font-size:17px}
  /* content cards: opaque, no glass */
  .card{background:var(--surface);border:1px solid var(--sep);border-radius:22px;box-shadow:var(--shadow);padding:24px 26px;margin:16px 0}
  @media (max-width:480px){.card{padding:20px 18px;border-radius:18px}}
  .card h2{font-size:19px;font-weight:600;margin:0 0 12px;color:var(--label);letter-spacing:-.02em}
  .card h2::first-letter{text-transform:uppercase}
  .card p{margin:10px 0}
  .room-head,.section-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
  .room-head h2,.section-head h2{margin:0}
  .section-head{justify-content:space-between}
  .room-note,.section-note{color:var(--label-2);font-size:13px}
  .room-note{margin-bottom:0!important}
  .step-card h2{display:flex;align-items:center;gap:10px;margin-bottom:14px}
  .step-num{display:inline-grid;place-items:center;flex:0 0 auto;width:28px;height:28px;border-radius:50%;background:var(--label);color:var(--bg);font:600 13px/1 var(--font);letter-spacing:0}
  .step-lede{color:var(--label-2);font-size:14px;margin-top:-4px!important}
  .field-row{display:flex;align-items:center;gap:14px;flex-wrap:wrap}
  .field-row label{font-weight:600}.field-row input{width:260px}
  .field-help{margin:8px 0 0!important;color:var(--label-2);font-size:13px}
  .platform-row{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
  .platform-help{margin:12px 0 8px!important}
  .success-note{margin:12px 0 0!important;font-size:13px}
  .success-note code{white-space:nowrap}
  .check-note{margin:14px 0;padding:12px 14px;border:1px solid var(--sep);border-radius:12px;background:var(--surface-2);font-size:14px}
  .check-note p{margin:3px 0 0}
  .use-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}
  .use-item{padding:14px;border:1px solid var(--sep);border-radius:14px;background:var(--surface-2)}
  .use-item b{display:block;margin-bottom:5px;font-size:14px}
  .use-item p{margin:0;color:var(--label-2);font-size:13px}
  @media(max-width:680px){.use-grid{grid-template-columns:1fr}.section-head{align-items:flex-start}.field-row input{width:min(100%,320px)}}
  button,.btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:44px;background:var(--accent);color:#fff;border:0;border-radius:999px;padding:0 22px;font:500 15px/1 var(--font);letter-spacing:-.01em;cursor:pointer;transition:background-color .15s,transform .15s}
  button:hover,.btn:hover{background:color-mix(in srgb,var(--accent) 88%,#000);text-decoration:none}
  button:active{transform:scale(.98)}@media (prefers-reduced-motion:reduce){button:active{transform:none}}
  button.ghost{min-height:32px;background:var(--fill);color:var(--accent-text);border:1px solid var(--sep);padding:0 14px;font-size:13px}
  button.ghost:hover{background:var(--fill-2)}
  button.ghost.danger{color:var(--red);border-color:color-mix(in srgb,var(--red) 35%,transparent)}
  button:disabled{opacity:.55;cursor:default}
  input{min-height:44px;background:var(--surface);color:var(--label);border:1px solid var(--sep-2);border-radius:12px;padding:10px 14px;font:15px var(--font);width:220px;max-width:100%}
  input::placeholder{color:var(--label-3)}input:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--accent) 25%,transparent)}
  label{font-size:14px;font-weight:500;display:inline-flex;align-items:center;gap:10px;flex-wrap:wrap}
  pre{background:var(--term);color:var(--term-text);border-radius:14px;padding:14px 96px 14px 18px;overflow-x:auto;font:13px/1.6 var(--mono);position:relative;margin:10px 0;white-space:pre-wrap;word-break:break-all}
  pre .copy{position:absolute;top:9px;right:9px;background:rgba(255,255,255,.1);color:#fff;border-color:rgba(255,255,255,.16)}
  pre .copy:hover{background:rgba(255,255,255,.18)}
  .row{display:flex;gap:12px;align-items:center;flex-wrap:wrap}
  .members{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:12px}
  #members>.dim{grid-column:1/-1}
  .m{background:var(--surface-2);border:1px solid var(--sep);border-radius:14px;padding:14px 16px}.m b{font-size:16px;font-weight:600}
  .m .on{color:var(--green);font-size:13px}.m .off{color:var(--label-3)}
  .offer{display:inline-block;margin:6px 6px 0 0;padding:2px 9px;border-radius:999px;font:12px/1.5 var(--mono);color:var(--label-2);background:var(--fill)}
  .offer.always{color:var(--green);background:color-mix(in srgb,var(--green) 12%,transparent)}
  .offer.ask{color:var(--amber);background:color-mix(in srgb,var(--amber) 12%,transparent)}
  .offer.never{color:var(--red);background:color-mix(in srgb,var(--red) 12%,transparent)}
  /* live feed: a terminal in both themes, so its colors are fixed */
  .feed{background:var(--term);color:var(--term-text);border-radius:14px;padding:12px 16px;font:12.5px/1.6 var(--mono);max-height:420px;overflow:auto}
  .feed>span.dim{color:var(--term-dim)}
  .feed div{white-space:pre-wrap;border-bottom:1px solid rgba(255,255,255,.06);padding:4px 0}.feed div:last-child{border-bottom:0}
  .feed .t{color:var(--term-dim)}.feed .u{color:#7cc4ff}.feed .req{color:#fbbf24}.feed .ok{color:#4ade80}.feed .no{color:#fb7185}.feed .out{color:var(--term-dim);padding-left:26px}
  .feed .chip{border-color:rgba(255,255,255,.16);background:rgba(255,255,255,.08);color:#7cc4ff}.feed .chip .sz{color:var(--term-dim)}
  .dim{color:var(--label-2)}.small{font-size:13px}
  ul.small{padding-left:20px}ul.small li{margin:8px 0}
  ol.steps{padding-left:22px;margin:4px 0}ol.steps li{margin:14px 0;color:var(--label-2)}ol.steps li>b{display:block;margin-bottom:2px;color:var(--label);font-weight:600}
  .pill:empty{display:none}
  .pill{display:inline-block;padding:2px 10px;border-radius:999px;background:var(--fill);border:1px solid var(--sep);color:var(--label-2);font:500 12px/1.6 var(--mono)}
  .tabs{display:inline-flex;gap:0;padding:2px;border-radius:9px;background:var(--fill-2);margin:0 0 4px}
  .tabs button.ghost{min-height:28px;border:0;border-radius:7px;background:transparent;color:var(--label);padding:0 12px}
  .tabs button.ghost.on{background:var(--surface);box-shadow:0 1px 3px rgba(0,0,0,.12),0 0 0 .5px rgba(0,0,0,.04)}
  details{margin:12px 0 0}summary{cursor:pointer;color:var(--accent-text);font-size:13px}details[open] summary{margin-bottom:6px}
  .chip{display:inline-block;margin:2px 4px 0 0;padding:1px 9px;border-radius:999px;border:1px solid var(--sep-2);background:var(--fill);color:var(--link);font:12px/1.5 var(--font);text-decoration:none;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;vertical-align:middle}
  .chip:hover{border-color:var(--link)}.chip .sz{color:var(--label-2)}.chips{display:block;margin-top:2px}
</style></head><body>
<header class="nav"><div class="nav-inner">
  <a class="brand" href="/" aria-label="mesh home"><span class="brand-mark" aria-hidden="true"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="3.5" cy="4" r="2"/><circle cx="12.5" cy="4" r="2"/><circle cx="8" cy="12.5" r="2"/><path d="M5.5 4h5M4.6 5.8l2.3 5M11.4 5.8l-2.3 5"/></svg></span>mesh</a>
  ${opts.room ? '<span class="badge">' + opts.room + '</span>' : '<span class="badge">preview</span>'}
</div></header>
<main>
${opts.room
  ? '<section class="hero compact"><p class="eyebrow">Room</p><h1>Get your agent in the room.</h1><p class="tag">Four quick steps. Then your agent can borrow teammates’ tools, with their OK.</p></section>'
  : '<section class="hero"><p class="eyebrow">Think Google Meet, for Claude Code, Codex and Cursor</p><h1>A meeting room<br>for your coding agents.</h1><p class="tag">Everyone’s agents join one room and borrow each other’s tools, with a click to approve. Credentials never move.</p></section>'}
<div id="app"></div>
<script>
const ROOM = ${room};
const REPO = ${JSON.stringify(opts.repoUrl)};
const RELAY = (location.protocol === "https:" ? "wss://" : "ws://") + location.host;
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
function copyBtn(txt){ return '<button class="ghost copy" onclick="navigator.clipboard.writeText(' + JSON.stringify(txt).replace(/"/g,"&quot;") + ');this.textContent=\\'Copied\\';setTimeout(()=>this.textContent=\\'Copy\\',1200)">Copy</button>'; }
function pre(txt){ return '<pre>' + copyBtn(txt) + esc(txt) + '</pre>'; }

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
  $("#app").innerHTML = \`
    <div class="card"><h2>start here</h2>
      <p><b>mesh lets your AI coding assistant use tools your teammates have and you don't.</b> Their Figma, their database, their deploy access. It runs on their laptop, they click Approve, you get the result. Nobody shares a password or a key.</p>
      <div class="row"><button id="start">Start a session</button><span class="dim small">creates a room and gives you a link to send to your teammates</span></div>
    </div>
    <div class="card"><h2>join a room</h2>
      <p class="small">Someone sent you a link? Paste it here.</p>
      <div class="row"><input id="jlink" placeholder="https://…/r/room#k=…" style="width:380px" autocomplete="off"><button class="ghost" id="jgo">Open</button></div>
      <p class="small dim" id="jerr" style="min-height:18px"></p>
      <details><summary>I only have the room name and key</summary>
        <div class="row" style="margin-top:8px"><input id="jroom" placeholder="room" maxlength="42" autocomplete="off"><input id="jkey" placeholder="key" maxlength="32" autocomplete="off"><button class="ghost" id="jgo2">Open</button></div>
      </details>
    </div>
    <div class="card"><h2>what happens, in plain words</h2>
      <ol class="steps">
        <li><b>You make a room and send the link.</b> Anyone with the link can join. The link is the only password, so only send it to your team.</li>
        <li><b>Each person pastes one command</b> in their terminal (or double-clicks a downloaded file). That's the whole install. It takes about 20 seconds and needs only Node.js.</li>
        <li><b>Each person restarts their coding assistant once</b> (Claude Code, Codex, or Cursor). It now knows about the team.</li>
        <li><b>Work like normal.</b> When your assistant needs something a teammate has, it asks them. A small window pops up on their screen: Approve or Deny. If they approve, the result comes back to your assistant. Everyone can watch it happen on the room page.</li>
      </ol>
      <p class="small dim">Nothing runs in the cloud. No accounts. Your keys never leave your computer.</p>
    </div>\`;
  $("#start").onclick = async () => {
    const r = await fetch("/api/rooms", { method: "POST" }).then((x) => x.json());
    // The creator lands on the owner link (#k=<key>&o=<owner>); the room page stores the owner token and scrubs it.
    location.href = "/r/" + r.room + (r.key ? "#k=" + r.key + (r.ownerToken ? "&o=" + r.ownerToken : "") : "");
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
  $("#jgo2").onclick = () => {
    const room = $("#jroom").value.trim().toLowerCase(), key = $("#jkey").value.trim().toLowerCase();
    go(room + (key ? "#k=" + key : ""));
  };
} else if (!KEY) {
  // No key in the fragment and none remembered: this page shows nothing about the room until it has the link.
  $("#app").innerHTML = \`
    <div class="card"><h2>Open room \${esc(ROOM)}</h2>
      <p><b>You'll need the room link.</b> Paste the link your teammate sent you to continue.</p>
      <p class="small dim">It looks like <code>\${esc(location.origin)}/r/\${esc(ROOM)}#k=…</code></p>
      <div class="row"><input id="k" aria-label="Room link" placeholder="Paste the room link" style="width:380px" autocomplete="off"><button id="kgo">Open room</button></div>
      <p class="small dim" id="kerr" style="min-height:18px">Ask whoever started the session to send it to you.</p>
    </div>\`;
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
  let me = localStorage.getItem("mesh.user") || "";
  let shell = localStorage.getItem("mesh.shell") || (navigator.userAgent.includes("Windows") ? "ps" : "bash");
  const asFlag = () => " --key " + KEY + (OWNER ? " --owner " + OWNER : "") + (me ? " --as " + me : "");
  let ended = false;
  // Polling got 410 or this page ended the session: stop for good and say so.
  const showEnded = (msg) => {
    ended = true;
    lsDel("mesh.owner." + ROOM);
    $("#app").innerHTML = '<div class="card"><h2>Room ' + esc(ROOM) + '</h2><p><b>This session has ended.</b></p>' +
      '<p class="small dim">' + esc(msg || "The person who started it ended it for everyone. Everyone was disconnected and this link no longer works.") + '</p>' +
      '<p><a class="btn" href="/" style="text-decoration:none;display:inline-block">Start a new session</a></p></div>';
  };
  let endArmed = false, endTimer = null;
  const endSession = async (b) => {
    const err = $("#enderr");
    if (!endArmed) {
      endArmed = true; b.textContent = "Click again to end it for everyone — all teammates are disconnected and this link stops working";
      endTimer = setTimeout(() => { endArmed = false; b.textContent = "End session for everyone"; }, 6000);
      return;
    }
    clearTimeout(endTimer); endArmed = false; b.disabled = true; b.textContent = "Ending…";
    try {
      const res = await fetch("/api/rooms/" + encodeURIComponent(ROOM) + "/end?key=" + encodeURIComponent(KEY), {
        method: "POST", headers: { "content-type": "application/json", "x-mesh-owner": OWNER },
        body: JSON.stringify({ by: localStorage.getItem("mesh.user") || undefined }),
      });
      const j = await res.json().catch(() => ({}));
      if (res.ok) { showEnded("You ended the session. Everyone was disconnected and this link no longer works."); return; }
      b.disabled = false; b.textContent = "End session for everyone";
      if (err) err.textContent = (j && j.error) || ("could not end the session (HTTP " + res.status + ")");
    } catch (e) {
      b.disabled = false; b.textContent = "End session for everyone";
      if (err) err.textContent = "could not reach the relay";
    }
  };
  const joinCmd = (sh) => sh === "ps"
    ? "& ([scriptblock]::Create((irm -Headers @{'ngrok-skip-browser-warning'='1'} " + location.origin + "/install.ps1))) " + ROOM + asFlag()
    : "curl -fsSL " + location.origin + "/install.sh | bash -s -- " + ROOM + asFlag();
  const renderJoin = () => {
    const el = $("#join"); if (!el) return;
    const cmd = joinCmd(shell);
    el.innerHTML = copyBtn(cmd) + esc(cmd);
    document.querySelectorAll(".tabs button").forEach((b) => b.classList.toggle("on", b.dataset.sh === shell));
    const help = $("#platform-help");
    if (help) help.innerHTML = shell === "ps"
      ? 'Open PowerShell in your project folder, paste the command, and press Enter.'
      : 'Open Terminal in your project folder, paste the command, and press Enter.';
  };
  const render = () => {
    $("#app").innerHTML = \`
      <div class="card"><div class="room-head"><h2>Share this room</h2><span class="pill">\${esc(ROOM)}</span></div>
        <pre id="link">\${copyBtn(LINK)}\${esc(LINK)}</pre>
        <p class="room-note">Anyone with this link can join. Share it only with your team.</p>
        \${OWNER ? '<div class="row" style="margin-top:6px"><button class="ghost danger" id="endbtn">End session for everyone</button><span class="dim small">You started this session, so only you can end it.</span></div><p class="small" id="enderr" style="color:var(--err);min-height:0;margin:6px 0 0"></p>' : ""}</div>

      <div class="card step-card"><h2><span class="step-num">1</span>Choose your name</h2>
        <div class="field-row"><label for="me">Your name</label><input id="me" value="\${esc(me)}" placeholder="e.g. tarush" maxlength="32" autocomplete="off"></div>
        <p class="field-help">Use a short lowercase name with no spaces. Teammates' assistants will use it to find you.</p></div>

      <div class="card step-card"><h2><span class="step-num">2</span>Install mesh</h2>
        <p class="step-lede">One command, about 20 seconds. Requires <a href="https://nodejs.org" target="_blank" rel="noopener">Node.js 20 or newer</a>.</p>
        <div class="platform-row"><span class="tabs" aria-label="Choose your operating system"><button class="ghost" data-sh="bash">macOS / Linux</button><button class="ghost" data-sh="ps">Windows</button></span></div>
        <p class="small platform-help" id="platform-help"></p>
        <pre id="join"></pre>
        <p class="success-note">When you see <code>● mesh running in the background</code>, your name will appear under Teammates below. You can close the terminal.</p>
        <details><summary>Use a downloadable file instead</summary>
          <p class="small"><b>Windows:</b> download <a id="dl-cmd" href="#">mesh-join-\${esc(ROOM)}.cmd</a> and double-click it. <b>macOS:</b> download <a id="dl-command" href="#">mesh-join-\${esc(ROOM)}.command</a>, then right-click and choose Open.</p></details>
        <details><summary>What does this command do?</summary>
          <p class="small dim">It downloads mesh to your home folder, starts it in the background, and connects this room to your coding assistant. Your existing MCP tools are shared with permission set to "ask," so you approve requests before they run. To check its status, run <code>node ~/.mesh/mesh.mjs status</code>. To leave, run <code>node ~/.mesh/mesh.mjs stop</code>.</p></details></div>

      <div class="card step-card"><h2><span class="step-num">3</span>Restart your coding assistant</h2>
        <p class="small">Open a new Claude Code, Codex, or Cursor session in the same project folder so it can discover mesh.</p>
        <div class="check-note"><b>Check the connection</b><p>Ask your assistant, <i>"List my mesh teammates."</i> It should name the people shown below. If it cannot find mesh, open Manual setup.</p></div>
        <details><summary>Manual setup (if the check fails)</summary>
        <p class="small">Claude Code, in a terminal in your project folder:</p>
        \${pre("claude mcp add --transport http mesh http://localhost:7337/mcp")}
        <p class="small">Codex CLI, in any terminal:</p>
        \${pre("codex mcp add mesh --url http://localhost:7337/mcp")}
        <p class="small">Cursor: create a file called <code>.cursor/mcp.json</code> in your project with this content, then restart Cursor:</p>
        \${pre('{ "mcpServers": { "mesh": { "url": "http://localhost:7337/mcp" } } }')}
        <p class="small dim">Developers of mesh itself can run from the repo instead: <code>pnpm -F daemon start join \${esc(ROOM)} --key \${esc(KEY)}\${OWNER ? " --owner " + esc(OWNER) : ""} --as &lt;you&gt; --relay \${esc(RELAY)}</code> (see <a href="\${esc(REPO)}">the repo</a>).</p>
        </details></div>

      <div class="card step-card"><h2><span class="step-num">4</span>Start collaborating</h2>
        <div class="use-grid">
          <div class="use-item"><b>Borrow a tool</b><p>Ask your assistant for what you need. For example: <i>"Ask Tarush to export the Onboarding frame from Figma."</i></p></div>
          <div class="use-item"><b>Approve a request</b><p>When a teammate needs your tools, review the request in the overlay or system dialog, then choose Approve or Deny.</p></div>
          <div class="use-item"><b>Send a message</b><p>Try <i>"Tell Abhi I'm changing the login page."</i> In Codex or Cursor, ask <i>"Check my mesh inbox"</i> to read replies.</p></div>
        </div></div>

      <div class="card"><div class="section-head"><h2>Teammates <span id="watchers" class="pill" style="text-transform:none"></span></h2>
        <button class="ghost" id="popout" title="Open an always-on-top window for approvals and messages">Pop out overlay</button></div>
        <p class="section-note">Keep approvals and messages visible in a floating window. Mesh must be running on this machine.</p>
        <div id="members" class="members"><span class="dim">No teammates are connected yet. Complete Step 2 to join.</span></div></div>
      <div class="card"><div class="section-head"><h2>Room activity</h2></div>
        <p class="section-note">Requests, decisions, messages, and results from this room appear here.</p>
        <div id="feed" class="feed"><span class="dim">Waiting for room activity.</span></div></div>\`;
    const dl = () => { const q = "?room=" + encodeURIComponent(ROOM) + "&key=" + encodeURIComponent(KEY) + (OWNER ? "&owner=" + encodeURIComponent(OWNER) : "") + (me ?"&as=" + encodeURIComponent(me) : ""); const a = $("#dl-cmd"), b = $("#dl-command"); if (a) a.href = "/join.cmd" + q; if (b) b.href = "/join.command" + q; };
    dl();
    $("#me").oninput = (e) => { me = e.target.value.trim().toLowerCase().replace(/[^a-z0-9_-]/g, ""); localStorage.setItem("mesh.user", me); dl(); renderJoin(); };
    document.querySelectorAll(".tabs button").forEach((b) => { b.onclick = () => { shell = b.dataset.sh; localStorage.setItem("mesh.shell", shell); renderJoin(); }; });
    renderJoin();
    const po = $("#popout"); if (po) po.onclick = popOutOverlay;
    const eb = $("#endbtn"); if (eb) eb.onclick = () => endSession(eb);
  };
  render();

  // "Pop out overlay": Document Picture-in-Picture (Chrome/Edge 116+, always-on-top) with a plain popup fallback.
  // Daemon port lives in localStorage mesh.port (default 7337); the overlay footer can change it.
  let pipWin = null;
  async function popOutOverlay() {
    const port = Number(localStorage.getItem("mesh.port")) || 7337;
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

  const seen = new Set(); let next = 0; const lines = [];
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
  const line = (f) => {
    const t = '<span class="t">' + fmtT(f.ts) + '</span> ';
    const u = '<span class="u">' + esc(f.from || "") + '</span> ';
    if (f.type === "event" && f.kind === "message") return t + u + '<span class="ok">✉ → ' + esc((f.data && f.data.to) || "all") + '</span>: ' + esc((f.data && f.data.text) || f.summary);
    if (f.type === "event" && f.kind === "file") {
      const art = f.data && f.data.artifact;
      const note = (f.data && f.data.note) || f.summary || ("sent " + ((art && art.name) || "a file"));
      return t + u + '<span class="ok">📎 → ' + esc((f.data && f.data.to) || "all") + '</span>: ' + esc(note) + chips(art ? [art] : []);
    }
    if (f.type === "event") return t + u + ({prompt:"💬",tool_call:"🔧",file_touched:"📁",status:"⏸",note:"📝"}[f.kind] || "•") + ' ' + esc(f.kind) + ': ' + esc(f.summary);
    if (f.type === "request") return t + u + '<span class="req">──▶ ' + esc(f.to) + '  ' + esc(f.command ? "$ " + f.command : f.tool + " " + JSON.stringify(f.args || {})) + '</span>  <span class="t">why: ' + esc(f.why) + '</span>';
    if (f.type === "decision") return t + u + (f.decision === "denied" ? '<span class="no">❌ denied' + (f.reason ? " (" + esc(f.reason) + ")" : "") + '</span>' : f.decision === "auto" ? '<span class="ok">⚡ auto-approved</span>' : '<span class="ok">✅ approved</span>');
    if (f.type === "output") return '<span class="out">' + esc(f.chunk).slice(0, 400) + '</span>';
    if (f.type === "result") return t + u + (f.exitCode === 0 ? '<span class="ok">✔ exit 0' : '<span class="no">✘ exit ' + esc(f.exitCode)) + ' in ' + (f.durationMs / 1000).toFixed(1) + 's' + (f.timedOut ? " (timed out)" : "") + '</span>' + chips(f.artifacts);
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
        $("#app").innerHTML = '<div class="card"><h2>Room ' + esc(ROOM) + '</h2><p><b>This room needs a new link.</b> The saved link no longer works. Ask your teammate to share the current room link.</p><p class="small"><a href="/r/' + esc(ROOM) + '">Reload and paste it</a></p></div>';
        return;
      }
      const r = await res.json();
      next = r.next || 0;
      const mem = $("#members");
      if (mem) mem.innerHTML = r.members.length ? r.members.map((m) => '<div class="m"><b>' + esc(m.user) + '</b> <span class="on">● Online</span><div>' +
        (m.offers.length ? m.offers.map((o) => '<span class="offer ' + esc(o.permission || "") + '" title="' + esc(o.permission || "") + '">' + esc(o.name) + '</span>').join("") : '<span class="dim small">No tools shared</span>') + '</div></div>').join("")
        : '<span class="dim">No teammates are connected yet. Complete Step 2 to join.</span>';
      const w = $("#watchers"); if (w) w.textContent = r.watchers ? r.watchers + " watching" : "";
      for (const f of r.events || []) { if (seen.has(f.i)) continue; seen.add(f.i); const l = line(f); if (l) lines.push(l); }
      const feed = $("#feed");
      if (feed && lines.length) { feed.innerHTML = lines.slice(-200).map((l) => "<div>" + l + "</div>").join(""); feed.scrollTop = feed.scrollHeight; }
    } catch {}
    if (!ended) setTimeout(poll, 2000);
  }
  poll();
}
</script></main></body></html>`;
}
