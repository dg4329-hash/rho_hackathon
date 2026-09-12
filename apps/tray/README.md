# tray — native always-on-top shell for the mesh overlay

A tiny Electron app that hosts the relay's overlay page (`/overlay?room=…&port=…`) in a frameless,
always-on-top 360×520 panel with a menu-bar / tray icon. Cluely-style floating panel for Codex, Cursor
and Claude Code users, no browser needed. It contains no UI of its own: everything you see is the page
the relay serves (contract in `docs/OVERLAY-API.md`).

## Run

```sh
mesh join <room> --relay wss://…    # writes ~/.mesh/config.json {room, relay, user, port}
pnpm -F tray start                  # opens the panel bottom-right, adds a tray icon
```

`pnpm -F tray smoke` (or `electron . --smoke`) loads the page, waits 5 s, writes a screenshot
(`$TRAY_SMOKE_SCREENSHOT` or `./screenshot.png`), then collapses the page via `window.resizeTo(72, 72)`,
asserts the window is 72×72 and still bottom-right-anchored, writes `<name>-collapsed.png`, expands back via
`window.meshResize(360, 520)`, logs URL + bounds + focus state, and exits non-zero on any failure — for CI.

To test against a local relay without touching your real config:

```sh
PORT=8092 pnpm -F relay start &
mkdir -p /tmp/trayhome/.mesh && echo '{"room":"demo","relay":"ws://localhost:8092","user":"me","port":7337}' > /tmp/trayhome/.mesh/config.json
HOME=/tmp/trayhome pnpm -F tray smoke
```

## What it does

- Reads `~/.mesh/config.json`; derives the relay's HTTP origin from the ws URL (`wss→https`, `ws→http`).
- Probes `<origin>/overlay` (HEAD, then GET); on 404 falls back to the room page `<origin>/r/<room>`.
- Window: 360×520, frameless, `alwaysOnTop` (`floating` level on macOS), visible on all workspaces incl.
  fullscreen spaces, `skipTaskbar`, resizable.
- Liquid-glass look. macOS: `transparent: true`, `backgroundColor: '#00000000'`, `vibrancy: 'hud'` (falls back
  to `'under-window'`), `visualEffectState: 'active'` (blur stays live even though the window is never focused),
  `roundedCorners`, `hasShadow`. Windows: `backgroundMaterial: 'acrylic'` (Win 11) over a solid `#1c1c1e`
  fallback. Linux: solid `#1c1c1e`. The overlay page must leave its `html/body` background transparent and use
  `backdrop-filter` for its own panels so the OS blur shows through. Positioned bottom-right of the primary display
  with a 16 px margin; position/size persisted to `~/.mesh/tray.json` (ignored if off-screen).
- Never steals focus: the window is shown with `showInactive()`.
- Adds `ngrok-skip-browser-warning: 1` to every request (`session.webRequest.onBeforeSendHeaders`) so
  ngrok's interstitial never appears.
- Tray icon (generated at runtime as a 16/32 px PNG; a template image on macOS so it follows light/dark)
  with a menu: Show/Hide overlay, Open room page (system browser), Reload, Quit. Clicking the icon toggles
  the window. Closing the window hides it; the app keeps running until Quit.
- macOS: dock icon hidden (`app.dock.hide()`, LSUIElement-style). Windows/Linux: normal tray behaviour.
- `window.open` / target=_blank links from the page open in the system browser.

## Page → window API (for the overlay page)

Electron ignores `window.resizeTo()` on windows that were not opened by script, so the tray injects a
preload (`preload.js`) that exposes:

```js
window.meshResize(width, height)   // Promise<{x,y,width,height}> — resizes keeping the bottom-right corner anchored
window.meshTray                    // { platform: 'darwin'|'win32'|'linux', version: '<electron version>' }
```

`main.js` also shims `window.resizeTo`/`resizeBy` onto `meshResize` after load, so plain `resizeTo(72, 72)` works
inside the tray too. The overlay should still prefer the explicit form so it degrades cleanly in a browser popup:

```js
const resize = (w, h) => (window.meshResize || window.resizeTo).call(window, w, h);
resize(72, 72);    // collapse to widget
resize(360, 520);  // expand
```

Minimum size is 72×72. Collapsed sizes (< 200 px) are never persisted to `~/.mesh/tray.json`; the panel
always reopens expanded. `window.meshTray` is `undefined` outside the tray, so the page can feature-detect it.

## Files

- `main.js` — main process (plain JS with `// @ts-check`; `pnpm -F tray typecheck`).
- `preload.js` — sandboxed preload exposing `window.meshResize` / `window.meshTray`.
- `package.json`, `tsconfig.json`.

## Packaging (not set up yet)

There is no installer/bundle yet: `pnpm -F tray start` runs the dev Electron binary. Next step is
`electron-builder` (or `@electron/packager`) with `mac.extendInfo.LSUIElement: true`, a real `.icns`, and
code-signing/notarization; add it as a devDependency of `apps/tray` only.

## pnpm note

pnpm 10 blocks dependency postinstall scripts by default; Electron needs its `install.js` to download the
binary. The repo's `pnpm-workspace.yaml` lists `electron` under `onlyBuiltDependencies`, so a plain
`pnpm install` works. If the binary is ever missing, run `pnpm -F tray rebuild electron`.
