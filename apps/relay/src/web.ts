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
 *                            & ([scriptblock]::Create((irm https://<host>/install.ps1))) <room> [--as handle]
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

echo "mesh: joining room '$ROOM' via $RELAY (keep this terminal open; approvals happen here)"
# When piped through \`curl | bash\` stdin is the script, not the terminal; the daemon needs a TTY to ask y/n.
if [ ! -t 0 ] && ( : </dev/tty ) 2>/dev/null; then
  exec node "$MESH_HOME/mesh.mjs" join "$ROOM" --relay "$RELAY" "$@" </dev/tty
fi
exec node "$MESH_HOME/mesh.mjs" join "$ROOM" --relay "$RELAY" "$@"
`;
}

/** PowerShell: `& ([scriptblock]::Create((irm <origin>/install.ps1))) <room> [--as handle]` */
export function installPs1(o: { http: string; ws: string; host: string }): string {
  return `# mesh one-command join (PowerShell). Downloads the daemon bundle into %USERPROFILE%\\.mesh and joins a room.
#
#   & ([scriptblock]::Create((irm ${o.http}/install.ps1))) <room> [--as handle] [--port 7337]
#
# Needs: node >= 20 (https://nodejs.org). No clone, no pnpm, no npm account.
$ErrorActionPreference = "Stop"
$Origin = "${o.http}"
$Relay = "${o.ws}"
$MeshHome = Join-Path $env:USERPROFILE ".mesh"

if ($args.Count -lt 1 -or [string]::IsNullOrWhiteSpace([string]$args[0]) -or ([string]$args[0]).StartsWith("-")) {
  Write-Error "usage: & ([scriptblock]::Create((irm $Origin/install.ps1))) <room> [--as handle] [--port 7337]"
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
$major = [int]((& node -p 'process.versions.node.split(".")[0]').Trim())
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

Write-Host "mesh: joining room '$Room' via $Relay (keep this window open; approvals happen here)"
& node (Join-Path $MeshHome "mesh.mjs") join $Room --relay $Relay @Rest
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
    <div class="card"><h2>1 · start a session</h2>
      <p>Creates a room. Share its link with your teammates; everyone who joins can borrow each other's tools.</p>
      <div class="row"><button id="start">Start a session</button><span class="dim small">or open an existing room: <code>/r/&lt;room&gt;</code></span></div>
    </div>
    <div class="card"><h2>how it works</h2>
      <ol class="steps">
        <li><b>Each person runs one command</b> on their own laptop (needs Node 20+, nothing else: no clone, no pnpm, no npm account). It downloads a small daemon that lists the MCP servers and commands they're willing to share, with a permission (always / ask / never) per tool.</li>
        <li><b>The daemon registers itself with their coding agent</b> (Claude Code, Cursor, Codex); they just restart the agent session. The agent gets new tools: list teammates, describe a capability, ask a teammate, check a job, team activity, send a message, inbox.</li>
        <li><b>When your agent needs something it doesn't have</b>, it asks. The owner's terminal shows <code>dev wants to run: … [y/n]</code>. They press y or n. Output streams back to your agent and to this page.</li>
      </ol>
      <p class="small dim">Room name is the only secret. No accounts, no shared vault, no cloud sandbox.</p>
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
    ? "& ([scriptblock]::Create((irm " + location.origin + "/install.ps1))) " + ROOM + asFlag()
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

      <div class="card"><h2>1 · you</h2>
        <div class="row"><label>your handle <input id="me" value="\${esc(me)}" placeholder="dev" maxlength="32" autocomplete="off"></label>
        <span class="dim small">lowercase, no spaces. Teammates' agents will address you by this.</span></div></div>

      <div class="card"><h2>2 · run this on your laptop</h2>
        <div class="row"><span class="tabs"><button class="ghost" data-sh="bash">macOS / Linux</button><button class="ghost" data-sh="ps">Windows PowerShell</button></span>
        <span class="dim small">needs Node 20+ (<a href="https://nodejs.org" target="_blank" rel="noopener">nodejs.org</a>). No clone, no pnpm, no npm account.</span></div>
        <pre id="join"></pre>
        <p class="small dim">Downloads the mesh daemon into <code>~/.mesh</code> and joins this room. It reads your Claude Code / Cursor MCP config and offers those tools to the room (default permission <b>ask</b>). Keep the terminal open: that's where you approve requests. Re-run the same command to update.</p></div>

      <div class="card"><h2>3 · restart your coding agent</h2>
        <p class="small">The daemon registers itself with Claude Code, Cursor and Codex when it starts. Restart your agent session and it has the mesh tools; when it needs something a teammate has, it will ask them.</p>
        <details><summary>manual setup (if auto-registration didn't work)</summary>
        <p class="small">Claude Code (run in the project you're working on):</p>
        \${pre("claude mcp add --transport http mesh http://localhost:7337/mcp")}
        <p class="small">Cursor: add to <code>.cursor/mcp.json</code></p>
        \${pre('{ "mcpServers": { "mesh": { "url": "http://localhost:7337/mcp" } } }')}
        <p class="small">Codex: add to <code>~/.codex/config.toml</code></p>
        \${pre('[mcp_servers.mesh]\\nurl = "http://localhost:7337/mcp"')}
        <p class="small dim">Developers of mesh itself can run from the repo instead: <code>pnpm -F daemon start join \${esc(ROOM)} --as &lt;you&gt; --relay \${esc(RELAY)}</code> (see <a href="\${esc(REPO)}">the repo</a>).</p>
        </details></div>

      <div class="card"><h2>who's here <span id="watchers" class="pill" style="text-transform:none"></span></h2><div id="members" class="members"><span class="dim">nobody yet — run step 2</span></div></div>
      <div class="card"><h2>live</h2><div id="feed" class="feed"><span class="dim">requests, approvals and output will appear here</span></div></div>\`;
    $("#me").oninput = (e) => { me = e.target.value.trim().toLowerCase().replace(/[^a-z0-9_-]/g, ""); localStorage.setItem("mesh.user", me); renderJoin(); };
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
        : '<span class="dim">nobody yet — run step 2</span>';
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
