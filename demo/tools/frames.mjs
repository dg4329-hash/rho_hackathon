// Capture frames of one scene: SCENE=5 node tools/frames.mjs [times in seconds...]  → demo/tools/out/s5-<t>.png
// Needs the local server: python3 -m http.server 4173 (already running on http://localhost:4173).
import { createRequire } from "node:module"; import fs from "node:fs";
const require = createRequire("/Users/devgadde/.npm/_npx/9833c18b2d85bc59/node_modules/");
const { chromium } = require("playwright-core");
const scene = process.env.SCENE; const times = process.argv.slice(2).map(Number); if (!times.length) times.push(2, 6, 10, 14, 18);
const out = new URL("./out/", import.meta.url).pathname; fs.mkdirSync(out, { recursive: true });
const b = await chromium.launch({ headless: true, executablePath: `${process.env.HOME}/Library/Caches/ms-playwright/chromium-1243/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing` });
const p = await b.newPage({ viewport: { width: 1280, height: 720 } });
const errs = []; p.on("pageerror", e => errs.push(e.message));
const t0 = Date.now(); await p.goto(`http://localhost:4173/index.html?autoplay=1&scene=${scene}&v=${Date.now()}`);
for (const t of times.sort((a, b) => a - b)) { await p.waitForTimeout(Math.max(0, t * 1000 - (Date.now() - t0))); await p.screenshot({ path: `${out}s${scene}-${t}.png` }); }
console.log("frames in", out, "errors:", errs); await b.close();
