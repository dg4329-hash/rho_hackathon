// @ts-check
// mesh tray: a frameless, always-on-top Electron shell that hosts the relay's /overlay page.
// Reads ~/.mesh/config.json (written by `mesh join`), derives the relay's HTTP origin from the ws URL,
// and opens <origin>/overlay?room=<room>&port=<port> (falls back to /r/<room> while /overlay is 404).
"use strict";

const { app, BrowserWindow, Tray, Menu, nativeImage, screen, session, shell, ipcMain } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const zlib = require("node:zlib");

const SMOKE = process.argv.includes("--smoke");
const SMOKE_MS = 5000;
const DEFAULT_SIZE = { width: 360, height: 520 };
const MIN_SIZE = { width: 72, height: 72 }; // the page collapses itself to a 72×72 widget
const COLLAPSED_MAX = 200; // sizes below this are treated as "collapsed" and not persisted
const MARGIN = 16;
const MAC = process.platform === "darwin";
const WIN = process.platform === "win32";

const meshHome = path.join(os.homedir(), ".mesh");
const configPath = path.join(meshHome, "config.json");
const trayStatePath = path.join(meshHome, "tray.json");

/** @typedef {{ room: string; relay: string; user?: string; port?: number }} JoinConfig */
/** @typedef {{ x?: number; y?: number; width?: number; height?: number }} TrayState */

/** @returns {JoinConfig} */
function readJoinConfig() {
  const raw = fs.readFileSync(configPath, "utf8");
  const cfg = /** @type {Partial<JoinConfig>} */ (JSON.parse(raw));
  if (!cfg.room || !cfg.relay) throw new Error(`${configPath} is missing room/relay`);
  return { room: cfg.room, relay: cfg.relay, user: cfg.user, port: Number(cfg.port) || 7337 };
}

/** wss://x → https://x, ws://x → http://x (path/query stripped). @param {string} relay */
function httpOrigin(relay) {
  const u = new URL(relay);
  u.protocol = u.protocol === "wss:" ? "https:" : u.protocol === "ws:" ? "http:" : u.protocol;
  return u.origin;
}

/** @returns {TrayState} */
function readTrayState() {
  try { return /** @type {TrayState} */ (JSON.parse(fs.readFileSync(trayStatePath, "utf8"))); } catch { return {}; }
}
/** @param {TrayState} st */
function writeTrayState(st) {
  try { fs.mkdirSync(meshHome, { recursive: true }); fs.writeFileSync(trayStatePath, JSON.stringify(st, null, 2) + "\n"); } catch { /* best effort */ }
}

/** Bottom-right of the primary display's work area, with a margin. @param {{width:number;height:number}} size */
function defaultPosition(size) {
  const wa = screen.getPrimaryDisplay().workArea;
  return { x: wa.x + wa.width - size.width - MARGIN, y: wa.y + wa.height - size.height - MARGIN };
}

/** Is the saved rect at least partly on some display? @param {Electron.Rectangle} r */
function onScreen(r) {
  return screen.getAllDisplays().some((d) => {
    const b = d.workArea;
    return r.x < b.x + b.width && r.x + r.width > b.x && r.y < b.y + b.height && r.y + r.height > b.y;
  });
}

/** Does <origin>/overlay exist yet? (HEAD, then GET; 404 → fall back to the room page.) @param {string} url */
async function urlExists(url) {
  const headers = { "ngrok-skip-browser-warning": "1" };
  for (const method of ["HEAD", "GET"]) {
    try {
      const r = await fetch(url, { method, headers, redirect: "manual", signal: AbortSignal.timeout(4000) });
      if (r.status === 404) return false;
      if (r.ok || (r.status >= 300 && r.status < 400)) return true;
      if (r.status === 405) continue; // HEAD not allowed → try GET
      return false;
    } catch (e) {
      if (method === "GET") { console.warn(`[tray] probe ${url} failed: ${/** @type {Error} */ (e).message}`); return false; }
    }
  }
  return false;
}

// ---- tray icon: a tiny PNG built at runtime (no binary assets in the repo) ----
/** Build a 16×16 / 32×32 RGBA PNG of a rounded "mesh" glyph (three nodes + edges). Black on transparent = macOS template icon.
 * @param {number} size @param {[number,number,number]} rgb */
function makeIconPng(size, rgb) {
  const px = Buffer.alloc(size * size * 4, 0);
  const s = size / 16;
  /** @param {number} cx @param {number} cy @param {number} r */
  const disc = (cx, cy, r) => {
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const dx = x + 0.5 - cx, dy = y + 0.5 - cy;
      const d = Math.sqrt(dx * dx + dy * dy) - r;
      const a = Math.max(0, Math.min(1, 0.5 - d)); // 1px antialias
      if (a > 0) blend(x, y, a);
    }
  };
  /** @param {number} x0 @param {number} y0 @param {number} x1 @param {number} y1 @param {number} w */
  const line = (x0, y0, x1, y1, w) => {
    const len = Math.hypot(x1 - x0, y1 - y0);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const px0 = x + 0.5, py0 = y + 0.5;
      const t = Math.max(0, Math.min(1, ((px0 - x0) * (x1 - x0) + (py0 - y0) * (y1 - y0)) / (len * len)));
      const d = Math.hypot(px0 - (x0 + t * (x1 - x0)), py0 - (y0 + t * (y1 - y0))) - w / 2;
      const a = Math.max(0, Math.min(1, 0.5 - d));
      if (a > 0) blend(x, y, a);
    }
  };
  /** @param {number} x @param {number} y @param {number} a */
  const blend = (x, y, a) => {
    const i = (y * size + x) * 4;
    const prev = px[i + 3] / 255;
    const out = a + prev * (1 - a);
    px[i] = rgb[0]; px[i + 1] = rgb[1]; px[i + 2] = rgb[2]; px[i + 3] = Math.round(out * 255);
  };
  const A = [4 * s, 12 * s], B = [12 * s, 12 * s], C = [8 * s, 4 * s];
  line(A[0], A[1], B[0], B[1], 1.6 * s); line(A[0], A[1], C[0], C[1], 1.6 * s); line(B[0], B[1], C[0], C[1], 1.6 * s);
  disc(A[0], A[1], 2.2 * s); disc(B[0], B[1], 2.2 * s); disc(C[0], C[1], 2.2 * s);

  // PNG encode (8-bit RGBA, filter 0 per scanline).
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) { raw[y * (size * 4 + 1)] = 0; px.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4); }
  const crcTable = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  /** @param {Buffer} buf */
  const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  /** @param {string} type @param {Buffer} data */
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

function makeTrayIcon() {
  const mac = process.platform === "darwin";
  const rgb = /** @type {[number,number,number]} */ (mac ? [0, 0, 0] : [255, 255, 255]);
  const img = nativeImage.createFromBuffer(makeIconPng(16, rgb), { scaleFactor: 1 });
  img.addRepresentation({ scaleFactor: 2, buffer: makeIconPng(32, rgb) });
  if (mac) img.setTemplateImage(true); // black-on-transparent → auto light/dark in the menu bar
  return img;
}

// ---- app ----
/** @type {BrowserWindow | undefined} */ let win;
/** @type {Tray | undefined} */ let tray;
/** @type {string} */ let roomUrl = "";
/** @type {string} */ let overlayUrl = "";
let quitting = false;

function showWindow() {
  if (!win) return;
  if (process.platform === "darwin") win.setAlwaysOnTop(true, "floating");
  win.showInactive(); // never steal focus from the editor / terminal
}
function toggleWindow() {
  if (!win) return;
  if (win.isVisible()) win.hide(); else showWindow();
}

function saveBounds() {
  if (!win || win.isDestroyed()) return;
  const b = win.getBounds();
  if (b.width < COLLAPSED_MAX || b.height < COLLAPSED_MAX) return; // don't remember the collapsed widget size
  writeTrayState(b);
}

/** Resize keeping the bottom-right corner where it is (the panel lives in the corner). Called by the page via
 * window.meshResize(w, h) (preload + ipc); window.resizeTo is shimmed onto it in the page's main world.
 * @param {number} w @param {number} h */
function resizeAnchored(w, h) {
  if (!win || win.isDestroyed()) return win?.getBounds();
  const width = Math.max(MIN_SIZE.width, Math.round(w)), height = Math.max(MIN_SIZE.height, Math.round(h));
  const b = win.getBounds();
  const next = { x: b.x + b.width - width, y: b.y + b.height - height, width, height };
  win.setBounds(next, false);
  const got = win.getBounds();
  console.log(`[tray] resize ${b.width}x${b.height} → ${got.width}x${got.height} bounds=${JSON.stringify(got)}`);
  return got;
}

function buildTrayMenu() {
  const visible = win?.isVisible() ?? false;
  return Menu.buildFromTemplate([
    { label: visible ? "Hide overlay" : "Show overlay", click: toggleWindow },
    { label: "Open room page", click: () => void shell.openExternal(roomUrl) },
    { label: "Reload", click: () => win?.webContents.reload() },
    { type: "separator" },
    { label: `${overlayUrl}`, enabled: false },
    { type: "separator" },
    { label: "Quit", click: () => { quitting = true; app.quit(); } },
  ]);
}

async function createWindow() {
  const cfg = readJoinConfig();
  const origin = httpOrigin(cfg.relay);
  roomUrl = `${origin}/r/${encodeURIComponent(cfg.room)}`;
  const candidate = `${origin}/overlay?room=${encodeURIComponent(cfg.room)}&port=${cfg.port}`;
  const hasOverlay = await urlExists(candidate);
  overlayUrl = hasOverlay ? candidate : roomUrl;
  if (!hasOverlay) console.log(`[tray] ${origin}/overlay not available yet; falling back to ${roomUrl}`);

  // ngrok interstitial bypass for every request from this session.
  session.defaultSession.webRequest.onBeforeSendHeaders((details, cb) => {
    cb({ requestHeaders: { ...details.requestHeaders, "ngrok-skip-browser-warning": "1" } });
  });

  const saved = readTrayState();
  const size = { width: saved.width ?? DEFAULT_SIZE.width, height: saved.height ?? DEFAULT_SIZE.height };
  const pos = saved.x != null && saved.y != null && onScreen({ x: saved.x, y: saved.y, ...size }) ? { x: saved.x, y: saved.y } : defaultPosition(size);

  /** @type {Electron.BrowserWindowConstructorOptions} */
  const glass = MAC
    ? { transparent: true, backgroundColor: "#00000000", vibrancy: "hud", visualEffectState: "active", roundedCorners: true, hasShadow: true, titleBarStyle: "hidden" }
    : WIN
      ? { transparent: false, backgroundColor: "#1c1c1e", backgroundMaterial: "acrylic", roundedCorners: true, hasShadow: true }
      : { transparent: false, backgroundColor: "#1c1c1e", hasShadow: true };

  win = new BrowserWindow({
    ...size, ...pos,
    minWidth: MIN_SIZE.width, minHeight: MIN_SIZE.height,
    frame: false,
    resizable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: true,
    show: false,
    title: "mesh",
    ...glass,
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  if (MAC) {
    win.setAlwaysOnTop(true, "floating");
    // 'hud' exists since Electron 12; if a future/older build rejects it, fall back to 'under-window'.
    try { win.setVibrancy("hud"); } catch { try { win.setVibrancy("under-window"); } catch { /* no vibrancy */ } }
  }
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.setMenuBarVisibility(false);

  // Closing hides; the tray keeps the app alive.
  win.on("close", (e) => { if (!quitting) { e.preventDefault(); win?.hide(); tray?.setContextMenu(buildTrayMenu()); } });
  win.on("moved", saveBounds);
  win.on("resized", saveBounds);
  win.on("show", () => tray?.setContextMenu(buildTrayMenu()));
  win.on("hide", () => tray?.setContextMenu(buildTrayMenu()));
  // Links that open new windows go to the system browser instead.
  win.webContents.setWindowOpenHandler(({ url }) => { void shell.openExternal(url); return { action: "deny" }; });

  win.webContents.on("did-finish-load", () => {
    console.log(`[tray] loaded ${win?.webContents.getURL()} bounds=${JSON.stringify(win?.getBounds())}`);
    // Electron ignores window.resizeTo/resizeBy on windows not opened by script; route them to meshResize.
    void win?.webContents.executeJavaScript(
      `(() => { if (typeof window.meshResize === "function") {
         window.resizeTo = (w, h) => { window.meshResize(w, h); };
         window.resizeBy = (dw, dh) => { window.meshResize(window.outerWidth + dw, window.outerHeight + dh); };
       } })();`, true).catch(() => {});
  });
  win.webContents.on("did-fail-load", (_e, code, desc, url) => console.error(`[tray] failed to load ${url}: ${code} ${desc}`));

  await win.loadURL(overlayUrl);
  showWindow();
}

/** @param {number} ms */ const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Capture the window to <out>; returns "WxH". @param {string} out */
async function capture(out) {
  if (!win) throw new Error("no window");
  const img = await win.webContents.capturePage();
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, img.toPNG());
  return `${img.getSize().width}x${img.getSize().height}`;
}

async function smoke() {
  const out = process.env.TRAY_SMOKE_SCREENSHOT || path.join(process.cwd(), "screenshot.png");
  const collapsedOut = out.replace(/\.png$/i, "") + "-collapsed.png";
  try {
    if (!win) throw new Error("no window");
    const wc = win.webContents;
    const before = win.getBounds();
    const right = before.x + before.width, bottom = before.y + before.height;
    console.log(`[tray] smoke: url=${wc.getURL()} bounds=${JSON.stringify(before)} shot=${await capture(out)} → ${out}`);

    // Page-initiated collapse via the shimmed window.resizeTo (→ preload meshResize → ipc → setBounds).
    await wc.executeJavaScript("window.resizeTo(72, 72); typeof window.meshResize", true);
    await sleep(600);
    const small = win.getBounds();
    const anchored = small.x + small.width === right && small.y + small.height === bottom;
    console.log(`[tray] smoke: collapsed bounds=${JSON.stringify(small)} anchoredBottomRight=${anchored} shot=${await capture(collapsedOut)} → ${collapsedOut}`);
    if (small.width !== 72 || small.height !== 72 || !anchored) throw new Error(`collapse failed: ${JSON.stringify(small)}`);

    // Expand back through the exposed API directly.
    await wc.executeJavaScript("window.meshResize(360, 520)", true);
    await sleep(600);
    const big = win.getBounds();
    const reAnchored = big.x + big.width === right && big.y + big.height === bottom;
    console.log(`[tray] smoke: expanded bounds=${JSON.stringify(big)} anchoredBottomRight=${reAnchored} visible=${win.isVisible()} focused=${win.isFocused()}`);
    if (big.width !== 360 || big.height !== 520 || !reAnchored) throw new Error(`expand failed: ${JSON.stringify(big)}`);
    quitting = true; app.exit(0);
  } catch (e) {
    console.error(`[tray] smoke failed: ${/** @type {Error} */ (e).message}`);
    quitting = true; app.exit(1);
  }
}

ipcMain.handle("mesh:resize", (_e, /** @type {{width:number;height:number}} */ { width, height }) => resizeAnchored(width, height));

app.whenReady().then(async () => {
  if (MAC) app.dock.hide(); // menu-bar-only (LSUIElement-style)
  tray = new Tray(makeTrayIcon());
  tray.setToolTip("mesh overlay");
  tray.setContextMenu(buildTrayMenu());
  tray.on("click", toggleWindow);
  try {
    await createWindow();
  } catch (e) {
    console.error(`[tray] ${/** @type {Error} */ (e).message}\nRun \`mesh join <room> --relay <url>\` first so ~/.mesh/config.json exists.`);
    if (SMOKE) app.exit(1);
    return;
  }
  tray.setContextMenu(buildTrayMenu());
  if (SMOKE) setTimeout(() => void smoke(), SMOKE_MS);
});

// Keep running with no windows (tray app); macOS also fires this when the last window hides.
app.on("window-all-closed", () => { /* stay alive */ });
app.on("before-quit", () => { quitting = true; });
