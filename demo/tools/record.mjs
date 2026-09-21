// Record the full film (silent) at 1920x1080 via headless Chrome → demo/render/film-raw.webm
import { createRequire } from "node:module"; import fs from "node:fs";
const require = createRequire("/Users/devgadde/.npm/_npx/9833c18b2d85bc59/node_modules/");
const { chromium } = require("playwright-core");
const dir = new URL("../render/", import.meta.url).pathname;
const b = await chromium.launch({ headless: true, args: ["--force-device-scale-factor=1"], executablePath: `${process.env.HOME}/Library/Caches/ms-playwright/chromium-1243/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing` });
const ctx = await b.newContext({ viewport: { width: 1920, height: 1080 }, recordVideo: { dir, size: { width: 1920, height: 1080 } } });
const p = await ctx.newPage();
const t0 = Date.now();
await p.goto(`http://localhost:4173/index.html?autoplay=1&v=${Date.now()}`);
await p.evaluate(() => { const c = document.getElementById("chrome"); if (c) c.style.display = "none"; });
fs.writeFileSync(dir + "offset.txt", String((Date.now() - t0) / 1000));
await p.waitForTimeout(121500);
await ctx.close(); await b.close();
const vid = fs.readdirSync(dir).filter(f => f.endsWith(".webm")).map(f => dir + f).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
fs.renameSync(vid, dir + "film-raw.webm"); console.log("recorded", dir + "film-raw.webm");
