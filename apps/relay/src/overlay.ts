/**
 * Always-on-top overlay for mesh (docs/OVERLAY-API.md). Served by the relay:
 *
 *   GET /overlay?room=<room>&port=<daemonPort>   self-contained page (inline CSS/JS) — works as a plain popup
 *                                                AND when its script is loaded into a Document Picture-in-Picture window
 *   GET /overlay.js                              the same script alone; defines globalThis.meshOverlay =
 *                                                { createNet, mountOverlay, newestTs, badgeFor, titleFor, feedLine,
 *                                                  artifactChip, fmtSize, keyFromHash, DEFAULT_PORT }
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
      /** Where approval requests go: GET -> { mode, modes }; POST { mode } -> { ok, mode } | { ok: false, error }. */
      approvals: function () { return req(daemon + "/approvals", null, 4000); },
      setApprovals: function (mode) { return post(daemon + "/approvals", { mode: mode }); },
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
  // Calm, native-feeling palette (light + dark). Inline CSS also works in Document PiP.
  // Spacing scale 4/8/12/16 px; radii 6 (controls) / 8 (inputs, code) / 12 (cards) / pill.
  var CSS = [
    ":root{--canvas:#f5f5f7;--card-solid:#fff;--card:var(--card-solid);--label:#1d1d1f;--secondary:#6e6e73;--tertiary:#8e8e93;--sep:rgba(0,0,0,.08);--border:rgba(0,0,0,.14);--fill:rgba(0,0,0,.045);--fill2:rgba(0,0,0,.08);--seg-on:#fff;--accent:#0071e3;--accent-hover:#0077ed;--accent-text:#0066cc;--green:#248a3d;--orange:#c93400;--red:#d70015;--shadow:0 0 0 .5px rgba(0,0,0,.07),0 1px 2px rgba(0,0,0,.04),0 6px 16px -6px rgba(0,0,0,.1);--font:-apple-system,BlinkMacSystemFont,'SF Pro Text','SF Pro Display',Inter,'Helvetica Neue',system-ui,sans-serif;--mono:ui-monospace,'SF Mono','JetBrains Mono',Menlo,Consolas,monospace;color-scheme:light dark}",
    "@media(prefers-color-scheme:dark){:root{--canvas:#1c1c1e;--card-solid:#2c2c2e;--label:#f5f5f7;--secondary:#a1a1a6;--tertiary:#7c7c80;--sep:rgba(255,255,255,.08);--border:rgba(255,255,255,.16);--fill:rgba(255,255,255,.07);--fill2:rgba(255,255,255,.12);--seg-on:#4a4a4e;--accent:#0a84ff;--accent-hover:#2891ff;--accent-text:#4aa3ff;--green:#30d158;--orange:#ff9f0a;--red:#ff6961;--shadow:0 0 0 .5px rgba(255,255,255,.07),0 6px 16px -6px rgba(0,0,0,.55)}}",
    "*,*::before,*::after{box-sizing:border-box}html,body{height:100%}[hidden]{display:none!important}",
    "html,body{background:transparent}body{width:100%;min-width:0;margin:0;padding:0;display:flex;flex-direction:column;overflow:hidden;color:var(--label);font:12.5px/1.45 var(--font);-webkit-font-smoothing:antialiased}body.canvas{background:var(--canvas)}body:not(.canvas){--card:color-mix(in srgb,var(--card-solid) 72%,transparent)}.hd,.main,.ft{width:100%;min-width:0}",
    "svg{display:block;flex:none}.vh{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);border:0;opacity:0}",
    // controls
    "button,input,summary{font:inherit;color:inherit}button{min-height:30px;padding:0 12px;border:0;border-radius:8px;background:var(--fill);color:var(--label);font-weight:500;cursor:pointer;transition:background-color .15s,color .15s,box-shadow .15s,transform .1s}button:hover{background:var(--fill2)}button:active{transform:scale(.98)}button:disabled{opacity:.5;cursor:default;transform:none}",
    "button.ok{background:var(--accent);color:#fff;font-weight:600}button.ok:hover{background:var(--accent-hover)}button.end{color:var(--red)}button.arm,button.arm:hover{background:var(--red);color:#fff}",
    ":focus-visible{outline:2px solid var(--accent);outline-offset:2px}input{min-width:0;height:28px;padding:0 8px;border:0;border-radius:7px;background:var(--card-solid);box-shadow:inset 0 0 0 .5px var(--border);color:var(--label)}input:focus-visible{outline:none;box-shadow:inset 0 0 0 1px var(--accent),0 0 0 3px color-mix(in srgb,var(--accent) 20%,transparent)}input::placeholder{color:var(--tertiary)}input[type=number]{font-variant-numeric:tabular-nums}",
    ".iconbtn{position:relative;display:grid;place-items:center;flex:none;width:26px;height:26px;min-height:26px;padding:0;border-radius:7px;background:transparent;color:var(--secondary);cursor:pointer}.iconbtn:hover{background:var(--fill);color:var(--label)}.iconbtn svg{width:15px;height:15px}",
    ".snd .on{display:none}.snd input:checked~.on{display:block;color:var(--accent-text)}.snd input:checked~.off{display:none}.snd:has(input:focus-visible){outline:2px solid var(--accent);outline-offset:1px}",
    // header
    ".hd{flex:none;display:flex;align-items:center;gap:8px;min-height:44px;padding:8px 8px 6px 12px;-webkit-app-region:drag}.hd button,.hd label,.hd .icon{-webkit-app-region:no-drag}.hd .name{font-size:13.5px;font-weight:600;letter-spacing:-.01em}.hd .room{display:flex;align-items:center;gap:4px;min-width:0;flex:1;color:var(--secondary);font-size:12px}.hd .room span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.hd .room svg{width:11px;height:11px;color:var(--tertiary)}.hd .tools{display:flex;align-items:center;gap:2px}",
    ".icon{position:relative;display:inline-grid;place-items:center;flex:none;width:22px;height:22px;border-radius:6px;background:var(--label);color:var(--canvas)}.icon svg{width:14px;height:14px}.wbadge{position:absolute;top:-5px;right:-6px;display:none;min-width:16px;height:16px;padding:0 4px;border-radius:999px;background:var(--red);color:#fff;text-align:center;font:600 10px/16px var(--font);box-shadow:0 0 0 1.5px var(--canvas)}.wbadge.on{display:block}.hd .wbadge{background:var(--accent)}",
    // main + sections
    ".main{min-height:0;flex:1 1 auto;overflow:auto;padding:2px 12px 16px;scrollbar-width:thin;scrollbar-color:var(--fill2) transparent}.main::-webkit-scrollbar{width:6px}.main::-webkit-scrollbar-thumb{border-radius:4px;background:var(--fill2)}",
    ".sec+.sec{margin-top:18px}.sh{display:flex;align-items:center;gap:6px;min-height:18px;margin:0 2px 8px}h2{margin:0;font-size:11.5px;font-weight:600;letter-spacing:.01em;color:var(--secondary)}.badge{display:inline-block;min-width:17px;height:17px;padding:0 5px;border-radius:999px;background:var(--accent);color:#fff;text-align:center;font:600 10.5px/17px var(--font);font-variant-numeric:tabular-nums}.badge.zero{display:none}",
    ".empty{margin:0 2px;padding:6px 0;color:var(--tertiary);font-size:12px}.routed{display:flex;align-items:flex-start;gap:10px;padding:10px 12px;border-radius:10px;background:var(--fill)}.routed svg{width:16px;height:16px;margin-top:1px;color:var(--secondary)}.routed b{display:block;font-weight:600;color:var(--label)}.routed span{display:block;margin-top:1px;color:var(--secondary);font-size:11.5px}",
    ".banner{margin:4px 0 14px;padding:10px 12px;border-radius:10px;background:color-mix(in srgb,var(--accent) 12%,transparent);font-weight:500}.banner.ended{background:color-mix(in srgb,var(--red) 11%,transparent)}",
    "@keyframes mo-in{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}@keyframes mo-pulse{50%{box-shadow:0 0 0 3px color-mix(in srgb,var(--accent) 35%,transparent),var(--shadow)}}",
    // where requests go
    ".route{margin:0 0 10px}.seg{display:flex;gap:2px;padding:2px;border-radius:8px;background:var(--fill)}.seg button{flex:1 1 0;min-width:0;min-height:24px;padding:0 6px;border-radius:6px;background:transparent;color:var(--label);font-size:11.5px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.seg button:hover{background:var(--fill)}.seg button[aria-checked=true]{background:var(--seg-on);box-shadow:0 0 0 .5px rgba(0,0,0,.06),0 1px 3px rgba(0,0,0,.14);font-weight:600}.seg button:active{transform:none}.seg .s{display:none}.route.saving .seg{opacity:.7}",
    ".route-help{margin:6px 2px 0;color:var(--secondary);font-size:11.5px;line-height:1.35}.route-help.err{color:var(--red)}",
    // request cards
    ".req{margin:0 0 8px;padding:12px;border-radius:12px;background:var(--card);box-shadow:var(--shadow)}.req.new{animation:mo-in .18s ease-out,mo-pulse 1.2s ease-in-out 1}",
    ".rh{display:flex;align-items:center;gap:8px}.av{display:grid;place-items:center;flex:none;width:26px;height:26px;border-radius:50%;background:color-mix(in srgb,var(--accent) 14%,transparent);color:var(--accent-text);font-size:12px;font-weight:600;text-transform:uppercase}.who{min-width:0;flex:1;line-height:1.25}.who b{display:block;overflow:hidden;font-size:13px;font-weight:600;text-overflow:ellipsis;white-space:nowrap}.who span{color:var(--secondary);font-size:11.5px}.rh time{flex:none;align-self:flex-start;color:var(--tertiary);font-size:11px;font-variant-numeric:tabular-nums}",
    ".why{margin:10px 0 0;overflow-wrap:anywhere}.why.none{color:var(--tertiary)}.code{max-height:150px;overflow:auto;margin:8px 0 0;padding:8px 10px;border-radius:8px;background:var(--fill);font:11.5px/1.5 var(--mono);white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word;scrollbar-width:thin}.code .p,.code .k{color:var(--secondary)}.code .tn{font-weight:600}",
    ".acts{display:flex;gap:8px;margin-top:12px}.acts button{flex:1 1 0}.decision-error{margin:8px 0 0;color:var(--red);font-size:11.5px}",
    // messages
    ".composer{display:flex;align-items:center;padding:3px;border-radius:10px;background:var(--card);box-shadow:inset 0 0 0 .5px var(--border)}.composer:focus-within{box-shadow:inset 0 0 0 1px var(--accent),0 0 0 3px color-mix(in srgb,var(--accent) 18%,transparent)}.composer input{height:26px;border-radius:6px;background:transparent;box-shadow:none}.composer input:focus-visible{box-shadow:none}.composer .to{flex:none;width:64px;border-radius:6px 0 0 6px;box-shadow:inset -1px 0 0 var(--sep);color:var(--accent-text);font-weight:500}.composer .to::placeholder{color:var(--accent-text);opacity:.75}.composer .to:focus-visible{box-shadow:inset -1px 0 0 var(--sep)}.composer .tx{flex:1 1 auto}.composer button{flex:none;min-height:26px;padding:0 10px;border-radius:7px;background:var(--accent);color:#fff;font-weight:600}.composer button:hover{background:var(--accent-hover)}",
    "#mo-messages{margin-top:6px}.msg{padding:8px 2px;border-top:1px solid var(--sep)}.msg:first-child{border-top:0}.msg.new{animation:mo-in .18s ease-out}.msg .m{display:flex;align-items:baseline;gap:4px;min-width:0;color:var(--secondary);font-size:11.5px}.msg .m b{color:var(--label);font-weight:600}.msg .m time{margin-left:auto;padding-left:8px;color:var(--tertiary);font-size:11px;font-variant-numeric:tabular-nums}.msg .tx{margin-top:2px;white-space:pre-wrap;overflow-wrap:anywhere}",
    // activity
    ".feed{margin:0 2px;font:11px/1.5 var(--mono)}.feed div{padding:2px 0;white-space:pre-wrap;overflow-wrap:anywhere}.feed .empty{margin:0;font:12px/1.45 var(--font)}.feed .t{color:var(--tertiary)}.feed .out{color:var(--secondary)}.feed .u{font-weight:600}.feed .rq{color:var(--label)}.feed .ok{color:var(--green)}.feed .no{color:var(--red)}.feed .out{padding-left:12px}",
    // footer
    ".ft{position:relative;flex:none;padding:8px 12px;border-top:1px solid var(--sep);color:var(--secondary);font-size:11.5px}.ft .st{display:flex;align-items:center;gap:6px;min-height:22px;padding-right:78px;white-space:nowrap}.ft .st>span{display:flex;align-items:center;gap:6px;min-width:0}#mo-daemon .tx{overflow:hidden;text-overflow:ellipsis}#mo-relay{flex:none;color:var(--tertiary)}#mo-relay::before{content:'·';margin-right:2px}",
    ".dot{flex:none;width:7px;height:7px;border-radius:50%;background:var(--tertiary)}.tone-ok .dot{background:var(--green)}.tone-warn .dot{background:var(--orange)}.tone-bad .dot{background:var(--red)}.ft.problem .st{color:var(--label);font-weight:500}",
    ".hint{margin:6px 0 2px;padding:8px 10px;border-radius:8px;background:color-mix(in srgb,var(--orange) 11%,transparent);color:var(--label);font-size:11.5px;line-height:1.4;overflow-wrap:anywhere}.hint.err{background:color-mix(in srgb,var(--red) 10%,transparent)}",
    ".settings>summary{position:absolute;top:8px;right:8px;display:flex;align-items:center;gap:6px;height:22px;padding:0 8px;border-radius:6px;color:var(--secondary);font-weight:500;cursor:pointer;list-style:none;-webkit-user-select:none;user-select:none}.settings>summary::-webkit-details-marker{display:none}.settings>summary:hover{background:var(--fill);color:var(--label)}.settings>summary::after{content:'';width:5px;height:5px;margin-top:-3px;border-right:1.5px solid currentColor;border-bottom:1.5px solid currentColor;transform:rotate(45deg)}.settings[open]>summary{background:var(--fill);color:var(--label)}.settings[open]>summary::after{margin-top:2px;transform:rotate(-135deg)}",
    ".settings-body{display:grid;gap:12px;max-height:min(300px,55vh);overflow:auto;margin-top:8px;padding:12px 2px 4px;border-top:1px solid var(--sep);color:var(--label)}.field{display:grid;gap:4px}.field>label{color:var(--secondary);font-size:11px;font-weight:500}.field .row{display:flex;gap:6px}.field .row input{flex:1 1 auto}.field .port-input{flex:none!important;width:84px}.field button{flex:none;min-height:28px;font-size:12px}",
    ".keybox{padding:10px;border-radius:8px;background:color-mix(in srgb,var(--orange) 11%,transparent)}.keybox>label{color:var(--label)!important}.settings-actions{display:flex;flex-wrap:wrap;gap:6px;padding-top:12px;border-top:1px solid var(--sep)}.settings-actions button{min-height:28px;font-size:12px}",
    // collapsed widget
    ".widget{display:none;position:relative;flex:none;align-items:center;justify-content:center;width:56px;height:56px;border-radius:16px;background:var(--card-solid);box-shadow:var(--shadow);cursor:pointer;-webkit-user-select:none;user-select:none}.widget .glyph{display:grid;place-items:center;width:34px;height:34px;border-radius:9px;background:var(--label);color:var(--canvas)}.widget .glyph svg{width:21px;height:21px}.widget .wbadge{top:-4px;right:-4px;box-shadow:0 0 0 2px var(--card-solid)}.widget.ring{box-shadow:0 0 0 2.5px var(--accent),var(--shadow)}.widget::after{content:'';position:absolute;inset:-1px;border-radius:inherit;pointer-events:none}@keyframes mo-glow{from{box-shadow:0 0 0 0 color-mix(in srgb,var(--accent) 55%,transparent)}to{box-shadow:0 0 0 14px transparent}}.widget.glow::after{animation:mo-glow 1s ease-out}",
    "body.collapsed{padding:8px}body.collapsed .hd,body.collapsed .main,body.collapsed .ft{display:none}body.collapsed .widget{display:flex}",
    "a{color:var(--accent-text)}.chip{display:inline-block;max-width:100%;overflow:hidden;margin:3px 4px 0 0;padding:1px 8px;border-radius:999px;background:var(--fill);color:var(--accent-text);font:11px/1.6 var(--font);text-decoration:none;text-overflow:ellipsis;white-space:nowrap;vertical-align:middle}.chip:hover{background:var(--fill2)}.chip .sz{color:var(--secondary)}.chips{display:block;margin-top:2px}",
    "@media(max-width:360px){.seg .l{display:none}.seg .s{display:inline}.seg button{padding:0 4px}}",
    "@media(max-width:330px){.hd{padding-left:10px}.hd .name{display:none}.main{padding-inline:10px}.ft{padding-inline:10px}.composer .to{width:52px}.req{padding:10px}}",
    "@media(prefers-reduced-motion:reduce){*,*::before,*::after{animation-duration:.01ms!important;animation-iteration-count:1!important;transition-duration:.01ms!important;scroll-behavior:auto!important}}"
  ].join("\n");
  var LOGO = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><circle cx="3.5" cy="4" r="2"/><circle cx="12.5" cy="4" r="2"/><circle cx="8" cy="12.5" r="2"/><path d="M5.5 4h5M4.6 5.8l2.3 5M11.4 5.8l-2.3 5"/></svg>';
  function icon(d) { return '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + d + '</svg>'; }
  var I_BELL = '<path d="M4 11.5V7.2a4 4 0 0 1 8 0v4.3l1.2 1.3H2.8z"/><path d="M6.6 14.3a1.5 1.5 0 0 0 2.8 0"/>';
  var ICONS = {
    bell: icon(I_BELL),
    bellOff: icon(I_BELL + '<path d="M2.2 2.2l11.6 11.6"/>'),
    minimize: icon('<path d="M4 6.5l4 4 4-4"/>'),
    lock: icon('<rect x="3.5" y="7" width="9" height="6.5" rx="1.6"/><path d="M5.5 7V5.2a2.5 2.5 0 0 1 5 0V7"/>'),
    terminal: icon('<rect x="1.8" y="2.8" width="12.4" height="10.4" rx="2"/><path d="M4.8 6.3l2 1.7-2 1.7M8.6 10h2.6"/>'),
    dialog: icon('<rect x="1.8" y="2.8" width="12.4" height="10.4" rx="2"/><path d="M1.8 5.8h12.4M9 10.3h2.8"/>')
  };

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; });
  }
  /** "14:05" local time; "" for bad input. */
  function fmtT(ts) { try { var d = new Date(ts); return isNaN(d.getTime()) ? "" : d.toTimeString().slice(0, 5); } catch (e) { return ""; } }
  function pretty(args) {
    var s; try { s = JSON.stringify(args == null ? {} : args, null, 2); } catch (e) { s = String(args); }
    return s;
  }
  /** Tool args as readable "key: value" lines (strings unquoted, nested values as indented JSON). HTML-escaped. */
  function argsHtml(args) {
    if (args == null) return "";
    if (typeof args !== "object" || Array.isArray(args)) return esc(pretty(args));
    var keys = Object.keys(args); var out = [];
    for (var i = 0; i < keys.length; i++) {
      var v = args[keys[i]];
      out.push('<span class="k">' + esc(keys[i]) + ':</span> ' + esc(typeof v === "string" ? v : pretty(v)));
    }
    return out.join("\n");
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

  // ---------- approvals routing (daemon GET/POST /approvals) ----------
  var MODES = ["auto", "overlay", "agent", "dialog"];
  var MODE_LABEL = { auto: ["Both", "Both"], overlay: ["Overlay", "Overlay"], agent: ["Claude Code", "Claude"], dialog: ["Dialog", "Dialog"] };
  var MODE_TITLE = { auto: "Both: this panel and Claude Code", overlay: "Only this panel", agent: "Claude Code permission prompt", dialog: "System dialog" };
  var MODE_HELP = {
    auto: "Requests go here and to Claude Code. First answer wins.",
    overlay: "Requests go only here. Claude Code stays quiet.",
    agent: "Requests go to the Claude Code permission prompt. Messages still show here.",
    dialog: "A system dialog on this computer asks about each request."
  };
  /** Older daemons call the OS dialog "tty". */
  function normMode(m) { m = String(m == null ? "" : m); return m === "tty" ? "dialog" : m; }

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
      feed: [], feedNext: 0, feedSeen: {}, members: [], user: "",
      daemonOk: null, relayOk: null, daemonErr: "", sound: ls.get("mesh.overlay.sound") === "1",
      stopped: false, gen: 0, key: key, keyNeeded: false, keyPrompted: false,
      collapsed: ls.get("mesh.overlay.collapsed") === "1", unread: 0, lastBadge: 0, prevSize: null,
      // where approval requests go; supported: null = unknown, false = daemon has no /approvals
      appr: { mode: null, modes: [], supported: null, saving: false, error: "" },
      note: null
    };
    var liveKey = function () { return state.key; };
    var net = createNet({ daemonBase: "http://localhost:" + port, relayOrigin: relayOrigin, fetch: opts.fetch, key: liveKey });

    // -- DOM --
    var style = doc.createElement("style"); style.textContent = CSS; doc.head.appendChild(style);
    if (!win.meshResize) doc.body.classList.add("canvas"); // PiP / popup: paint a soft canvas; the tray window is transparent (vibrancy)
    var segs = MODES.map(function (m) {
      return '<button type="button" role="radio" aria-checked="false" tabindex="-1" data-mode="' + m + '" title="' + esc(MODE_TITLE[m]) + '"><span class="l">' + MODE_LABEL[m][0] + '</span><span class="s" aria-hidden="true">' + MODE_LABEL[m][1] + '</span></button>';
    }).join("");
    doc.body.innerHTML = "" +
      '<header class="hd"><span class="icon" id="mo-icon">' + LOGO + '<span class="wbadge" id="mo-ibadge"></span></span><span class="name">mesh</span>' +
      '<span class="room" title="' + esc(room) + '"><span>' + esc(room) + '</span><span id="mo-lock" title="This room is keyed" hidden>' + ICONS.lock + '</span></span>' +
      '<span class="tools"><label class="iconbtn snd" title="Play a sound for new requests and messages"><input type="checkbox" class="vh" id="mo-sound" aria-label="Sound on new activity">' +
      '<span class="off">' + ICONS.bellOff + '</span><span class="on">' + ICONS.bell + '</span></label>' +
      '<button class="iconbtn chev" id="mo-collapse" title="Minimize to a widget (Esc)" aria-label="Minimize">' + ICONS.minimize + '</button></span></header>' +
      '<main class="main"><div id="mo-banner" class="banner" role="status" hidden></div>' +
      '<section class="sec"><div class="sh"><h2>Needs approval</h2><span id="mo-pcount" class="badge zero">0</span></div>' +
      '<div class="route" id="mo-route" hidden><div class="seg" id="mo-approvals" role="radiogroup" aria-label="Where approval requests go">' + segs + '</div>' +
      '<div class="route-help" id="mo-route-help" aria-live="polite"></div></div>' +
      '<div id="mo-pending" aria-live="polite"></div></section>' +
      '<section class="sec"><div class="sh"><h2>Messages</h2></div>' +
      '<div class="composer reply"><input class="to" id="mo-to" list="mo-members" placeholder="all" title="Send to a teammate, or all" aria-label="Message recipient" autocomplete="off" spellcheck="false">' +
      '<input class="tx" id="mo-text" placeholder="Message" maxlength="2000" aria-label="Message text"><button id="mo-send">Send</button></div>' +
      '<datalist id="mo-members"></datalist><div id="mo-messages"></div></section>' +
      '<section class="sec"><div class="sh"><h2>Activity</h2></div><div id="mo-feed" class="feed"></div></section>' +
      '</main>' +
      '<footer class="ft" id="mo-ft"><div class="st" aria-live="polite"><span id="mo-daemon"><span class="dot"></span><span class="tx">Connecting…</span></span><span id="mo-relay" hidden></span></div>' +
      '<div id="mo-hint" class="hint" role="status" hidden></div>' +
      '<details class="settings" id="mo-settings"><summary>Settings</summary><div class="settings-body">' +
      '<div class="field keybox" id="mo-keybox" hidden><label for="mo-key">This room needs its key. Paste the room link or the key.</label><div class="row"><input id="mo-key" placeholder="Room link or key" maxlength="2000" autocomplete="off" spellcheck="false"><button class="ok" id="mo-keygo">Use key</button></div></div>' +
      '<div class="field"><label for="mo-room">Switch room</label><div class="row"><input id="mo-room" placeholder="Room name or link" maxlength="2000" autocomplete="off" spellcheck="false"><button id="mo-switch" title="Join this room instead">Switch</button></div></div>' +
      '<div class="field"><label for="mo-port">mesh port on this computer</label><div class="row"><input class="port-input" id="mo-port" type="number" min="1" max="65535" value="' + port + '"></div></div>' +
      '<div class="settings-actions"><button class="leave" id="mo-leave" title="Disconnect this computer from the room">Leave room</button><button class="end" id="mo-end" title="End this session for everyone (you started it)" hidden>End session for everyone</button></div></div></details></footer>' +
      '<div class="widget" id="mo-widget" role="button" tabindex="0" title="mesh: click to expand" aria-label="Expand mesh"><span class="glyph">' + LOGO + '</span><span class="wbadge" id="mo-wbadge"></span></div>';
    var $ = function (id) { return doc.getElementById(id); };

    /** A short-lived message in the footer (errors from switch / leave / end). */
    function showNote(msg, ms) {
      var until = Date.now() + (ms || 8000);
      state.note = { msg: msg, until: until };
      renderStatus();
      setTimeout(function () { if (state.note && state.note.until === until) { state.note = null; renderStatus(); } }, (ms || 8000) + 50);
    }

    $("mo-sound").checked = state.sound;
    $("mo-sound").onchange = function () { state.sound = !!this.checked; ls.set("mesh.overlay.sound", state.sound ? "1" : "0"); if (state.sound) beep(); };
    $("mo-switch").onclick = function () {
      var v = ($("mo-room").value || "").trim(); if (!v) return;
      var b = this; b.disabled = true; b.textContent = "Switching…";
      fetch("http://localhost:" + state.port + "/switch", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ room: v }) })
        .then(function (r) { return r.json(); })
        .then(function (j) { if (j && j.ok) { location.href = location.pathname + "?room=" + encodeURIComponent(j.room) + "&port=" + state.port; } else { b.disabled = false; b.textContent = "Switch"; showNote((j && j.error) || "Couldn't switch rooms. Check the room name and try again."); } })
        .catch(function () { b.disabled = false; b.textContent = "Switch"; showNote("Couldn't reach mesh to switch rooms."); });
    };
    $("mo-room").onkeydown = function (e) { if (e.key === "Enter") $("mo-switch").click(); };

    // -- where requests go: segmented control bound to GET/POST /approvals --
    function segButtons() { var w = $("mo-approvals"); return w ? w.querySelectorAll("button[data-mode]") : []; }
    function renderApprovals() {
      var wrap = $("mo-route"); if (!wrap) return;
      var a = state.appr;
      var show = !state.stopped && state.daemonOk === true && a.supported === true && !!a.mode;
      wrap.hidden = !show;
      if (!show) return;
      wrap.classList.toggle("saving", a.saving);
      var btns = segButtons(), anyChecked = false;
      for (var i = 0; i < btns.length; i++) {
        var m = btns[i].getAttribute("data-mode");
        var on = m === a.mode;
        btns[i].hidden = a.modes.indexOf(m) < 0 && !on;
        btns[i].setAttribute("aria-checked", on ? "true" : "false");
        btns[i].tabIndex = on ? 0 : -1;
        if (on) anyChecked = true;
      }
      if (!anyChecked && btns.length) btns[0].tabIndex = 0;
      var help = $("mo-route-help");
      if (help) {
        help.className = "route-help" + (a.error ? " err" : "");
        var txt = a.error || MODE_HELP[a.mode] || "";
        if (help.textContent !== txt) help.textContent = txt;
      }
    }
    function absorbApprovals(j) {
      var a = state.appr;
      if (!j || typeof j.mode !== "string") { a.supported = false; return; }
      var list = Array.isArray(j.modes) ? j.modes : ["auto", "overlay", "dialog"];
      var modes = [];
      for (var i = 0; i < list.length; i++) { var m = normMode(list[i]); if (MODES.indexOf(m) >= 0 && modes.indexOf(m) < 0) modes.push(m); }
      a.modes = modes; a.mode = normMode(j.mode); a.supported = true;
    }
    function loadApprovals() {
      var gen = state.gen;
      net.approvals().then(function (j) {
        if (gen !== state.gen || state.stopped || state.appr.saving) return;
        absorbApprovals(j); renderApprovals(); renderPending();
      }, function (e) {
        if (gen !== state.gen) return;
        if (e && (e.status === 404 || e.status === 405)) { state.appr.supported = false; renderApprovals(); }
      });
    }
    function setMode(m) {
      var a = state.appr;
      if (a.saving || !m || m === a.mode) return;
      var prev = a.mode, gen = state.gen;
      a.mode = m; a.saving = true; a.error = "";
      renderApprovals(); renderPending();
      var fail = function (msg) {
        if (gen !== state.gen) return;
        a.saving = false; a.mode = prev; a.error = msg;
        renderApprovals(); renderPending();
      };
      net.setApprovals(m).then(function (j) {
        if (gen !== state.gen) return;
        if (!j || j.ok === false) { fail("Couldn't change this: " + ((j && j.error) || "mesh didn't accept it") + "."); return; }
        a.saving = false; a.error = ""; a.mode = normMode(j.mode || m);
        renderApprovals(); renderPending();
      }, function (e) {
        var why = e && e.body && e.body.error;
        fail(why ? "Couldn't change this: " + why + "." : e && e.status ? "Couldn't change this (mesh replied " + e.status + ")." : "Couldn't reach mesh to change this. Try again.");
      });
    }
    (function () {
      var group = $("mo-approvals"); if (!group) return;
      group.onclick = function (e) {
        var t = e.target && e.target.closest ? e.target.closest("button[data-mode]") : null;
        if (t) setMode(t.getAttribute("data-mode"));
      };
      group.onkeydown = function (e) {
        var dir = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
        if (!dir) return;
        e.preventDefault();
        var btns = Array.prototype.filter.call(segButtons(), function (b) { return !b.hidden; });
        var i = btns.indexOf(doc.activeElement); if (i < 0) i = 0;
        var next = btns[(i + dir + btns.length) % btns.length];
        if (next) { next.focus(); setMode(next.getAttribute("data-mode")); }
      };
    })();

    var leaveArmed = false;
    $("mo-leave").onclick = function () {
      var b = this;
      if (!leaveArmed) { leaveArmed = true; b.textContent = "Confirm leave"; b.classList.add("arm"); setTimeout(function () { leaveArmed = false; b.textContent = "Leave room"; b.classList.remove("arm"); }, 4000); return; }
      leaveArmed = false; b.disabled = true; b.textContent = "Leaving…";
      fetch("http://localhost:" + state.port + "/leave", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ reason: "left from the overlay" }) })
        .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { return r.ok && j && j.ok; }); })
        .then(function (ok) {
          if (!ok) { b.disabled = false; b.textContent = "Leave room"; b.classList.remove("arm"); showNote("This mesh daemon is too old to leave from here. Run: node ~/.mesh/mesh.mjs stop (then rerun the join command to update).", 15000); return; }
          b.textContent = "Left"; finish("You left the room. To come back, run the join command from the room page."); })
        .catch(function () { b.disabled = false; b.textContent = "Leave room"; b.classList.remove("arm"); showNote("Couldn't reach mesh to leave the room."); });
    };
    // End session (owner only; the daemon's /health says owner: true): same two-step confirm as leave.
    var endArmed = false;
    $("mo-end").onclick = function () {
      var b = this;
      if (!endArmed) { endArmed = true; b.textContent = "Confirm: end for everyone"; b.classList.add("arm"); setTimeout(function () { if (!endArmed) return; endArmed = false; b.textContent = "End session for everyone"; b.classList.remove("arm"); }, 4000); return; }
      endArmed = false; b.disabled = true; b.textContent = "Ending…";
      fetch("http://localhost:" + state.port + "/end", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ reason: "ended from the overlay" }) })
        .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { return { ok: r.ok && j && j.ok, status: r.status, error: j && j.error }; }); })
        .then(function (res) {
          if (!res.ok) {
            b.disabled = false; b.textContent = "End session for everyone"; b.classList.remove("arm");
            showNote(res.error || (res.status === 404 ? "This mesh daemon is too old to end the session from here." : "Couldn't end the session."));
            return;
          }
          b.textContent = "Ended"; finish("You ended the session for everyone.", true);
        })
        .catch(function () { b.disabled = false; b.textContent = "End session for everyone"; b.classList.remove("arm"); showNote("Couldn't reach mesh to end the session."); });
    };
    /** Stop every loop (daemon + relay) for good and leave one line in the footer. ended=true marks the relay side "session ended". */
    function finish(msg, ended) {
      state.stopped = true; state.gen++; state.endedMsg = msg; if (ended) state.ended = true;
      state.pending = []; state.deciding = {}; state.decisionErrors = {}; lastPendingSig = null;
      wakeRelay();
      setTitle(); renderPending(); renderStatus();
    }
    /** /health: owner flag (End button), who we are, and the approvals mode if it was changed elsewhere. */
    function checkOwner() {
      var gen = state.gen;
      net.health().then(function (h) {
        if (gen !== state.gen || state.stopped) return;
        state.owner = !!(h && h.owner === true);
        var eb = $("mo-end"); if (eb) eb.hidden = !state.owner || state.stopped;
        var user = h && typeof h.user === "string" ? h.user : "";
        if (user !== state.user) { state.user = user; renderStatus(); }
        var a = state.appr;
        if (h && typeof h.approvals === "string" && !a.saving) {
          if (a.supported !== true) loadApprovals();
          else if (normMode(h.approvals) !== a.mode) { a.mode = normMode(h.approvals); a.error = ""; renderApprovals(); renderPending(); }
        }
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

    /** Empty "Needs approval": where approvals go when it isn't this panel, otherwise a quiet line. */
    function pendingEmpty() {
      var m = state.appr.supported === true ? state.appr.mode : null;
      if (state.daemonOk === false && !state.stopped) return '<div class="empty">Requests will show here once mesh is reachable.</div>';
      if (state.daemonOk === true && m === "agent") return '<div class="routed">' + ICONS.terminal + '<div><b>Approvals go to Claude Code</b><span>To approve here, choose Both or Overlay above.</span></div></div>';
      if (state.daemonOk === true && m === "dialog") return '<div class="routed">' + ICONS.dialog + '<div><b>Approvals go to a system dialog</b><span>To approve here, choose Both or Overlay above.</span></div></div>';
      return '<div class="empty">Nothing waiting for you.</div>';
    }

    var lastPendingSig = null;
    function renderPending(newIds) {
      var el = $("mo-pending"); if (!el) return;
      var list = state.pending.filter(function (p) { return !state.decided[p.id]; });
      var sig = list.map(function (p) { return p.id + ":" + (state.deciding[p.id] || "") + ":" + (state.decisionErrors[p.id] || ""); }).join("|") +
        "#" + (list.length ? "" : [state.daemonOk, state.stopped, state.appr.supported, state.appr.mode].join(","));
      if (sig === lastPendingSig && !newIds) return; // unchanged: don't rebuild DOM under the user's cursor
      lastPendingSig = sig;
      if (!list.length) { el.innerHTML = pendingEmpty(); return; }
      el.innerHTML = list.map(function (p) {
        var st = state.deciding[p.id];
        var error = state.decisionErrors[p.id];
        var argText = p.command ? "" : argsHtml(p.args);
        var body = p.command
          ? '<span class="p">$</span> ' + esc(p.command)
          : '<span class="tn">' + esc(p.tool || "tool") + '</span>' + (argText ? "\n" + argText : "");
        var what = p.command ? "wants to run a command" : "wants to use a tool";
        var initial = String(p.from || "?").charAt(0);
        return '<article class="req" data-id="' + esc(p.id) + '" aria-label="' + esc((p.from || "Someone") + " " + what) + '">' +
          '<div class="rh"><span class="av" aria-hidden="true">' + esc(initial) + '</span><div class="who"><b>' + esc(p.from) + '</b><span>' + what + '</span></div><time>' + fmtT(p.createdAt) + '</time></div>' +
          (p.why ? '<p class="why">' + esc(p.why) + '</p>' : '<p class="why none">No reason given</p>') +
          '<pre class="code">' + body + '</pre>' +
          '<div class="acts"><button class="no" data-d="denied"' + (st ? " disabled" : "") + '>' + (st === "denying…" ? "Denying…" : "Deny") + '</button>' +
          '<button class="ok" data-d="approved"' + (st ? " disabled" : "") + '>' + (st === "approving…" ? "Approving…" : "Approve") + '</button></div>' +
          (error ? '<div class="decision-error" role="alert">' + esc(error) + '</div>' : "") + '</article>';
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
      if (!state.messages.length) { el.innerHTML = '<div class="empty">No messages yet.</div>'; return; }
      el.innerHTML = state.messages.slice(0, 50).map(function (m) {
        // a "file" event lands in the inbox as a message with artifact set (docs/FILES-API.md) → chip under the text
        return '<div class="msg" data-id="' + esc(m.id) + '"><div class="m"><b>' + esc(m.from) + '</b> → ' + esc(m.to || "all") + '<time>' + fmtT(m.ts) + '</time></div><div class="tx">' + esc(m.text) + '</div>' + artifactChips(m.artifact ? [m.artifact] : m.artifacts) + '</div>';
      }).join("");
      if (newIds) { var nodes = el.querySelectorAll(".msg"); for (var i = 0; i < nodes.length; i++) if (newIds[nodes[i].getAttribute("data-id")]) flash(nodes[i]); }
    }

    function renderFeed() {
      var el = $("mo-feed"); if (!el) return;
      if (!state.feed.length) { el.innerHTML = '<div class="empty">Room activity will show up here.</div>'; return; }
      el.innerHTML = state.feed.slice(-60).map(function (l) { return "<div>" + l + "</div>"; }).join("");
    }

    /** One quiet status line; it only gets loud (colour + a fix-it hint) when something needs attention. */
    var lastStatusSig = "";
    function renderStatus() {
      var ft = $("mo-ft"), d = $("mo-daemon"), r = $("mo-relay"), h = $("mo-hint");
      var lk = $("mo-lock"); if (lk) lk.hidden = !state.key;
      var kb = $("mo-keybox"); if (kb) kb.hidden = !state.keyNeeded;
      var settings = $("mo-settings");
      if (state.keyNeeded && !state.keyPrompted) { if (settings) settings.open = true; state.keyPrompted = true; }
      var tone = "", text = "", meta = "", hint = "", hintTone = "";
      if (state.endedMsg) {
        // left / ended: one clear banner on top, and hide controls that need a live daemon or room
        var bn = $("mo-banner"); if (bn) { bn.textContent = state.endedMsg; bn.className = "banner" + (state.ended ? " ended" : ""); bn.hidden = false; }
        ["mo-end", "mo-leave", "mo-keybox", "mo-lock", "mo-settings"].forEach(function (id) { var x = $(id); if (x) x.hidden = true; });
        tone = state.ended ? "bad" : ""; text = state.ended ? "Session ended" : "Disconnected";
      } else if (state.daemonOk === false) {
        tone = "bad"; text = "Can't reach mesh on this computer";
        hint = "Make sure mesh is running: use the join command from the room page, or check the port in Settings (now " + state.port + "). Retrying automatically.";
      } else if (state.daemonOk === null) {
        text = "Connecting…";
      } else if (state.keyNeeded) {
        tone = "warn"; text = "Room key needed"; // the key box in Settings says the rest
      } else if (state.relayOk === false) {
        tone = "warn"; text = "Room server unreachable";
        hint = "Approvals still work. Activity resumes when it reconnects.";
      } else {
        tone = state.relayOk ? "ok" : ""; text = state.user ? "Connected as " + state.user : "Connected";
        if (state.relayOk && state.members.length) meta = state.members.length + " in room";
      }
      if (!state.endedMsg && state.note && Date.now() < state.note.until) { hint = state.note.msg; hintTone = "err"; }
      var sig = [tone, text, meta, hint, hintTone].join("|");
      if (sig !== lastStatusSig) {
        lastStatusSig = sig;
        if (d) { d.className = tone ? "tone-" + tone : ""; d.innerHTML = '<span class="dot"></span><span class="tx">' + esc(text) + '</span>'; d.title = text; }
        if (r) { r.textContent = meta; r.hidden = !meta; }
        if (ft) ft.classList.toggle("problem", tone === "bad" || tone === "warn");
        if (h) { h.textContent = hint; h.className = "hint" + (hintTone ? " " + hintTone : ""); h.hidden = !hint; }
      }
      renderApprovals();
      renderPending();
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
        else state.decisionErrors[id] = "Couldn't send your decision. Check that mesh is running, then try again.";
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
        state.daemonOk = true; renderStatus(); checkOwner(); loadApprovals();
      } catch (e) { state.daemonOk = false; renderStatus(); }
      while (!state.stopped && gen === state.gen) {
        var t0 = Date.now();
        try {
          var r = await net.pollOnce(state.since);
          if (gen !== state.gen || state.stopped) return;
          backoff = 0;
          if (state.daemonOk !== true) { state.daemonOk = true; renderStatus(); checkOwner(); loadApprovals(); }
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
          if (e && e.status === 410) { finish("This session has ended — the person who started it ended it for everyone. You're disconnected; start a new session from the room page.", true); break; }
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
      state.decisionErrors = {}; state.owner = false; state.user = "";
      state.appr = { mode: null, modes: [], supported: null, saving: false, error: "" };
      var endButton = $("mo-end"); if (endButton) endButton.hidden = true;
      state.messages = []; state.seenMsg = {}; state.since = null; state.unread = 0; lastPendingSig = null;
      setTitle(); renderPending(); renderMessages(); renderStatus();
      daemonLoop(state.gen);
    }
    // Stay in sync with changes made elsewhere (CLI, another overlay): owner flag + approvals mode via /health.
    var healthTimer = setInterval(function () { if (!state.stopped && state.daemonOk === true) checkOwner(); }, 15000);
    function stop() { state.stopped = true; state.gen++; clearInterval(healthTimer); }
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
