# mesh product film: shared brief for every scene agent

The film plays right after a 1-minute live pitch. It is **6 scenes × 20 s = 2:00**. It must look like a professional product launch ad (Apple / Linear / Vercel-launch quality): big confident type, generous whitespace, one idea per moment, smooth choreographed motion, depth (soft shadows, subtle parallax / scale), no clutter, no placeholder-looking UI, no text smaller than 14px, nothing pops without easing. It must also **reflect our real product UI**.

## Contract (do not change)
File `demo/sceneN.js`, loaded as a plain <script> (no modules, no libraries, no build):
```js
(window.MESH_SCENES = window.MESH_SCENES || []).push({
  id: N, title: "…", duration: 20000,
  mount(root) { /* root = empty 1280x720 div (position absolute, overflow hidden). Build DOM, inject ONE <style> with classes prefixed .sN- . Drive the timeline with setTimeout + CSS transitions/keyframes or element.animate(). */ return () => { /* clear ALL timeouts/intervals/animations */ }; }
});
```
- Everything must finish its story by ~19 s (the shell crossfades 0.7 s into the next scene).
- A caption chip in the top-left like `02 · Your agent finds the right machine` (blue number, grey text), consistent across scenes 2-6. Scene 1 has none.
- Fonts: `-apple-system, BlinkMacSystemFont, "SF Pro Display", "Inter", system-ui, sans-serif`; mono `"SF Mono", SFMono-Regular, Menlo, monospace`. Icons: inline SVG (no icon fonts, no network).
- Easing: `cubic-bezier(.2,.8,.2,1)` for entrances, `cubic-bezier(.4,0,.2,1)` for moves.

## Real UI to reflect (read these, copy their look: tokens, radii, card/pill styles, copy)
- `website/index.html` (Abhi's site): design tokens (`--label`, `--label-2`, `--accent-text`, `--surface-2`, `--separator`, radii), sections, and the **Figma file handoff** component (`.handoff`, `.handoff-file`, thumb + `step-2.png` + `1440×900 · 214 KB` + progress bar + status "ready to send" → delivered in green).
- `apps/relay/src/overlay.ts`: the always-on-top popup (header `m mesh · room`, PENDING with count badge, request card with Approve/Deny, MESSAGES with reply box, LIVE feed, footer with daemon/relay status dots and the approvals control). Its CSS is inside the TS string; read the current version.
- `apps/relay/src/web.ts`: the front door ("Start a session"), the room page (room name, shareable link, OS tabs + one-line installer, members, live feed, End session).
Palette baseline: bg #f5f5f7, surface #fff, label #1d1d1f, label-2 #6e6e73, accent #0071e3 / accent-text #0066cc, green #30d158 (#248a3d text), red #ff3b30, orange #ff9f0a; terminals #1c1c1e. Prefer the exact tokens you find in website/index.html.

## Story facts (keep consistent across scenes)
- People: **Dev** (macOS, Claude Code, has Playwright + Files), **Tarush** (Windows, has **Figma** + **Supabase**; FIGMA_TOKEN lives only on his laptop), **Abhi** (macOS, has **Vercel** deploy).
- Room `tango-bc7d92eb`, relay `relay-production-8eef.up.railway.app`.
- Tools are real mesh MCP tools: `list_teammates`, `describe_capability`, `ask_teammate`, `approve_request`, `send_message`, `send_file` / `fetch_artifact`, `end_session`, `leave_room`.
- Task: "Implement onboarding step 2 to match the Figma frame Onboarding/Step-2". Tarush runs `figma-export.sh "Onboarding/Step-2"`.
- Tagline: "Borrow a teammate's machine, not their credentials."

## Quality loop (required)
A local server runs at http://localhost:4173. After writing, capture frames of your scene:
`cd /Users/devgadde/Desktop/StartupProjects/rho_hackathon/demo && SCENE=N node tools/frames.mjs 1.5 4 7 10 13 16 19`
Then **Read the PNGs** in `demo/tools/out/` and fix anything that looks cheap, overlapping, clipped, empty, too small, or off-brand. Do at least 2 review passes. Fix any page errors the tool prints. Only touch your own scene file.

## Logo (required — never use a letter "m")
The mesh logo is **three dots connected by lines** (from website/index.html `.brand-mark`). Use exactly this SVG (stroke = currentColor), inside a rounded square mark (background #1d1d1f with white strokes on light scenes, or white on dark), wordmark "mesh" beside it in 600 weight:
<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="3.5" cy="4" r="2"/><circle cx="12.5" cy="4" r="2"/><circle cx="8" cy="12.5" r="2"/><path d="M5.5 4h5M4.6 5.8l2.3 5M11.4 5.8l-2.3 5"/></svg>
</span>
Mark style from the site: `.brand-mark { width:26px; height:26px; border-radius:7px; display:grid; place-items:center; background: var(--label); color: var(--bg) } .brand-mark svg { width:16px; height:16px }` — scale it up proportionally for hero moments (e.g. 88px mark, 54px svg).
