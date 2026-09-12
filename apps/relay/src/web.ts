/**
 * Web front door for the relay: a landing page that starts a session, a room page that shows
 * who's connected + a live feed, and two JSON routes the pages poll. Same port as the WebSocket.
 *
 *   GET  /                 landing: "Start a session"
 *   POST /api/rooms        → { room }            create a room name
 *   GET  /api/rooms/:room  → { room, members, events }   live state (polled every 2 s)
 *   GET  /r/:room          room page
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";

export interface WebRoomView {
  members: Array<{ user: string; role: string; offers: Array<{ name: string; kind?: string; permission?: string }> }>;
  history: string[]; // raw JSON frames, oldest first
}

export interface WebDeps {
  getRoom(name: string): WebRoomView | undefined;
  createRoom(name: string): void;
  repoUrl: string;
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

/** Returns true if the request was handled. */
export function handleWeb(req: IncomingMessage, res: ServerResponse, url: URL, deps: WebDeps): boolean {
  const { pathname } = url;
  const method = req.method ?? "GET";

  if (method === "GET" && pathname === "/") { html(res, page({ repoUrl: deps.repoUrl })); return true; }

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
        <li><b>Each person runs one command</b> on their own laptop. It starts a small daemon that lists the MCP servers and commands they're willing to share, with a permission (always / ask / never) per tool.</li>
        <li><b>Each person connects their coding agent</b> (Claude Code or Cursor) to that daemon with one line. The agent gets five new tools: list teammates, describe a capability, ask a teammate, check a job, team activity.</li>
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
  const render = () => {
    const join = "pnpm -F daemon start join " + ROOM + " --as " + (me || "<you>") + " --relay " + RELAY;
    $("#app").innerHTML = \`
      <div class="card"><div class="row"><h2 style="margin:0">room</h2><span class="pill">\${esc(ROOM)}</span>
        <button class="ghost" onclick="navigator.clipboard.writeText(location.href);this.textContent='link copied'">copy room link</button>
        <span class="dim small">share this link with teammates</span></div></div>

      <div class="card"><h2>1 · you</h2>
        <div class="row"><label>your handle <input id="me" value="\${esc(me)}" placeholder="dev" maxlength="32" autocomplete="off"></label>
        <span class="dim small">lowercase, no spaces. Teammates' agents will address you by this.</span></div></div>

      <div class="card"><h2>2 · run this on your laptop</h2>
        <p class="small dim">First time only: <code>git clone \${esc(REPO)} && cd rho_hackathon && pnpm install</code> (you need repo access). Then, from the repo:</p>
        \${pre(join)}
        <p class="small dim">It reads your Claude Code / Cursor MCP config and offers those tools to the room (default permission <b>ask</b>). Edit <code>team.json</code> to add shell commands or change permissions. Keep the terminal open: that's where you approve requests.</p></div>

      <div class="card"><h2>3 · connect your coding agent</h2>
        <p class="small">Claude Code (run in the project you're working on):</p>
        \${pre("claude mcp add --transport http mesh http://localhost:7337/mcp")}
        <p class="small">Cursor: add to <code>.cursor/mcp.json</code></p>
        \${pre('{ "mcpServers": { "mesh": { "url": "http://localhost:7337/mcp" } } }')}
        <p class="small dim">Restart the agent session after adding. Then just work; when it needs a tool a teammate has, it will ask them.</p></div>

      <div class="card"><h2>who's here <span id="watchers" class="pill" style="text-transform:none"></span></h2><div id="members" class="members"><span class="dim">nobody yet — run step 2</span></div></div>
      <div class="card"><h2>live</h2><div id="feed" class="feed"><span class="dim">requests, approvals and output will appear here</span></div></div>\`;
    $("#me").oninput = (e) => { me = e.target.value.trim().toLowerCase().replace(/[^a-z0-9_-]/g, ""); localStorage.setItem("mesh.user", me); document.querySelectorAll("pre")[0].innerHTML = copyBtn(joinCmd()) + esc(joinCmd()); };
    const joinCmd = () => "pnpm -F daemon start join " + ROOM + " --as " + (me || "<you>") + " --relay " + RELAY;
  };
  render();

  const seen = new Set(); let next = 0; const lines = [];
  const fmtT = (ts) => { try { return new Date(ts).toTimeString().slice(0, 8); } catch { return ""; } };
  const line = (f) => {
    const t = '<span class="t">' + fmtT(f.ts) + '</span> ';
    const u = '<span class="u">' + esc(f.from || "") + '</span> ';
    if (f.type === "event") return t + u + '💬 ' + esc(f.kind) + ': ' + esc(f.summary);
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
