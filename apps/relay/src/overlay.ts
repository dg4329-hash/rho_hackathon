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

  // ---------- room keys (docs/ROOM-KEYS.md) ----------
  // The key lives in the URL fragment (#k=<key>) and in localStorage under mesh.key.<room>.
  // CURRENT_KEY is set by mountOverlay so artifactChip() can sign file links; it stays null under node.
  var CURRENT_KEY = null;
  /** "#k=abc" / "k=abc&x=1" -> "abc"; anything else -> null. Never throws. */
  function keyFromHash(h) {
    h = String(h == null ? "" : h);
    if (h.charAt(0) === "#") h = h.slice(1);
    if (!h) return null;
    var parts = h.split("&");
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i];
      if (p.slice(0, 2) !== "k=") continue;
      var v = p.slice(2);
      try { v = decodeURIComponent(v); } catch (e) {}
      v = String(v).trim();
      if (v) return v;
    }
    return null;
  }
  function keyStorageKey(room) { return "mesh.key." + room; }
  /** Append key=<k> to a relay file URL so a plain browser click works. */
  function withKey(url, k) {
    if (!url || !k || String(url).indexOf("/api/files/") < 0) return url;
    return url + (String(url).indexOf("?") >= 0 ? "&" : "?") + "key=" + encodeURIComponent(k);
  }

  // ---------- network layer (DOM-free; unit-tested under node) ----------
  function createNet(o) {
    var fetchFn = o.fetch || root.fetch;
    var daemon = String(o.daemonBase || "").replace(/\/+$/, "");
    var relay = String(o.relayOrigin || "").replace(/\/+$/, "");
    // o.key may be a string or a getter (so the net always sees the live key)
    var key = o.key == null ? null : o.key;
    function curKey() {
      var k = key;
      if (typeof k === "function") { try { k = k(); } catch (e) { k = null; } }
      k = k == null ? "" : String(k).trim();
      return k || null;
    }
    function isRelayUrl(url) {
      var u = String(url);
      return u.indexOf("/api/files/") >= 0 && (!relay || u.indexOf(relay) === 0 || u.charAt(0) === "/");
    }
    function req(url, init, timeoutMs) {
      var ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
      var timer = ctrl && timeoutMs ? setTimeout(function () { ctrl.abort(); }, timeoutMs) : null;
      var opts = {}; for (var k in (init || {})) opts[k] = init[k];
      if (ctrl) opts.signal = ctrl.signal;
      var rk = curKey();
      if (rk && isRelayUrl(url)) {
        var hs = {}; for (var hk in (opts.headers || {})) hs[hk] = opts.headers[hk];
        hs["x-mesh-key"] = rk; opts.headers = hs;
      }
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
        var k = curKey();
        var url = relay + "/api/rooms/" + encodeURIComponent(room) + "?since=" + (since || 0) + (k ? "&key=" + encodeURIComponent(k) : "");
        return req(url, null, 8000);
      },
      /** Generic relay request; /api/files/ URLs carry the x-mesh-key header. */
      relayFetch: function (url, init, timeoutMs) { return req(url, init, timeoutMs || 10000); },
      /** Update the room key without recreating the net (the key box retries in place). */
      setKey: function (k) { key = k == null ? null : k; },
      getKey: curKey
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
  // Match the landing page's semantic palette. Inline CSS also works in Document PiP.
  var CSS = [
    ":root{--bg:#fff;--grouped:#f5f5f7;--surface:#fff;--surface2:#fbfbfd;--label:#1d1d1f;--muted:#6e6e73;--line:rgba(0,0,0,.08);--line2:rgba(0,0,0,.14);--fill:rgba(0,0,0,.04);--fill2:rgba(0,0,0,.07);--accent:#0071e3;--accent-text:#0066cc;--green:#1f9d3a;--red:#d70015;--shadow:0 1px 2px rgba(0,0,0,.04),0 8px 24px -8px rgba(0,0,0,.08);--font:-apple-system,BlinkMacSystemFont,'SF Pro Text','SF Pro Display',Inter,'Helvetica Neue',system-ui,sans-serif;--mono:ui-monospace,'SF Mono','JetBrains Mono',Menlo,Consolas,monospace;color-scheme:light dark}",
    "@media(prefers-color-scheme:dark){:root{--bg:#000;--grouped:#0d0d0f;--surface:#161618;--surface2:#1c1c1e;--label:#f5f5f7;--muted:#a1a1a6;--line:rgba(255,255,255,.1);--line2:rgba(255,255,255,.18);--fill:rgba(255,255,255,.06);--fill2:rgba(255,255,255,.1);--accent:#0a84ff;--accent-text:#409cff;--green:#30d158;--red:#ff6961;--shadow:0 1px 2px rgba(0,0,0,.4),0 8px 24px -8px rgba(0,0,0,.6)}}",
    "*,*::before,*::after{box-sizing:border-box}html,body{height:100%}[hidden]{display:none!important}",
    "html,body{background:transparent}body{width:100%;min-width:0;margin:0;padding:9px;display:flex;flex-direction:column;gap:8px;overflow:hidden;color:var(--label);font:12.5px/1.45 var(--font);-webkit-font-smoothing:antialiased}body.canvas{background:var(--grouped)}.hd,.main,.ft{width:100%;min-width:0}",
    ".glass{background:var(--surface);border:1px solid var(--line);border-radius:14px;box-shadow:var(--shadow)}",
    "button,input,summary{font:inherit}button{min-height:32px;padding:5px 12px;border:1px solid transparent;border-radius:999px;background:var(--accent);color:#fff;font-weight:600;cursor:pointer;transition:background .15s,transform .15s}button:hover{background:color-mix(in srgb,var(--accent) 88%,#000)}button:active{transform:scale(.98)}button:disabled{opacity:.55;cursor:default;transform:none}button.ok{background:var(--accent)}button.no,button.ghost{background:var(--fill);border-color:var(--line);color:var(--label)}button.no:hover,button.ghost:hover{background:var(--fill2)}button.end{color:var(--red)}button.arm{border-color:var(--red)}",
    ":focus-visible{outline:3px solid color-mix(in srgb,var(--accent) 55%,transparent);outline-offset:2px}input{min-width:0;padding:7px 9px;border:1px solid var(--line2);border-radius:10px;background:var(--surface);color:var(--label);outline:none}input:focus{border-color:var(--accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--accent) 16%,transparent)}input::placeholder{color:var(--muted)}",
    ".hd{flex:0 0 auto;display:flex;align-items:center;gap:8px;min-height:49px;padding:8px 12px}.hd b{font-size:15px;letter-spacing:-.03em}.hd .room{min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--muted);font-size:11.5px}.hd label{display:flex;align-items:center;gap:4px;color:var(--muted);font-size:11px;white-space:nowrap;cursor:pointer}.hd input[type=checkbox]{accent-color:var(--accent);margin:0}",
    ".icon{position:relative;display:inline-grid;place-items:center;flex:0 0 auto;width:26px;height:26px;border-radius:7px;background:var(--label);color:var(--bg)}.icon svg{width:16px;height:16px}.wbadge{position:absolute;top:-6px;right:-7px;display:none;min-width:17px;height:17px;padding:0 4px;border-radius:999px;background:var(--red);color:#fff;text-align:center;font:600 10px/17px var(--font)}.wbadge.on{display:block}.chev{display:grid;place-items:center;flex:0 0 auto;width:28px;height:28px;min-height:28px;padding:0;border-color:var(--line);background:var(--fill);color:var(--muted);font-size:15px}",
    ".main{min-height:0;flex:1 1 auto;overflow:auto;padding:2px 13px 15px;scrollbar-width:thin;scrollbar-color:var(--line2) transparent}.main::-webkit-scrollbar{width:5px}.main::-webkit-scrollbar-thumb{border-radius:4px;background:var(--line2)}h2{display:flex;align-items:center;gap:7px;margin:17px 0 8px;font-size:11px;font-weight:700;letter-spacing:.07em;text-transform:uppercase;color:var(--muted)}h2:first-of-type{margin-top:13px}.badge{display:inline-block;min-width:19px;padding:1px 6px;border-radius:999px;background:var(--accent);color:#fff;text-align:center;font-size:10px;line-height:16px;letter-spacing:0}.badge.zero{background:var(--fill);color:var(--muted)}.empty{padding:9px 0 11px;color:var(--muted);font-size:12px}",
    ".banner{margin:12px 0 0;padding:10px 11px;border-radius:10px;background:color-mix(in srgb,var(--accent) 11%,var(--surface));font-weight:600}.banner.ended{background:color-mix(in srgb,var(--red) 12%,var(--surface))}@keyframes mo-in{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}@keyframes mo-pulse{50%{box-shadow:0 0 0 3px color-mix(in srgb,var(--accent) 25%,transparent)}}",
    ".req{margin:0 0 9px;padding:11px;border:1px solid var(--line2);border-radius:14px;background:var(--surface2)}.req.new{animation:mo-in .16s ease-out,mo-pulse 1.2s ease-in-out 1}.req .who{font-size:13px;font-weight:700}.req .who span{display:block;margin-top:1px;color:var(--muted);font-size:11px;font-weight:400}.req .why{margin:9px 0;overflow-wrap:anywhere}.req .why i{color:var(--muted);font-style:normal;font-weight:600}.req .detail-label{margin:0 0 4px;color:var(--muted);font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.06em}.req pre{max-height:180px;overflow:auto;margin:0 0 10px;padding:9px;border:1px solid var(--line);border-radius:10px;background:var(--grouped);font:11.5px/1.5 var(--mono);white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word;scrollbar-width:thin}.req .acts{display:flex;align-items:center;gap:7px}.req .acts button{flex:1}.req .st{margin-left:4px;color:var(--muted);font-size:10.5px;white-space:nowrap}.req .decision-error{margin:8px 0 0;color:var(--red);font-size:11px}",
    ".reply{display:flex;gap:6px;margin:0 0 7px}.reply .to{width:61px;flex:0 0 auto}.reply .tx{flex:1 1 auto}.reply button{flex:0 0 auto;min-width:47px;padding-inline:8px}.msg{padding:9px 1px;border-bottom:1px solid var(--line)}.msg:last-child{border-bottom:0}.msg.new{animation:mo-in .16s ease-out}.msg .m{color:var(--muted);font-size:10.5px}.msg .m b{color:var(--label);font-weight:700}.msg .tx{margin-top:3px;white-space:pre-wrap;overflow-wrap:anywhere}",
    ".feed{font:10.5px/1.5 var(--mono)}.feed div{padding:5px 1px;border-bottom:1px solid var(--line);white-space:pre-wrap;overflow-wrap:anywhere}.feed div:last-child{border-bottom:0}.feed .t,.feed .out{color:var(--muted)}.feed .u{font-weight:700}.feed .rq{color:var(--label)}.feed .ok{color:var(--green)}.feed .no{color:var(--red)}.feed .out{padding-left:9px}",
    ".ft{flex:0 0 auto;padding:9px 11px;color:var(--muted);font-size:10.5px}.ft .st{display:flex;align-items:center;gap:8px}.ft .st>span{white-space:nowrap}.ft .dot{display:inline-block;width:7px;height:7px;margin-right:4px;border-radius:50%;background:var(--muted);opacity:.6;vertical-align:middle}.ft .on .dot{background:var(--green);opacity:1}.ft .off .dot{background:var(--red);opacity:1}.ft .lock{margin-left:auto}.ft .hint{margin-top:7px;overflow-wrap:anywhere;color:var(--red)}",
    ".settings{margin-top:7px;border-top:1px solid var(--line);padding-top:6px}.settings summary{width:max-content;cursor:pointer;color:var(--accent-text);font-weight:600;list-style:none}.settings summary::-webkit-details-marker{display:none}.settings summary::after{content:'  ▾';font-size:11px}.settings[open] summary::after{content:'  ▴'}.settings-body{display:grid;gap:9px;max-height:190px;overflow:auto;padding:9px 2px 2px}.settings-row{display:flex;align-items:center;gap:6px}.settings-row label{flex:0 0 62px}.settings-row input{flex:1;width:100%}.settings-row .port-input{max-width:83px}.settings-actions{display:flex;flex-wrap:wrap;gap:6px}.settings-actions button{min-height:29px;padding:4px 9px;font-size:11px}.keybox{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-top:8px}.keybox label{width:100%}.keybox input{flex:1}.keybox button{min-height:29px;padding:4px 9px;font-size:11px}",
    ".widget{display:none;position:relative;flex:0 0 auto;align-items:center;justify-content:center;width:56px;height:56px;border-radius:16px;cursor:pointer;user-select:none}.widget .glyph{display:grid;place-items:center;width:34px;height:34px;border-radius:9px;background:var(--label);color:var(--bg)}.widget .glyph svg{width:21px;height:21px}.widget.ring{box-shadow:0 0 0 2.5px var(--accent),var(--shadow)}.widget::after{content:'';position:absolute;inset:-1px;border-radius:inherit;pointer-events:none}@keyframes mo-glow{from{box-shadow:0 0 0 0 color-mix(in srgb,var(--accent) 55%,transparent)}to{box-shadow:0 0 0 14px transparent}}.widget.glow::after{animation:mo-glow 1s ease-out}body.collapsed{gap:0}body.collapsed .hd,body.collapsed .main,body.collapsed .ft{display:none}body.collapsed .widget{display:flex}",
    "a{color:var(--accent-text)}.chip{display:inline-block;max-width:100%;overflow:hidden;margin:3px 4px 0 0;padding:2px 8px;border:1px solid var(--line);border-radius:999px;background:var(--fill);color:var(--accent-text);font:10.5px/1.5 var(--font);text-decoration:none;text-overflow:ellipsis;white-space:nowrap;vertical-align:middle}.chip:hover{background:var(--fill2)}.chip .sz{color:var(--muted)}.chips{display:block;margin-top:3px}",
    "@media(max-width:340px){body{padding:6px;gap:6px}.hd,.ft{padding-inline:9px}.main{padding-inline:10px}.hd label{font-size:0}.hd input[type=checkbox]{width:14px;height:14px}.req .acts{flex-wrap:wrap}.req .st{margin-left:auto}}@media(prefers-reduced-motion:reduce){*,*::before,*::after{animation-duration:.01ms!important;transition-duration:.01ms!important;scroll-behavior:auto!important}}"
  ].join("\n");
  var LOGO = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><circle cx="3.5" cy="4" r="2"/><circle cx="12.5" cy="4" r="2"/><circle cx="8" cy="12.5" r="2"/><path d="M5.5 4h5M4.6 5.8l2.3 5M11.4 5.8l-2.3 5"/></svg>';

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; });
  }
  function fmtT(ts) { try { var d = new Date(ts); return isNaN(d.getTime()) ? "" : d.toTimeString().slice(0, 8); } catch (e) { return ""; } }
  function pretty(args) {
    var s; try { s = JSON.stringify(args == null ? {} : args, null, 1); } catch (e) { s = String(args); }
    return s;
  }
  /** "184 KB" style. */
  function fmtSize(n) {
    n = Number(n) || 0;
    if (n < 1024) return n + " B";
    if (n < 1024 * 1024) return Math.round(n / 1024) + " KB";
    if (n < 1024 * 1024 * 1024) return (n / (1024 * 1024)).toFixed(1).replace(/\.0$/, "") + " MB";
    return (n / (1024 * 1024 * 1024)).toFixed(1).replace(/\.0$/, "") + " GB";
  }
  /** One artifact chip: name · size, linking to the relay URL (http(s) only; anything else renders unlinked). */
  function artifactChip(a) {
    if (!a || typeof a !== "object") return "";
    var label = esc(a.name || a.id || "file") + ' <span class="sz">· ' + esc(fmtSize(a.size)) + '</span>';
    var url = typeof a.url === "string" && /^https?:\/\//i.test(a.url) ? a.url : "";
    // keyed room: relay file links need ?key= to open in a browser tab (no key known → href unchanged)
    if (url && CURRENT_KEY) url = withKey(url, CURRENT_KEY);
    return url
      ? '<a class="chip" href="' + esc(url) + '" target="_blank" rel="noopener" title="' + esc(a.mime || "") + '">' + label + '</a>'
      : '<span class="chip">' + label + '</span>';
  }
  function artifactChips(list) {
    if (!Array.isArray(list) || !list.length) return "";
    var out = ""; for (var i = 0; i < list.length; i++) out += artifactChip(list[i]);
    return out ? '<span class="chips">' + out + '</span>' : "";
  }
  function feedLine(f) {
    var t = '<span class="t">' + fmtT(f.ts) + '</span> ';
    var u = '<span class="u">' + esc(f.from || "") + '</span> ';
    if (f.type === "event" && f.kind === "message") return t + u + '<span class="ok">✉ → ' + esc((f.data && f.data.to) || "all") + '</span>: ' + esc((f.data && f.data.text) || f.summary);
    if (f.type === "event" && f.kind === "file") {
      var art = f.data && f.data.artifact;
      var note = (f.data && f.data.note) || f.summary || ("sent " + ((art && art.name) || "a file"));
      return t + u + '<span class="ok">📎 → ' + esc((f.data && f.data.to) || "all") + '</span>: ' + esc(note) + artifactChips(art ? [art] : []);
    }
    if (f.type === "event") return t + u + ({ prompt: "💬", tool_call: "🔧", file_touched: "📁", status: "⏸", note: "📝" }[f.kind] || "•") + ' ' + esc(f.summary);
    if (f.type === "request") return t + u + '<span class="rq">→ ' + esc(f.to) + ' ' + esc(f.command ? "$ " + f.command : (f.tool || "") + " " + JSON.stringify(f.args || {})) + '</span>';
    if (f.type === "decision") return t + u + (f.decision === "denied" ? '<span class="no">✗ denied' + (f.reason ? " (" + esc(f.reason) + ")" : "") + '</span>' : f.decision === "auto" ? '<span class="ok">⚡ auto</span>' : '<span class="ok">✓ approved</span>');
    if (f.type === "output") return '<span class="out">' + esc(String(f.chunk || "").slice(0, 200)) + '</span>';
    if (f.type === "result") return t + u + (f.exitCode === 0 ? '<span class="ok">✔ exit 0' : '<span class="no">✘ exit ' + esc(f.exitCode)) + ' ' + (Number(f.durationMs || 0) / 1000).toFixed(1) + 's' + (f.timedOut ? " (timed out)" : "") + '</span>' + artifactChips(f.artifacts);
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
   * opts: { room, port?, relayOrigin, fetch?, key? }. Returns { stop, setPort, setKey, state }.
   */
  function mountOverlay(doc, opts) {
    var win = doc.defaultView || root;
    var ls = store(win);
    var room = String(opts.room || "");
    var relayOrigin = String(opts.relayOrigin || (win.location && win.location.origin) || "");
    var port = Number(opts.port) || Number(ls.get("mesh.port")) || DEFAULT_PORT;
    // room key: opts.key > #k= in this window's fragment > remembered key. Fresh keys are remembered.
    var hashKey = null;
    try { hashKey = keyFromHash(win.location && win.location.hash); } catch (e) {}
    var optKey = opts.key == null ? "" : String(opts.key).trim();
    var key = optKey || hashKey || null;
    if (key) ls.set(keyStorageKey(room), key);
    if (!key) key = String(ls.get(keyStorageKey(room)) || "").trim() || null;
    CURRENT_KEY = key;
    var state = {
      port: port, pending: [], messages: [], since: null, seenMsg: {}, decided: {}, deciding: {}, decisionErrors: {},
      feed: [], feedNext: 0, feedSeen: {}, members: [],
      daemonOk: null, relayOk: null, daemonErr: "", sound: ls.get("mesh.overlay.sound") === "1",
      stopped: false, gen: 0, key: key, keyNeeded: false, keyPrompted: false,
      collapsed: ls.get("mesh.overlay.collapsed") === "1", unread: 0, lastBadge: 0, prevSize: null
    };
    var liveKey = function () { return state.key; };
    var net = createNet({ daemonBase: "http://localhost:" + port, relayOrigin: relayOrigin, fetch: opts.fetch, key: liveKey });

    // -- DOM --
    var style = doc.createElement("style"); style.textContent = CSS; doc.head.appendChild(style);
    if (!win.meshResize) doc.body.classList.add("canvas"); // PiP / popup: paint a soft canvas; the tray window is transparent (vibrancy)
    doc.body.innerHTML = "" +
      '<div class="hd glass"><span class="icon" id="mo-icon">' + LOGO + '<span class="wbadge" id="mo-ibadge"></span></span><b>mesh</b><span class="room" title="' + esc(room) + '">' + esc(room) + '</span>' +
      '<label title="beep on new request / message"><input type="checkbox" id="mo-sound" aria-label="sound on new activity"> sound</label>' +
      '<button class="chev" id="mo-collapse" title="minimize to a widget (Esc)" aria-label="minimize">\u2304</button></div>' +
      '<div class="main glass"><div id="mo-banner" class="banner" hidden></div>' +
      '<h2>Needs approval <span id="mo-pcount" class="badge zero">0</span></h2><div id="mo-pending" aria-live="polite"></div>' +
      '<h2>Messages</h2><div class="reply"><input class="to" id="mo-to" list="mo-members" placeholder="all" title="recipient (user or all)" aria-label="message recipient"><input class="tx" id="mo-text" placeholder="reply… (enter to send)" maxlength="2000" aria-label="message text"><button class="ghost" id="mo-send">Send</button></div><datalist id="mo-members"></datalist><div id="mo-messages"></div>' +
      '<h2>Activity</h2><div id="mo-feed" class="feed"></div>' +
      '</div>' +
      '<div class="ft glass"><div class="st" aria-live="polite"><span id="mo-daemon"><span class="dot"></span>daemon</span><span id="mo-relay"><span class="dot"></span>relay</span><span class="lock" id="mo-lock" title="this room is keyed" hidden>🔒</span></div>' +
      '<div id="mo-hint" class="hint" role="status" hidden></div>' +
      '<details class="settings" id="mo-settings"><summary>Settings</summary><div class="settings-body">' +
      '<div class="settings-row"><label for="mo-port">Daemon port</label><input class="port-input" id="mo-port" type="number" min="1" max="65535" value="' + port + '"></div>' +
      '<div class="settings-row"><label for="mo-room">Switch room</label><input id="mo-room" placeholder="room name or link" title="switch to another room" maxlength="2000"><button class="ghost" id="mo-switch" title="join this room instead">Go</button></div>' +
      '<div class="keybox" id="mo-keybox" hidden><label for="mo-key">Room key needed — paste your room link or its #k= key</label><input id="mo-key" placeholder="room link or key" maxlength="2000" autocomplete="off" spellcheck="false"><button class="ghost" id="mo-keygo">Use key</button></div>' +
      '<div class="settings-actions"><button class="ghost leave" id="mo-leave" title="disconnect this machine from the room">Leave room</button><button class="ghost end" id="mo-end" title="end this session for everyone (you started it)" hidden>End session for everyone</button></div></div></details></div>' +
      '<div class="widget glass" id="mo-widget" role="button" tabindex="0" title="mesh — click to expand"><span class="glyph">' + LOGO + '</span><span class="wbadge" id="mo-wbadge"></span></div>';
    var $ = function (id) { return doc.getElementById(id); };
    $("mo-sound").checked = state.sound;
    $("mo-sound").onchange = function () { state.sound = !!this.checked; ls.set("mesh.overlay.sound", state.sound ? "1" : "0"); if (state.sound) beep(); };
    $("mo-switch").onclick = function () {
      var v = ($("mo-room").value || "").trim(); if (!v) return;
      var b = this; b.disabled = true; b.textContent = "…";
      fetch("http://localhost:" + state.port + "/switch", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ room: v }) })
        .then(function (r) { return r.json(); })
        .then(function (j) { if (j && j.ok) { location.href = location.pathname + "?room=" + encodeURIComponent(j.room) + "&port=" + state.port; } else { b.disabled = false; b.textContent = "Go"; var h = $("mo-hint"); if (h) { h.hidden = false; h.textContent = (j && j.error) || "could not switch"; } } })
        .catch(function () { b.disabled = false; b.textContent = "Go"; });
    };
    $("mo-room").onkeydown = function (e) { if (e.key === "Enter") $("mo-switch").click(); };
    // approvals mode: read from the daemon, set on change (POST /approvals)
    (function () {
      var sel = $("mo-approvals"); if (!sel) return;
      fetch("http://localhost:" + state.port + "/approvals").then(function (r) { return r.json(); }).then(function (j) { if (j && j.mode) sel.value = j.mode === "tty" ? "dialog" : j.mode; }).catch(function () {});
      sel.onchange = function () {
        var v = sel.value;
        fetch("http://localhost:" + state.port + "/approvals", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode: v }) })
          .then(function (r) { return r.json(); })
          .then(function (j) { var h = $("mo-hint"); if (!j || !j.ok) { if (h) { h.hidden = false; h.textContent = (j && j.error) || "could not set approvals mode"; } return; }
            if (h) { h.hidden = v !== "overlay"; if (v === "overlay") h.textContent = "Requests are approved only in this panel; your coding agent won't be asked. Keep it open (falls back to a system dialog if it's closed)."; } })
          .catch(function () {});
      };
    })();
    var leaveArmed = false;
    $("mo-leave").onclick = function () {
      var b = this;
      if (!leaveArmed) { leaveArmed = true; b.textContent = "Confirm leave"; b.classList.add("arm"); setTimeout(function () { leaveArmed = false; b.textContent = "Leave room"; b.classList.remove("arm"); }, 4000); return; }
      leaveArmed = false; b.disabled = true; b.textContent = "leaving…";
      fetch("http://localhost:" + state.port + "/leave", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ reason: "left from the overlay" }) })
        .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { return r.ok && j && j.ok; }); })
        .then(function (ok) { var h = $("mo-hint");
          if (!ok) { b.disabled = false; b.textContent = "Leave room"; if (h) { h.hidden = false; h.textContent = "This mesh daemon is too old to leave from here. Run: node ~/.mesh/mesh.mjs stop (then rerun the join command to update)."; } return; }
          b.textContent = "left"; finish("You left the room. To come back, run the join command from the room page."); })
        .catch(function () { b.disabled = false; b.textContent = "Leave room"; });
    };
    // End session (owner only; the daemon's /health says owner: true): same two-step confirm as leave.
    var endArmed = false;
    $("mo-end").onclick = function () {
      var b = this;
      if (!endArmed) { endArmed = true; b.textContent = "Confirm: end for everyone"; b.classList.add("arm"); setTimeout(function () { if (!endArmed) return; endArmed = false; b.textContent = "End session for everyone"; b.classList.remove("arm"); }, 4000); return; }
      endArmed = false; b.disabled = true; b.textContent = "ending…";
      fetch("http://localhost:" + state.port + "/end", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ reason: "ended from the overlay" }) })
        .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { return { ok: r.ok && j && j.ok, status: r.status, error: j && j.error }; }); })
        .then(function (res) {
          if (!res.ok) {
            b.disabled = false; b.textContent = "End session for everyone"; b.classList.remove("arm");
            var h = $("mo-hint"); if (h) { h.hidden = false; h.textContent = res.error || (res.status === 404 ? "This mesh daemon is too old to end the session from here." : "could not end the session"); }
            return;
          }
          b.textContent = "ended"; finish("You ended the session for everyone.", true);
        })
        .catch(function () { b.disabled = false; b.textContent = "End session for everyone"; b.classList.remove("arm"); });
    };
    /** Stop every loop (daemon + relay) for good and leave one line in the footer. ended=true marks the relay side "session ended". */
    function finish(msg, ended) {
      state.stopped = true; state.gen++; state.endedMsg = msg; if (ended) state.ended = true;
      state.pending = []; state.deciding = {}; state.decisionErrors = {}; lastPendingSig = null;
      wakeRelay();
      setTitle(); renderPending(); renderStatus();
    }
    function checkOwner() {
      var gen = state.gen;
      net.health().then(function (h) {
        if (gen !== state.gen || state.stopped) return;
        state.owner = !!(h && h.owner === true);
        var eb = $("mo-end"); if (eb) eb.hidden = !state.owner || state.stopped;
      }, function () {});
    }
    $("mo-keygo").onclick = function () { applyKey($("mo-key").value); };
    $("mo-key").onkeydown = function (e) { if (e.key === "Enter") { e.preventDefault(); applyKey(this.value); } };
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

    var lastPendingSig = null;
    function renderPending(newIds) {
      var el = $("mo-pending"); if (!el) return;
      var list = state.pending.filter(function (p) { return !state.decided[p.id]; });
      var sig = list.map(function (p) { return p.id + ":" + (state.deciding[p.id] || "") + ":" + (state.decisionErrors[p.id] || ""); }).join("|");
      if (sig === lastPendingSig && !newIds) return; // unchanged: don't rebuild DOM under the user's cursor
      lastPendingSig = sig;
      if (!list.length) { el.innerHTML = '<div class="empty">No requests waiting for your approval.</div>'; return; }
      el.innerHTML = list.map(function (p) {
        var body = p.command ? "$ " + p.command : (p.tool || "tool") + " " + pretty(p.args);
        var st = state.deciding[p.id];
        var error = state.decisionErrors[p.id];
        return '<div class="req" data-id="' + esc(p.id) + '"><div class="who">' + esc(p.from) + ' <span>wants to use your machine</span></div>' +
          '<div class="why"><i>Reason:</i> ' + esc(p.why || "No reason given") + '</div><div class="detail-label">' + (p.command ? "Command" : "Tool and arguments") + '</div><pre>' + esc(body) + '</pre>' +
          '<div class="acts"><button class="ok" data-d="approved"' + (st ? " disabled" : "") + '>Approve</button><button class="no" data-d="denied"' + (st ? " disabled" : "") + '>Deny</button>' +
          '<span class="st">' + (st ? esc(st) : fmtT(p.createdAt)) + '</span></div>' +
          (error ? '<div class="decision-error" role="alert">' + esc(error) + '</div>' : "") + '</div>';
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
        // a "file" event lands in the inbox as a message with artifact set (docs/FILES-API.md) → chip under the text
        return '<div class="msg" data-id="' + esc(m.id) + '"><div class="m"><b>' + esc(m.from) + '</b> → ' + esc(m.to || "all") + ' · ' + fmtT(m.ts) + '</div><div class="tx">' + esc(m.text) + '</div>' + artifactChips(m.artifact ? [m.artifact] : m.artifacts) + '</div>';
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
      if (r) { r.className = state.ended ? "off" : state.relayOk === null ? "" : state.relayOk ? "on" : "off"; r.innerHTML = '<span class="dot"></span>relay' + (state.ended ? " · session ended" : state.relayOk === false ? (state.keyNeeded ? " locked" : " unreachable") : ""); }
      var lk = $("mo-lock"); if (lk) lk.hidden = !state.key;
      var kb = $("mo-keybox"); if (kb) kb.hidden = !state.keyNeeded;
      var settings = $("mo-settings");
      if (state.keyNeeded && !state.keyPrompted) { if (settings) settings.open = true; state.keyPrompted = true; }
      if (h) {
        var hint = "";
        if (state.endedMsg) {
          // left / ended: one clear banner on top, and hide controls that need a live daemon or room
          h.hidden = true;
          var bn = $("mo-banner"); if (bn) { bn.textContent = state.endedMsg; bn.className = "banner" + (state.ended ? " ended" : ""); bn.hidden = false; }
          ["mo-end", "mo-leave", "mo-keybox", "mo-lock", "mo-settings"].forEach(function (id) { var x = $(id); if (x) x.hidden = true; });
          return;
        }
        if (state.daemonOk === false) hint = "Daemon unavailable at localhost:" + state.port + ". Check mesh status or change the port in Settings.";
        else if (state.keyNeeded) hint = ""; // the key box below already says it
        else if (state.relayOk === false) hint = "Relay unavailable. Approvals still work; activity will resume when it reconnects.";
        h.textContent = hint ? "\u26a0 " + hint : ""; h.hidden = !hint;
      }
    }

    /** Remember a pasted key, hand it to the net and retry the relay poll at once (no reload). */
    function applyKey(raw) {
      var k = String(raw == null ? "" : raw).trim();
      if (!k) return;
      if (k.indexOf("#k=") >= 0) k = keyFromHash(k.slice(k.indexOf("#"))) || k; // tolerate a whole room link
      state.key = k; CURRENT_KEY = k;
      ls.set(keyStorageKey(room), k);
      if (net && net.setKey) net.setKey(liveKey);
      state.keyNeeded = false;
      state.keyPrompted = false;
      var inp = $("mo-key"); if (inp) inp.value = "";
      renderStatus();
      wakeRelay();
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
      for (var id3 in state.decisionErrors) if (!now[id3]) delete state.decisionErrors[id3];
      state.pending = list;
      return any ? fresh : null;
    }

    function decide(id, decision) {
      delete state.decisionErrors[id];
      state.deciding[id] = decision === "approved" ? "approving…" : "denying…";
      renderPending();
      net.decide(id, decision).then(function () {
        state.decided[id] = 1; delete state.deciding[id];
        state.pending = state.pending.filter(function (p) { return p.id !== id; });
        setTitle(); renderPending();
      }, function (e) {
        if (e && e.status === 404) { state.decided[id] = 1; state.pending = state.pending.filter(function (p) { return p.id !== id; }); }
        else state.decisionErrors[id] = "Could not send your decision. Check the daemon connection and retry.";
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
        $("mo-send").disabled = false; $("mo-send").textContent = "Failed"; setTimeout(function () { $("mo-send").textContent = "Send"; }, 1500);
        state.daemonOk = false; renderStatus();
      });
    }

    var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

    // Interruptible pause for the relay loop: a fresh key retries immediately instead of waiting out RELAY_POLL_MS.
    var relayWake = null;
    function wakeRelay() { var w = relayWake; relayWake = null; if (w) w(); }
    function relaySleep(ms) {
      return new Promise(function (res) {
        var done = false;
        var fin = function () { if (done) return; done = true; if (relayWake === fin) relayWake = null; res(); };
        relayWake = fin;
        setTimeout(fin, ms);
      });
    }

    async function daemonLoop(gen) {
      var backoff = 0;
      try {
        var inbox = await net.inbox();
        if (gen !== state.gen || state.stopped) return;
        absorbMessages((inbox && inbox.messages) || []); renderMessages(null);
        state.daemonOk = true; renderStatus(); checkOwner();
      } catch (e) { state.daemonOk = false; renderStatus(); }
      while (!state.stopped && gen === state.gen) {
        var t0 = Date.now();
        try {
          var r = await net.pollOnce(state.since);
          if (gen !== state.gen || state.stopped) return;
          backoff = 0;
          if (state.daemonOk !== true) { state.daemonOk = true; renderStatus(); checkOwner(); }
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
          if (state.stopped) break;
          state.relayOk = true; state.keyNeeded = false; state.feedNext = r.next || 0;
          state.members = (r.members || []).map(function (m) { return m.user; });
          var dl = $("mo-members"); if (dl) dl.innerHTML = ["all"].concat(state.members).map(function (u) { return '<option value="' + esc(u) + '">'; }).join("");
          var changed = false;
          for (var i = 0; i < (r.events || []).length; i++) {
            var f = r.events[i]; if (state.feedSeen[f.i]) continue; state.feedSeen[f.i] = 1;
            var l = feedLine(f); if (l) { state.feed.push(l); changed = true; }
          }
          if (state.feed.length > 300) state.feed.splice(0, state.feed.length - 300);
          if (changed) { renderFeed(); var el = $("mo-feed"); if (el) el.scrollTop = el.scrollHeight; }
        } catch (e) {
          if (state.stopped) break;
          state.relayOk = false;
          // 410: the owner ended this session — stop polling the relay for good (no endless loop against it).
          if (e && e.status === 410) { finish("This session has ended \u2014 the person who started it ended it for everyone. You're disconnected; start a new session from the room page.", true); break; }
          // 401: this room is keyed and we have no key (or the wrong one) — ask for the link.
          if (e && e.status === 401) state.keyNeeded = true;
        }
        renderStatus();
        if (state.stopped) break;
        await relaySleep(RELAY_POLL_MS);
      }
    }

    function setPort(p) {
      state.port = p; ls.set("mesh.port", String(p));
      var portInput = $("mo-port"); if (portInput) portInput.value = String(p);
      net = createNet({ daemonBase: "http://localhost:" + p, relayOrigin: relayOrigin, fetch: opts.fetch, key: liveKey });
      state.gen++; state.daemonOk = null; state.pending = []; state.decided = {}; state.deciding = {};
      state.decisionErrors = {}; state.owner = false;
      var endButton = $("mo-end"); if (endButton) endButton.hidden = true;
      state.messages = []; state.seenMsg = {}; state.since = null; state.unread = 0; lastPendingSig = null;
      setTitle(); renderPending(); renderMessages(); renderStatus();
      daemonLoop(state.gen);
    }
    function stop() { state.stopped = true; state.gen++; }
    try { win.addEventListener("pagehide", stop); } catch (e) {}

    renderPending(); renderMessages(); renderFeed(); renderStatus();
    if (state.collapsed) setCollapsed(true, true); else setTitle(); // restore last state; default expanded
    daemonLoop(state.gen); relayLoop();
    return { stop: stop, setPort: setPort, setKey: applyKey, setCollapsed: setCollapsed, state: state };
  }

  var api = { createNet: createNet, mountOverlay: mountOverlay, newestTs: newestTs, badgeFor: badgeFor, titleFor: titleFor, feedLine: feedLine, artifactChip: artifactChip, fmtSize: fmtSize, keyFromHash: keyFromHash, DEFAULT_PORT: DEFAULT_PORT };
  root.meshOverlay = api;
  if (typeof window === "undefined" && typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
`;
