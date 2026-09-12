/**
 * Web front door for the relay: a landing page that starts a session, a room page that shows
 * who's connected + a live feed, and two JSON routes the pages poll. Same port as the WebSocket.
 *
 *   GET  /                 landing: "Start a session"
 *   POST /api/rooms        → { room }            create a room name
 *   GET  /api/rooms/:room  → { room, members, events }   live state (polled every 2 s)
 *   GET  /r/:room          room page
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

export interface WebRoomView {
  members: Array<{ user: string; role: string; offers: Array<{ name: string; kind?: string; permission?: string }> }>;
  history: string[]; // raw JSON frames, oldest first
}

/** Static files loaded at relay start (index.ts); undefined = missing on disk, routes answer 503 with a hint. */
export interface WebAssets {
  meshMjs?: Buffer;
  emitJs?: Buffer;
}

export interface WebDeps {
  getRoom(name: string): WebRoomView | undefined;
  createRoom(name: string): void;
  repoUrl: string;
  assets: WebAssets;
}

const ROOM_RE = /^[a-z0-9][a-z0-9-]{1,40}$/;
const WORDS = ["otter", "maple", "comet", "ember", "delta", "pixel", "quartz", "sonic", "tango", "vapor", "willow", "zephyr"];

function newRoomName(): string {
  const w = WORDS[randomBytes(1)[0]! % WORDS.length];
  return `${w}-${randomBytes(2).toString("hex")}`;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", "access-control-allow-origin": "*" });
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

  if (method === "GET" && pathname === "/mesh.mjs") {
    asset(res, deps.assets.meshMjs, "mesh.mjs is not built on this relay: run `pnpm -F daemon bundle` and restart the relay", "text/javascript; charset=utf-8");
    return true;
  }
  if (method === "GET" && pathname === "/emit.js") {
    asset(res, deps.assets.emitJs, "emit.js is missing on this relay (expected hooks/emit.js or apps/relay/public/emit.js)", "text/javascript; charset=utf-8");
    return true;
  }
  if (method === "GET" && pathname === "/install.sh") { text(res, 200, installSh(publicOrigin(req)), "text/x-shellscript; charset=utf-8"); return true; }
  if (method === "GET" && pathname === "/install.ps1") { text(res, 200, installPs1(publicOrigin(req)), "text/plain; charset=utf-8"); return true; }

  if (method === "POST" && pathname === "/api/rooms") {
    let name = newRoomName();
    for (let i = 0; i < 5 && deps.getRoom(name); i++) name = newRoomName();
    deps.createRoom(name);
    json(res, 201, { room: name });
    return true;
  }

  let m = pathname.match(/^\/api\/rooms\/([^/]+)$/);
  if (method === "GET" && m) {
    const name = decodeURIComponent(m[1]!);
    if (!ROOM_RE.test(name)) { json(res, 400, { error: "bad room name" }); return true; }
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
    const asArg = as ? ` --as ${as}` : "";
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
  echo "mesh: joining room '$ROOM' via $RELAY in the background (approvals pop up as system dialogs)"
  node "$MESH_HOME/mesh.mjs" join "$ROOM" --relay "$RELAY" --background "$@"
  rc=$?
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

Write-Host "mesh: joining room '$Room' via $Relay in the background (approvals pop up as dialogs)"
& node (Join-Path $MeshHome "mesh.mjs") join $Room --relay $Relay --background @Rest
Write-Host "mesh: done. Restart your coding agent session once so it picks up the mesh tools.  (status: node $env:USERPROFILE\.mesh\mesh.mjs status)"
exit $LASTEXITCODE
`;
}

// ---------- page ----------

function page(opts: { repoUrl: string; room?: string }): string {
  const room = opts.room ? JSON.stringify(opts.room) : "null";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>mesh${opts.room ? " · " + opts.room : ""}</title>
<style>
  :root{--bg:#0b0d10;--panel:#14181d;--line:#232a33;--fg:#e6e9ee;--dim:#8a94a3;--acc:#7ee787;--warn:#f2cc60;--err:#ff7b72;--link:#79c0ff}
  *{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 ui-sans-serif,system-ui,-apple-system,Segoe UI,Inter,sans-serif}
  main{max-width:960px;margin:0 auto;padding:40px 20px 80px}
  h1{font-size:34px;margin:0 0 6px;letter-spacing:-.5px}h1 span{color:var(--dim);font-weight:400}
  .tag{color:var(--dim);margin:0 0 28px}
  .card{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:20px 22px;margin:16px 0}
  .card h2{font-size:15px;margin:0 0 10px;color:var(--dim);text-transform:uppercase;letter-spacing:.08em}
  button,.btn{background:var(--acc);color:#04120a;border:0;border-radius:8px;padding:12px 18px;font-weight:700;font-size:15px;cursor:pointer}
  button.ghost{background:transparent;color:var(--fg);border:1px solid var(--line);font-weight:500;padding:6px 10px;font-size:13px}
  input{background:#0b0d10;color:var(--fg);border:1px solid var(--line);border-radius:8px;padding:10px 12px;font-size:15px;width:220px}
  pre{background:#0b0d10;border:1px solid var(--line);border-radius:8px;padding:12px 14px;overflow-x:auto;font:13.5px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace;position:relative;margin:8px 0}
  pre .copy{position:absolute;top:8px;right:8px}
  .row{display:flex;gap:12px;align-items:center;flex-wrap:wrap}
  .members{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:10px}
  .m{border:1px solid var(--line);border-radius:10px;padding:12px 14px}.m b{font-size:16px}.m .on{color:var(--acc)}.m .off{color:var(--dim)}
  .offer{display:inline-block;margin:3px 6px 0 0;padding:2px 8px;border-radius:999px;border:1px solid var(--line);font:12px ui-monospace,Menlo,monospace;color:var(--dim)}
  .offer.always{border-color:#2d5a3a;color:var(--acc)}.offer.ask{border-color:#5a4d1d;color:var(--warn)}.offer.never{border-color:#5a2a2a;color:var(--err)}
  .feed{font:13px/1.6 ui-monospace,Menlo,monospace;max-height:420px;overflow:auto}
  .feed div{white-space:pre-wrap;border-bottom:1px solid #11151a;padding:3px 0}.feed .t{color:var(--dim)}.feed .u{color:var(--link)}
  .feed .req{color:var(--warn)}.feed .ok{color:var(--acc)}.feed .no{color:var(--err)}.feed .out{color:var(--dim);padding-left:26px}
  a{color:var(--link)}.dim{color:var(--dim)}.small{font-size:13px}
  ol.steps{padding-left:22px}ol.steps li{margin:14px 0}ol.steps li>b{display:block;margin-bottom:4px}
  .pill{display:inline-block;padding:2px 10px;border-radius:999px;background:#1b2129;color:var(--dim);font-size:12px}
  .tabs{display:inline-flex;gap:4px;margin:0 0 4px}.tabs button.ghost{padding:4px 10px}.tabs button.ghost.on{border-color:var(--acc);color:var(--acc)}
  details{margin:10px 0 0}summary{cursor:pointer;color:var(--dim);font-size:13px}details[open] summary{margin-bottom:6px}
</style></head><body><main>
<h1>mesh <span>· borrow a teammate's machine, not their credentials</span></h1>
<p class="tag">Your coding agent asks a teammate's laptop to run a tool it doesn't have. They press <b>y</b>. The result comes back. Credentials never move.</p>
<div id="app"></div>
<script>
const ROOM = ${room};
const REPO = ${JSON.stringify(opts.repoUrl)};
const RELAY = (location.protocol === "https:" ? "wss://" : "ws://") + location.host;
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
function copyBtn(txt){ return '<button class="ghost copy" onclick="navigator.clipboard.writeText(' + JSON.stringify(txt).replace(/"/g,"&quot;") + ');this.textContent=\\'copied\\';setTimeout(()=>this.textContent=\\'copy\\',1200)">copy</button>'; }
function pre(txt){ return '<pre>' + copyBtn(txt) + esc(txt) + '</pre>'; }

if (!ROOM) {
  $("#app").innerHTML = \`
    <div class="card"><h2>start here</h2>
      <p><b>mesh lets your AI coding assistant use tools your teammates have and you don't.</b> Their Figma, their database, their deploy access. It runs on their laptop, they click Approve, you get the result. Nobody shares a password or a key.</p>
      <div class="row"><button id="start">Start a session</button><span class="dim small">creates a room and gives you a link to send to your teammates</span></div>
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
    location.href = "/r/" + r.room;
  };
} else {
  let me = localStorage.getItem("mesh.user") || "";
  let shell = localStorage.getItem("mesh.shell") || "bash";
  const asFlag = () => (me ? " --as " + me : "");
  const joinCmd = (sh) => sh === "ps"
    ? "& ([scriptblock]::Create((irm -Headers @{'ngrok-skip-browser-warning'='1'} " + location.origin + "/install.ps1))) " + ROOM + asFlag()
    : "curl -fsSL " + location.origin + "/install.sh | bash -s -- " + ROOM + asFlag();
  const renderJoin = () => {
    const el = $("#join"); if (!el) return;
    const cmd = joinCmd(shell);
    el.innerHTML = copyBtn(cmd) + esc(cmd);
    document.querySelectorAll(".tabs button").forEach((b) => b.classList.toggle("on", b.dataset.sh === shell));
  };
  const render = () => {
    $("#app").innerHTML = \`
      <div class="card"><div class="row"><h2 style="margin:0">room</h2><span class="pill">\${esc(ROOM)}</span>
        <button class="ghost" onclick="navigator.clipboard.writeText(location.href);this.textContent='link copied'">copy room link</button>
        <span class="dim small">share this link with teammates</span></div></div>

      <div class="card"><h2>step 1 · pick a name</h2>
        <div class="row"><label>your name <input id="me" value="\${esc(me)}" placeholder="e.g. tarush" maxlength="32" autocomplete="off"></label>
        <span class="dim small">lowercase, no spaces. This is how teammates' assistants will refer to you.</span></div></div>

      <div class="card"><h2>step 2 · install (one command, ~20 seconds)</h2>
        <div class="row"><span class="tabs"><button class="ghost" data-sh="bash">Mac / Linux</button><button class="ghost" data-sh="ps">Windows</button></span>
        <span class="dim small">Needs <a href="https://nodejs.org" target="_blank" rel="noopener">Node.js</a> (version 20 or newer). If you've used any AI coding tool, you almost certainly have it.</span></div>
        <p class="small"><b>Mac / Linux:</b> open Terminal, go to your project folder (<code>cd path/to/your/project</code>), paste this, press Enter.<br><b>Windows:</b> open Windows Terminal or PowerShell (not Git Bash), go to your project folder, paste this, press Enter.</p>
        <pre id="join"></pre>
        <p class="small"><b>You'll know it worked</b> when it prints <code>● mesh running in the background</code> and your name appears under "who's here" below. You can close the terminal afterwards.</p>
        <p class="small dim">Prefer a file? <b>Windows:</b> download <a id="dl-cmd" href="#">mesh-join-\${esc(ROOM)}.cmd</a> and double-click it (click "Run anyway" if Windows warns). <b>Mac:</b> download <a id="dl-command" href="#">mesh-join-\${esc(ROOM)}.command</a>, right-click it → Open.</p>
        <details><summary>what did that just do?</summary>
        <p class="small dim">It downloaded one small program into a <code>.mesh</code> folder in your home directory and started it in the background. That program joined this room, looked at which MCP servers your coding assistant already has, and offered them to the room with permission "ask" (so nothing runs without your OK). It also told your coding assistant about mesh. To turn it off: <code>node ~/.mesh/mesh.mjs stop</code>. To check: <code>node ~/.mesh/mesh.mjs status</code>.</p></details></div>

      <div class="card"><h2>step 3 · restart your coding assistant once</h2>
        <p class="small">Close your current Claude Code / Codex / Cursor session and open a new one in the same project folder. Coding assistants only look for new tools when they start.</p>
        <p class="small"><b>Check it worked:</b> ask your assistant <i>"list my mesh teammates"</i>. It should answer with the people under "who's here". If it says it has no such tool, open the manual setup below.</p>
        <details><summary>manual setup (only if the check above failed)</summary>
        <p class="small">Claude Code, in a terminal in your project folder:</p>
        \${pre("claude mcp add --transport http mesh http://localhost:7337/mcp")}
        <p class="small">Codex CLI, in any terminal:</p>
        \${pre("codex mcp add mesh --url http://localhost:7337/mcp")}
        <p class="small">Cursor: create a file called <code>.cursor/mcp.json</code> in your project with this content, then restart Cursor:</p>
        \${pre('{ "mcpServers": { "mesh": { "url": "http://localhost:7337/mcp" } } }')}
        <p class="small dim">Developers of mesh itself can run from the repo instead: <code>pnpm -F daemon start join \${esc(ROOM)} --as &lt;you&gt; --relay \${esc(RELAY)}</code> (see <a href="\${esc(REPO)}">the repo</a>).</p>
        </details></div>

      <div class="card"><h2>step 4 · use it</h2>
        <ul class="small">
          <li><b>To borrow something:</b> just ask your assistant to do the task. If it needs a teammate's tool, it will ask them by itself. You can also be explicit: <i>"ask tarush to export the Onboarding frame from Figma"</i>.</li>
          <li><b>When someone asks you:</b> a small window pops up on your screen saying who wants what and why. Click Approve or Deny. If you don't answer within 90 seconds, it's denied.</li>
          <li><b>Messages:</b> your assistant can send a note to a teammate's assistant (<i>"tell abhi I'm changing the login page"</i>). You get a notification when one arrives. On Codex or Cursor, ask your assistant <i>"check my mesh inbox"</i> to read it; Claude Code shows it automatically.</li>
          <li><b>Watch it happen:</b> everything shows up in the "live" panel below.</li>
        </ul></div>

      <div class="card"><h2>who's here <span id="watchers" class="pill" style="text-transform:none"></span></h2><div id="members" class="members"><span class="dim">nobody yet — do step 2 and your name will appear here</span></div></div>
      <div class="card"><h2>live</h2><div id="feed" class="feed"><span class="dim">requests, approvals and output will appear here</span></div></div>\`;
    const dl = () => { const q = "?room=" + encodeURIComponent(ROOM) + (me ? "&as=" + encodeURIComponent(me) : ""); const a = $("#dl-cmd"), b = $("#dl-command"); if (a) a.href = "/join.cmd" + q; if (b) b.href = "/join.command" + q; };
    dl();
    $("#me").oninput = (e) => { me = e.target.value.trim().toLowerCase().replace(/[^a-z0-9_-]/g, ""); localStorage.setItem("mesh.user", me); dl(); renderJoin(); };
    document.querySelectorAll(".tabs button").forEach((b) => { b.onclick = () => { shell = b.dataset.sh; localStorage.setItem("mesh.shell", shell); renderJoin(); }; });
    renderJoin();
  };
  render();

  const seen = new Set(); let next = 0; const lines = [];
  const fmtT = (ts) => { try { return new Date(ts).toTimeString().slice(0, 8); } catch { return ""; } };
  const line = (f) => {
    const t = '<span class="t">' + fmtT(f.ts) + '</span> ';
    const u = '<span class="u">' + esc(f.from || "") + '</span> ';
    if (f.type === "event" && f.kind === "message") return t + u + '<span class="ok">✉ → ' + esc((f.data && f.data.to) || "all") + '</span>: ' + esc((f.data && f.data.text) || f.summary);
    if (f.type === "event") return t + u + ({prompt:"💬",tool_call:"🔧",file_touched:"📁",status:"⏸",note:"📝"}[f.kind] || "•") + ' ' + esc(f.kind) + ': ' + esc(f.summary);
    if (f.type === "request") return t + u + '<span class="req">──▶ ' + esc(f.to) + '  ' + esc(f.command ? "$ " + f.command : f.tool + " " + JSON.stringify(f.args || {})) + '</span>  <span class="t">why: ' + esc(f.why) + '</span>';
    if (f.type === "decision") return t + u + (f.decision === "denied" ? '<span class="no">❌ denied' + (f.reason ? " (" + esc(f.reason) + ")" : "") + '</span>' : f.decision === "auto" ? '<span class="ok">⚡ auto-approved</span>' : '<span class="ok">✅ approved</span>');
    if (f.type === "output") return '<span class="out">' + esc(f.chunk).slice(0, 400) + '</span>';
    if (f.type === "result") return t + u + (f.exitCode === 0 ? '<span class="ok">✔ exit 0' : '<span class="no">✘ exit ' + esc(f.exitCode)) + ' in ' + (f.durationMs / 1000).toFixed(1) + 's' + (f.timedOut ? " (timed out)" : "") + '</span>';
    return null;
  };
  async function poll() {
    try {
      const r = await fetch("/api/rooms/" + ROOM + "?since=" + next).then((x) => x.json());
      next = r.next || 0;
      const mem = $("#members");
      if (mem) mem.innerHTML = r.members.length ? r.members.map((m) => '<div class="m"><b>' + esc(m.user) + '</b> <span class="on">● online</span><div>' +
        (m.offers.length ? m.offers.map((o) => '<span class="offer ' + esc(o.permission || "") + '" title="' + esc(o.permission || "") + '">' + esc(o.name) + '</span>').join("") : '<span class="dim small">no offers</span>') + '</div></div>').join("")
        : '<span class="dim">nobody yet — do step 2 and your name will appear here</span>';
      const w = $("#watchers"); if (w) w.textContent = r.watchers ? r.watchers + " watching" : "";
      for (const f of r.events || []) { if (seen.has(f.i)) continue; seen.add(f.i); const l = line(f); if (l) lines.push(l); }
      const feed = $("#feed");
      if (feed && lines.length) { feed.innerHTML = lines.slice(-200).map((l) => "<div>" + l + "</div>").join(""); feed.scrollTop = feed.scrollHeight; }
    } catch {}
    setTimeout(poll, 2000);
  }
  poll();
}
</script></main></body></html>`;
}
