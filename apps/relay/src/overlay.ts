/**
 * Always-on-top overlay for mesh (docs/OVERLAY-API.md). Served by the relay:
 *
 *   GET /overlay?room=<room>&port=<daemonPort>   self-contained page (inline CSS/JS) — works as a plain popup
 *                                                AND when its script is loaded into a Document Picture-in-Picture window
 *   GET /overlay.js                              the same script alone; defines globalThis.meshOverlay =
 *                                                { createNet, mountOverlay, newestTs, DEFAULT_PORT }
 *
 * The page talks to two things: this relay (room feed / members, same origin) and the owner's LOCAL daemon at
 * http://localhost:<port> (pending approvals, inbox, decide, message). Chrome treats http://localhost as
 * potentially-trustworthy, so an https-served overlay may call it; the daemon whitelists the relay origin for CORS.
 *
 * All overlay logic lives in OVERLAY_JS as one plain-JS IIFE so the room page can load it into a PiP window with a
 * <script src> (innerHTML-inserted scripts never execute) and call mountOverlay(pipWindow.document, …). The network
 * layer (createNet) is DOM-free so it can be unit-tested under node against a mock daemon.
 */
import type { IncomingMessage, ServerResponse } from "node:http";

const ROOM_RE = /^[a-z0-9][a-z0-9-]{1,40}$/;
export const DEFAULT_DAEMON_PORT = 7337;

export function parsePort(raw: string | null | undefined): number {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : DEFAULT_DAEMON_PORT;
}

/** Returns true if the request was handled. Mount from handleWeb() in web.ts. */
export function handleOverlay(req: IncomingMessage, res: ServerResponse, url: URL): boolean {
  const method = req.method ?? "GET";
  if (method !== "GET" && method !== "HEAD") return false;
  if (url.pathname === "/overlay.js") {
    res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store", "access-control-allow-origin": "*" });
    res.end(method === "HEAD" ? undefined : OVERLAY_JS);
    return true;
  }
  if (url.pathname === "/overlay") {
    const room = (url.searchParams.get("room") ?? "").trim();
    if (!ROOM_RE.test(room)) {
      res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
      res.end("bad or missing ?room= (open the overlay from a room page)\n");
      return true;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(method === "HEAD" ? undefined : overlayPage({ room, port: parsePort(url.searchParams.get("port")) }));
    return true;
  }
  return false;
}

/** Standalone overlay page. relayOrigin is taken from location.origin at runtime (same origin as this page). */
export function overlayPage(opts: { room: string; port: number }): string {
  const inline = OVERLAY_JS.replace(/<\/script/gi, "<\\/script");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>mesh · ${escapeHtml(opts.room)}</title>
</head><body>
<script>${inline}</script>
<script>meshOverlay.mountOverlay(document, { room: ${JSON.stringify(opts.room)}, port: ${opts.port}, relayOrigin: location.origin });</script>
</body></html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

/**
 * The overlay script. Plain ES2020, no template literals (it is embedded in one), no external assets.
 * Exposes globalThis.meshOverlay. Under node (no window) it only defines the API — nothing runs.
 */
export const OVERLAY_JS: string = String.raw`(function (root) {
  "use strict";
  var DEFAULT_PORT = 7337;
  var POLL_WAIT_S = 25;
  var RELAY_POLL_MS = 2000;
  var MIN_POLL_GAP_MS = 1500;
  var MAX_BACKOFF_MS = 15000;

  // ---------- network layer (DOM-free; unit-tested under node) ----------
  function createNet(o) {
    var fetchFn = o.fetch || root.fetch;
    var daemon = String(o.daemonBase || "").replace(/\/+$/, "");
    var relay = String(o.relayOrigin || "").replace(/\/+$/, "");
    function req(url, init, timeoutMs) {
      var ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
      var timer = ctrl && timeoutMs ? setTimeout(function () { ctrl.abort(); }, timeoutMs) : null;
      var opts = {}; for (var k in (init || {})) opts[k] = init[k];
      if (ctrl) opts.signal = ctrl.signal;
      return Promise.resolve().then(function () { return fetchFn.call(root, url, opts); }).then(function (r) {
        if (timer) clearTimeout(timer);
        return r.text().then(function (txt) {
          var body = null;
          try { body = txt ? JSON.parse(txt) : null; } catch (e) { body = null; }
          if (!r.ok) {
            var err = new Error("HTTP " + r.status + (body && body.error ? ": " + body.error : ""));
            err.status = r.status; err.body = body; throw err;
          }
          return body;
        });
      }, function (e) { if (timer) clearTimeout(timer); throw e; });
    }
    function post(url, body) {
      return req(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }, 10000);
    }
    return {
      daemonBase: daemon,
      relayOrigin: relay,
      health: function () { return req(daemon + "/health", null, 4000); },
      inbox: function () { return req(daemon + "/inbox?unread=0", null, 6000); },
      /** Long-poll: resolves { pending, messages }. since = ISO ts of the newest message already seen (or null). */
      pollOnce: function (since, waitS) {
        var w = waitS == null ? POLL_WAIT_S : waitS;
        var url = daemon + "/pending?wait=" + w + "&messages=1&consumer=overlay" + (since ? "&since=" + encodeURIComponent(since) : "");
        return req(url, null, (w + 10) * 1000).then(function (b) {
          b = b || {};
          return { pending: Array.isArray(b.pending) ? b.pending : [], messages: Array.isArray(b.messages) ? b.messages : [] };
        });
      },
      decide: function (id, decision, reason) {
        var body = { id: id, decision: decision };
        if (reason) body.reason = reason;
        return post(daemon + "/decide", body);
      },
      sendMessage: function (to, text) { return post(daemon + "/message", { to: to || "all", text: text }); },
      roomFeed: function (room, since) {
        return req(relay + "/api/rooms/" + encodeURIComponent(room) + "?since=" + (since || 0), null, 8000);
      }
    };
  }

  /** Newest ISO timestamp among since and the messages ts. */
  function newestTs(since, messages) {
    var best = since || null;
    for (var i = 0; i < (messages || []).length; i++) {
      var ts = messages[i] && messages[i].ts;
      if (typeof ts !== "string") continue;
      if (!best || Date.parse(ts) > Date.parse(best)) best = ts;
    }
    return best;
  }

  /** Badge shown on the widget / header icon: pending approvals + messages that arrived while collapsed. */
  function badgeFor(s) {
    var pending = Number(s.pending) || 0, unread = Number(s.unread) || 0;
    return { count: pending + unread, ring: pending > 0 };
  }
  function titleFor(room, count) { return (count ? "(" + count + ") " : "") + "mesh · " + room; }

  // ---------- UI ----------
  var CSS = "" +
    // liquid-glass tokens; light by default, dark via prefers-color-scheme, solid fallback without backdrop-filter
    ":root{--fg:#1d1d1f;--fg2:rgba(29,29,31,.6);--line:rgba(0,0,0,.08);--glass:rgba(255,255,255,.55);--gborder:rgba(255,255,255,.35);--ghl:rgba(255,255,255,.4);--card:rgba(255,255,255,.5);--field:rgba(255,255,255,.55);--blue:#0a84ff;--red:rgba(255,69,58,.9);--green:#30d158;--bodybg:linear-gradient(160deg,#eef1f6,#e2e6ee);--scroll:rgba(60,60,67,.3);color-scheme:light dark}" +
    "@media(prefers-color-scheme:dark){:root{--fg:#f5f5f7;--fg2:rgba(245,245,247,.6);--line:rgba(255,255,255,.08);--glass:rgba(28,28,30,.55);--gborder:rgba(255,255,255,.12);--ghl:rgba(255,255,255,.14);--card:rgba(255,255,255,.06);--field:rgba(255,255,255,.07);--bodybg:linear-gradient(160deg,#1c1c1e,#0d0d0f);--scroll:rgba(235,235,245,.3)}}" +
    "@supports not ((backdrop-filter:blur(1px)) or (-webkit-backdrop-filter:blur(1px))){:root{--glass:#f4f5f8;--card:#fff;--field:#fff}@media(prefers-color-scheme:dark){:root{--glass:#1e1e21;--card:#2a2a2e;--field:#2a2a2e}}}" +
    "*{box-sizing:border-box}html,body{height:100%}" +
    "html,body{background:transparent}body{margin:0;color:var(--fg);font:13px/1.45 -apple-system,BlinkMacSystemFont,'SF Pro Text','Segoe UI',system-ui,sans-serif;display:flex;flex-direction:column;gap:8px;padding:8px;overflow:hidden;-webkit-font-smoothing:antialiased}" +
    "body.canvas{background:var(--bodybg)}" +
    ".glass{background:var(--glass);-webkit-backdrop-filter:blur(24px) saturate(180%);backdrop-filter:blur(24px) saturate(180%);border:1px solid var(--gborder);border-radius:18px;box-shadow:inset 0 1px 0 var(--ghl),0 8px 30px rgba(0,0,0,.12)}" +
    ".hd{display:flex;align-items:center;gap:8px;padding:8px 12px;flex:0 0 auto}" +
    ".hd b{font-size:13px;font-weight:600}.hd .room{color:var(--fg2);font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}" +
    ".badge{display:inline-block;min-width:20px;text-align:center;padding:1px 7px;border-radius:999px;background:var(--blue);color:#fff;font-weight:600;font-size:11px;line-height:16px}" +
    ".badge.zero{background:var(--field);color:var(--fg2);font-weight:500;border:1px solid var(--line)}" +
    ".hd label{display:flex;align-items:center;gap:4px;color:var(--fg2);font-size:11px;cursor:pointer;user-select:none}.hd input[type=checkbox]{accent-color:var(--blue);margin:0}" +
    ".main{flex:1 1 auto;overflow:auto;padding:4px 12px 12px;scrollbar-width:thin;scrollbar-color:var(--scroll) transparent}" +
    ".main::-webkit-scrollbar{width:5px}.main::-webkit-scrollbar-thumb{background:var(--scroll);border-radius:3px}.main::-webkit-scrollbar-track{background:transparent}" +
    "h2{font-size:11px;margin:12px 0 6px;color:var(--fg2);text-transform:uppercase;letter-spacing:.06em;font-weight:600;display:flex;align-items:center;gap:6px}h2:first-child{margin-top:8px}" +
    ".empty{color:var(--fg2);font-size:11px;padding:2px 0 4px}" +
    "@keyframes mo-in{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}" +
    "@keyframes mo-pulse{0%,100%{box-shadow:inset 0 1px 0 var(--ghl),0 0 0 0 rgba(10,132,255,0)}50%{box-shadow:inset 0 1px 0 var(--ghl),0 0 0 3px rgba(10,132,255,.35)}}" +
    ".req{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:10px 12px;margin:0 0 8px;box-shadow:inset 0 1px 0 var(--ghl)}" +
    ".req.new{animation:mo-in 160ms ease-out,mo-pulse 1.2s ease-in-out 1}" +
    ".req .who{font-weight:600}.req .who span{color:var(--fg2);font-weight:400}" +
    ".req .why{margin:3px 0 6px}.req .why i{color:var(--fg2);font-style:normal}" +
    ".req pre{margin:0 0 8px;background:var(--field);border:1px solid var(--line);border-radius:8px;padding:6px 8px;font:11.5px/1.45 ui-monospace,'SF Mono',Menlo,monospace;white-space:pre-wrap;word-break:break-word;max-height:150px;overflow:auto;scrollbar-width:thin}" +
    ".req .acts{display:flex;gap:6px;align-items:center}" +
    "button{border:0;border-radius:999px;padding:6px 14px;font-weight:600;font-size:12.5px;cursor:pointer;font-family:inherit;color:#fff;transition:opacity 160ms ease-out,transform 160ms ease-out}button:active{transform:scale(.97)}" +
    "button.ok{background:var(--blue)}button.no{background:var(--red)}" +
    "button.ghost{background:var(--field);color:var(--fg);border:1px solid var(--line);font-weight:500;padding:5px 11px;font-size:12px}" +
    "button:disabled{opacity:.5;cursor:default}" +
    ".req .st{color:var(--fg2);font-size:11px;margin-left:auto}" +
    ".msg{border-bottom:1px solid var(--line);padding:6px 0}.msg:last-child{border-bottom:0}.msg.new{animation:mo-in 160ms ease-out}" +
    ".msg .m{color:var(--fg2);font-size:11px}.msg .m b{color:var(--fg);font-weight:600}.msg .tx{white-space:pre-wrap;word-break:break-word}" +
    ".reply{display:flex;gap:6px;margin:0 0 6px}.reply input{background:var(--field);color:var(--fg);border:1px solid var(--line);border-radius:999px;padding:6px 10px;font-size:12.5px;font-family:inherit;min-width:0;outline:0}" +
    ".reply input:focus{border-color:var(--blue);box-shadow:0 0 0 3px rgba(10,132,255,.2)}.reply .to{width:84px;flex:0 0 auto}.reply .tx{flex:1 1 auto}" +
    ".feed{font:11px/1.5 ui-monospace,'SF Mono',Menlo,monospace}" +
    ".feed div{white-space:pre-wrap;word-break:break-word;border-bottom:1px solid var(--line);padding:2px 0}.feed div:last-child{border-bottom:0}" +
    ".feed .t{color:var(--fg2)}.feed .u{font-weight:600}.feed .rq{color:var(--fg)}.feed .ok{color:var(--green)}.feed .no{color:var(--red)}.feed .out{color:var(--fg2);padding-left:14px}" +
    ".ft{flex:0 0 auto;padding:7px 12px;font-size:11px;color:var(--fg2)}" +
    ".ft .st{display:flex;gap:10px;flex-wrap:wrap;align-items:center}.ft .dot{display:inline-block;width:7px;height:7px;border-radius:50%;background:var(--fg2);margin-right:4px;vertical-align:middle;opacity:.6}" +
    ".ft .on .dot{background:var(--green);opacity:1}.ft .off .dot{background:var(--red);opacity:1}" +
    ".ft .hint{margin-top:4px;color:var(--fg2)}" +
    ".ft input{background:var(--field);color:var(--fg);border:1px solid var(--line);border-radius:8px;padding:2px 6px;font-size:11px;width:62px;font-family:ui-monospace,'SF Mono',Menlo,monospace;outline:0}.ft input:focus{border-color:var(--blue)}" +
    ".ft .port{margin-left:auto;display:flex;align-items:center;gap:4px}" +
    ".icon{position:relative;width:22px;height:22px;border-radius:7px;background:var(--blue);color:#fff;font-weight:700;font-size:13px;display:inline-flex;align-items:center;justify-content:center;flex:0 0 auto}" +
    ".wbadge{position:absolute;top:-6px;right:-7px;min-width:17px;height:17px;border-radius:999px;background:#ff453a;color:#fff;font:600 10.5px/17px -apple-system,BlinkMacSystemFont,'SF Pro Text',system-ui,sans-serif;text-align:center;padding:0 4px;display:none;box-shadow:0 1px 3px rgba(0,0,0,.25)}.wbadge.on{display:block}" +
    ".chev{background:var(--field);color:var(--fg2);border:1px solid var(--line);border-radius:999px;width:24px;height:24px;padding:0;font-size:15px;line-height:1;display:inline-flex;align-items:center;justify-content:center;flex:0 0 auto}" +
    ".widget{display:none;position:relative;width:56px;height:56px;border-radius:16px;cursor:pointer;align-items:center;justify-content:center;user-select:none;flex:0 0 auto}" +
    ".widget .glyph{font-weight:700;font-size:24px;letter-spacing:-.02em;color:var(--fg);line-height:1}" +
    ".widget.ring{box-shadow:inset 0 1px 0 var(--ghl),0 0 0 2.5px var(--blue),0 8px 30px rgba(0,0,0,.12)}" +
    ".widget::after{content:'';position:absolute;inset:-1px;border-radius:inherit;pointer-events:none}" +
    "@keyframes mo-glow{0%{box-shadow:0 0 0 0 rgba(10,132,255,.55)}100%{box-shadow:0 0 0 14px rgba(10,132,255,0)}}.widget.glow::after{animation:mo-glow 1s ease-out}" +
    "body.collapsed{gap:0}body.collapsed .hd,body.collapsed .main,body.collapsed .ft{display:none}body.collapsed .widget{display:flex}" +
    "a{color:var(--blue)}";

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; });
  }
  function fmtT(ts) { try { var d = new Date(ts); return isNaN(d.getTime()) ? "" : d.toTimeString().slice(0, 8); } catch (e) { return ""; } }
  function pretty(args) {
    var s; try { s = JSON.stringify(args == null ? {} : args, null, 1); } catch (e) { s = String(args); }
    return s.length > 800 ? s.slice(0, 800) + " …" : s;
  }
  function feedLine(f) {
    var t = '<span class="t">' + fmtT(f.ts) + '</span> ';
    var u = '<span class="u">' + esc(f.from || "") + '</span> ';
    if (f.type === "event" && f.kind === "message") return t + u + '<span class="ok">✉ → ' + esc((f.data && f.data.to) || "all") + '</span>: ' + esc((f.data && f.data.text) || f.summary);
    if (f.type === "event") return t + u + ({ prompt: "💬", tool_call: "🔧", file_touched: "📁", status: "⏸", note: "📝" }[f.kind] || "•") + ' ' + esc(f.summary);
    if (f.type === "request") return t + u + '<span class="rq">→ ' + esc(f.to) + ' ' + esc(f.command ? "$ " + f.command : (f.tool || "") + " " + JSON.stringify(f.args || {})) + '</span>';
    if (f.type === "decision") return t + u + (f.decision === "denied" ? '<span class="no">✗ denied' + (f.reason ? " (" + esc(f.reason) + ")" : "") + '</span>' : f.decision === "auto" ? '<span class="ok">⚡ auto</span>' : '<span class="ok">✓ approved</span>');
    if (f.type === "output") return '<span class="out">' + esc(String(f.chunk || "").slice(0, 200)) + '</span>';
    if (f.type === "result") return t + u + (f.exitCode === 0 ? '<span class="ok">✔ exit 0' : '<span class="no">✘ exit ' + esc(f.exitCode)) + ' ' + (Number(f.durationMs || 0) / 1000).toFixed(1) + 's' + (f.timedOut ? " (timed out)" : "") + '</span>';
    return null;
  }

  function store(win) {
    return {
      get: function (k) { try { return win.localStorage.getItem(k); } catch (e) { return null; } },
      set: function (k, v) { try { win.localStorage.setItem(k, v); } catch (e) {} }
    };
  }

  /**
   * Mount the overlay into doc (a normal page or a Document Picture-in-Picture document).
   * opts: { room, port?, relayOrigin, fetch? }. Returns { stop, setPort, state }.
   */
  function mountOverlay(doc, opts) {
    var win = doc.defaultView || root;
    var ls = store(win);
    var room = String(opts.room || "");
    var relayOrigin = String(opts.relayOrigin || (win.location && win.location.origin) || "");
    var port = Number(opts.port) || Number(ls.get("mesh.port")) || DEFAULT_PORT;
    var state = {
      port: port, pending: [], messages: [], since: null, seenMsg: {}, decided: {}, deciding: {},
      feed: [], feedNext: 0, feedSeen: {}, members: [],
      daemonOk: null, relayOk: null, daemonErr: "", sound: ls.get("mesh.overlay.sound") === "1",
      stopped: false, gen: 0,
      collapsed: ls.get("mesh.overlay.collapsed") === "1", unread: 0, lastBadge: 0, prevSize: null
    };
    var net = createNet({ daemonBase: "http://localhost:" + port, relayOrigin: relayOrigin, fetch: opts.fetch });

    // -- DOM --
    var style = doc.createElement("style"); style.textContent = CSS; doc.head.appendChild(style);
    if (!win.meshResize) doc.body.classList.add("canvas"); // PiP / popup: paint a soft canvas; the tray window is transparent (vibrancy)
    doc.body.innerHTML = "" +
      '<div class="hd glass"><span class="icon" id="mo-icon">m<span class="wbadge" id="mo-ibadge"></span></span><b>mesh</b><span class="room" title="' + esc(room) + '">' + esc(room) + '</span>' +
      '<label title="beep on new request / message"><input type="checkbox" id="mo-sound"> sound</label>' +
      '<button class="chev" id="mo-collapse" title="minimize to a widget (Esc)" aria-label="minimize">\u2304</button></div>' +
      '<div class="main glass">' +
      '<h2>pending <span id="mo-pcount" class="badge zero">0</span></h2><div id="mo-pending"></div>' +
      '<h2>messages</h2><div class="reply"><input class="to" id="mo-to" list="mo-members" placeholder="all" title="recipient (user or all)"><input class="tx" id="mo-text" placeholder="reply… (enter to send)" maxlength="2000"><button class="ghost" id="mo-send">send</button></div><datalist id="mo-members"></datalist><div id="mo-messages"></div>' +
      '<h2>live</h2><div id="mo-feed" class="feed"></div>' +
      '</div>' +
      '<div class="ft glass"><div class="st"><span id="mo-daemon"><span class="dot"></span>daemon</span><span id="mo-relay"><span class="dot"></span>relay</span>' +
      '<span class="port">port <input id="mo-port" type="number" min="1" max="65535" value="' + port + '"></span></div><div id="mo-hint" class="hint" hidden></div></div>' +
      '<div class="widget glass" id="mo-widget" role="button" tabindex="0" title="mesh — click to expand"><span class="glyph">m</span><span class="wbadge" id="mo-wbadge"></span></div>';
    var $ = function (id) { return doc.getElementById(id); };
    $("mo-sound").checked = state.sound;
    $("mo-sound").onchange = function () { state.sound = !!this.checked; ls.set("mesh.overlay.sound", state.sound ? "1" : "0"); if (state.sound) beep(); };
    $("mo-port").onchange = function () { var p = Number(this.value); if (Number.isInteger(p) && p > 0 && p < 65536) setPort(p); else this.value = state.port; };
    $("mo-send").onclick = send;
    $("mo-collapse").onclick = function () { setCollapsed(true); };
    $("mo-widget").onclick = function () { setCollapsed(false); };
    $("mo-widget").onkeydown = function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setCollapsed(false); } };
    // Escape while the panel has focus minimizes it (an input with text just blurs). Nothing else ever toggles state.
    doc.addEventListener("keydown", function (e) {
      if (e.key !== "Escape" || state.collapsed) return;
      var t = e.target;
      if (t && t.tagName === "INPUT" && t.type !== "checkbox" && t.value) { t.blur(); return; }
      setCollapsed(true);
    });
    $("mo-text").onkeydown = function (e) { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } };

    function beep() {
      if (!state.sound) return;
      try {
        var AC = win.AudioContext || win.webkitAudioContext; if (!AC) return;
        var ac = beep.ac || (beep.ac = new AC());
        var o = ac.createOscillator(), g = ac.createGain();
        o.type = "sine"; o.frequency.value = 880; g.gain.value = 0.06;
        o.connect(g); g.connect(ac.destination); o.start(); o.stop(ac.currentTime + 0.12);
      } catch (e) {}
    }
    function flash(el) { if (!el) return; el.classList.add("new"); setTimeout(function () { el.classList.remove("new"); }, 1400); }

    function pendingCount() { return state.pending.filter(function (p) { return !state.decided[p.id]; }).length; }
    /** Title + badges. Badge = pending + messages that arrived while collapsed; the widget gets a blue ring when approvals wait. */
    function setTitle() {
      var n = pendingCount();
      var b = badgeFor({ pending: n, unread: state.unread });
      try { doc.title = titleFor(room, b.count); } catch (e) {}
      var c = $("mo-pcount"); if (c) { c.textContent = String(n); c.className = "badge" + (n ? "" : " zero"); }
      var ids = ["mo-ibadge", "mo-wbadge"];
      for (var i = 0; i < ids.length; i++) { var el = $(ids[i]); if (el) { el.textContent = b.count > 99 ? "99+" : String(b.count); el.className = "wbadge" + (b.count ? " on" : ""); } }
      var w = $("mo-widget");
      if (w) {
        w.classList.toggle("ring", b.ring);
        if (b.count > state.lastBadge) { w.classList.remove("glow"); void w.offsetWidth; w.classList.add("glow"); }
      }
      state.lastBadge = b.count;
    }

    /** Electron tray shims resizeTo onto window.meshResize (bottom-right anchored); PiP/popup use resizeTo; failures just leave the widget in place. */
    function resizeWin(w, h) {
      try { var fn = win.meshResize || win.resizeTo; if (typeof fn === "function") fn.call(win, w, h); } catch (e) {}
    }

    /** Collapse to the 56px widget / expand back. Only ever called from user actions (chevron, widget click, Esc) or the remembered state at mount. */
    function setCollapsed(v, atMount) {
      v = !!v;
      if (v === state.collapsed && !atMount) return;
      state.collapsed = v; ls.set("mesh.overlay.collapsed", v ? "1" : "0");
      if (v) {
        if (!atMount) { try { state.prevSize = [win.outerWidth || 360, win.outerHeight || 520]; ls.set("mesh.overlay.size", state.prevSize.join(",")); } catch (e) {} }
        doc.body.classList.add("collapsed");
        resizeWin(72, 72);
      } else {
        doc.body.classList.remove("collapsed");
        state.unread = 0;
        var sz = state.prevSize || String(ls.get("mesh.overlay.size") || "").split(",").map(Number).filter(function (x) { return x > 0; });
        if (!sz || sz.length !== 2) sz = [360, 520];
        resizeWin(sz[0], sz[1]);
        renderMessages(null);
      }
      setTitle();
    }

    function renderPending(newIds) {
      var el = $("mo-pending"); if (!el) return;
      var list = state.pending.filter(function (p) { return !state.decided[p.id]; });
      if (!list.length) { el.innerHTML = '<div class="empty">nothing waiting on you</div>'; return; }
      el.innerHTML = list.map(function (p) {
        var body = p.command ? "$ " + p.command : (p.tool || "tool") + " " + pretty(p.args);
        var st = state.deciding[p.id];
        return '<div class="req" data-id="' + esc(p.id) + '"><div class="who">' + esc(p.from) + ' <span>wants to run on ' + esc(p.to) + '</span></div>' +
          '<div class="why"><i>why:</i> ' + esc(p.why || "(no reason given)") + '</div><pre>' + esc(body) + '</pre>' +
          '<div class="acts"><button class="ok" data-d="approved"' + (st ? " disabled" : "") + '>Approve</button><button class="no" data-d="denied"' + (st ? " disabled" : "") + '>Deny</button>' +
          '<span class="st">' + (st ? esc(st) : fmtT(p.createdAt)) + '</span></div></div>';
      }).join("");
      var nodes = el.querySelectorAll(".req");
      for (var i = 0; i < nodes.length; i++) {
        (function (node) {
          var id = node.getAttribute("data-id");
          if (newIds && newIds[id]) flash(node);
          var btns = node.querySelectorAll("button[data-d]");
          for (var j = 0; j < btns.length; j++) (function (b) { b.onclick = function () { decide(id, b.getAttribute("data-d")); }; })(btns[j]);
        })(nodes[i]);
      }
    }

    function renderMessages(newIds) {
      var el = $("mo-messages"); if (!el) return;
      if (!state.messages.length) { el.innerHTML = '<div class="empty">no messages yet</div>'; return; }
      el.innerHTML = state.messages.slice(0, 50).map(function (m) {
        return '<div class="msg" data-id="' + esc(m.id) + '"><div class="m"><b>' + esc(m.from) + '</b> → ' + esc(m.to || "all") + ' · ' + fmtT(m.ts) + '</div><div class="tx">' + esc(m.text) + '</div></div>';
      }).join("");
      if (newIds) { var nodes = el.querySelectorAll(".msg"); for (var i = 0; i < nodes.length; i++) if (newIds[nodes[i].getAttribute("data-id")]) flash(nodes[i]); }
    }

    function renderFeed() {
      var el = $("mo-feed"); if (!el) return;
      if (!state.feed.length) { el.innerHTML = '<div class="empty">room activity will appear here</div>'; return; }
      el.innerHTML = state.feed.slice(-60).map(function (l) { return "<div>" + l + "</div>"; }).join("");
    }

    function renderStatus() {
      var d = $("mo-daemon"), r = $("mo-relay"), h = $("mo-hint");
      if (d) { d.className = state.daemonOk === null ? "" : state.daemonOk ? "on" : "off"; d.innerHTML = '<span class="dot"></span>daemon localhost:' + state.port + (state.daemonOk === false ? " unreachable" : ""); }
      if (r) { r.className = state.relayOk === null ? "" : state.relayOk ? "on" : "off"; r.innerHTML = '<span class="dot"></span>relay' + (state.relayOk === false ? " unreachable" : ""); }
      if (h) {
        var hint = "";
        if (state.daemonOk === false) hint = "Can't reach the mesh daemon at http://localhost:" + state.port + ". Open this overlay from the same browser on the machine running mesh, check it is running (node ~/.mesh/mesh.mjs status), or fix the port →";
        else if (state.relayOk === false) hint = "Relay " + relayOrigin + " not responding; approvals still work, the live feed is paused.";
        h.textContent = hint ? "\u26a0 " + hint : ""; h.hidden = !hint;
      }
    }

    function absorbMessages(msgs) {
      var added = {}; var any = false;
      for (var i = 0; i < msgs.length; i++) {
        var m = msgs[i]; if (!m || !m.id || state.seenMsg[m.id]) continue;
        state.seenMsg[m.id] = 1; state.messages.push(m); added[m.id] = 1; any = true;
      }
      if (any) state.messages.sort(function (a, b) { return Date.parse(b.ts || 0) - Date.parse(a.ts || 0); });
      state.since = newestTs(state.since, msgs);
      return any ? added : null;
    }

    function absorbPending(list) {
      var prev = {}; for (var i = 0; i < state.pending.length; i++) prev[state.pending[i].id] = 1;
      var now = {}; var fresh = {}; var any = false;
      for (var j = 0; j < list.length; j++) { now[list[j].id] = 1; if (!prev[list[j].id] && !state.decided[list[j].id]) { fresh[list[j].id] = 1; any = true; } }
      for (var id in state.decided) if (!now[id]) delete state.decided[id];
      for (var id2 in state.deciding) if (!now[id2]) delete state.deciding[id2];
      state.pending = list;
      return any ? fresh : null;
    }

    function decide(id, decision) {
      state.deciding[id] = decision === "approved" ? "approving…" : "denying…";
      renderPending();
      net.decide(id, decision).then(function () {
        state.decided[id] = 1; delete state.deciding[id];
        state.pending = state.pending.filter(function (p) { return p.id !== id; });
        setTitle(); renderPending();
      }, function (e) {
        if (e && e.status === 404) { state.decided[id] = 1; state.pending = state.pending.filter(function (p) { return p.id !== id; }); }
        delete state.deciding[id];
        setTitle(); renderPending();
      });
    }

    function send() {
      var to = ($("mo-to").value || "all").trim().toLowerCase() || "all";
      var text = $("mo-text").value.trim(); if (!text) return;
      $("mo-send").disabled = true;
      net.sendMessage(to, text).then(function () {
        $("mo-text").value = ""; $("mo-send").disabled = false;
      }, function (e) {
        $("mo-send").disabled = false; $("mo-send").textContent = "failed"; setTimeout(function () { $("mo-send").textContent = "send"; }, 1500);
        state.daemonOk = false; renderStatus();
      });
    }

    var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

    async function daemonLoop(gen) {
      var backoff = 0;
      try {
        var inbox = await net.inbox();
        if (gen !== state.gen || state.stopped) return;
        absorbMessages((inbox && inbox.messages) || []); renderMessages(null);
        state.daemonOk = true; renderStatus();
      } catch (e) { state.daemonOk = false; renderStatus(); }
      while (!state.stopped && gen === state.gen) {
        var t0 = Date.now();
        try {
          var r = await net.pollOnce(state.since);
          if (gen !== state.gen || state.stopped) return;
          backoff = 0;
          if (state.daemonOk !== true) { state.daemonOk = true; renderStatus(); }
          var freshP = absorbPending(r.pending);
          var freshM = absorbMessages(r.messages);
          if (freshM && state.collapsed) state.unread += Object.keys(freshM).length;
          setTitle(); renderPending(freshP); if (freshM) renderMessages(freshM);
          if (freshP || freshM) beep();
          // pending.poll resolves at once while the queue is non-empty: pace ourselves instead of spinning.
          var took = Date.now() - t0; if (took < MIN_POLL_GAP_MS) await sleep(MIN_POLL_GAP_MS - took);
        } catch (e) {
          if (gen !== state.gen || state.stopped) return;
          state.daemonOk = false; state.daemonErr = String(e && e.message || e); renderStatus();
          backoff = Math.min(MAX_BACKOFF_MS, backoff ? backoff * 2 : 1000);
          await sleep(backoff);
        }
      }
    }

    async function relayLoop() {
      while (!state.stopped) {
        try {
          var r = await net.roomFeed(room, state.feedNext);
          state.relayOk = true; state.feedNext = r.next || 0;
          state.members = (r.members || []).map(function (m) { return m.user; });
          var dl = $("mo-members"); if (dl) dl.innerHTML = ["all"].concat(state.members).map(function (u) { return '<option value="' + esc(u) + '">'; }).join("");
          var changed = false;
          for (var i = 0; i < (r.events || []).length; i++) {
            var f = r.events[i]; if (state.feedSeen[f.i]) continue; state.feedSeen[f.i] = 1;
            var l = feedLine(f); if (l) { state.feed.push(l); changed = true; }
          }
          if (state.feed.length > 300) state.feed.splice(0, state.feed.length - 300);
          if (changed) { renderFeed(); var el = $("mo-feed"); if (el) el.scrollTop = el.scrollHeight; }
        } catch (e) { state.relayOk = false; }
        renderStatus();
        await sleep(RELAY_POLL_MS);
      }
    }

    function setPort(p) {
      state.port = p; ls.set("mesh.port", String(p));
      net = createNet({ daemonBase: "http://localhost:" + p, relayOrigin: relayOrigin, fetch: opts.fetch });
      state.gen++; state.daemonOk = null; state.pending = []; state.decided = {}; state.deciding = {};
      setTitle(); renderPending(); renderStatus();
      daemonLoop(state.gen);
    }
    function stop() { state.stopped = true; state.gen++; }
    try { win.addEventListener("pagehide", stop); } catch (e) {}

    renderPending(); renderMessages(); renderFeed(); renderStatus();
    if (state.collapsed) setCollapsed(true, true); else setTitle(); // restore last state; default expanded
    daemonLoop(state.gen); relayLoop();
    return { stop: stop, setPort: setPort, setCollapsed: setCollapsed, state: state };
  }

  var api = { createNet: createNet, mountOverlay: mountOverlay, newestTs: newestTs, badgeFor: badgeFor, titleFor: titleFor, DEFAULT_PORT: DEFAULT_PORT };
  root.meshOverlay = api;
  if (typeof window === "undefined" && typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
`;
