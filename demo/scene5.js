(window.MESH_SCENES = window.MESH_SCENES || []).push({
  id: 5, title: "Share MCPs, not seats", duration: 20000,
  mount(root) {
    // NOTE: class prefix is .s5b- because scene6.js already ships .s5- rules; both are mounted during the crossfade.
    const timers = [], anims = [];
    const at = (ms, fn) => timers.push(setTimeout(fn, ms));
    const E = "cubic-bezier(.2,.8,.2,1)", M = "cubic-bezier(.4,0,.2,1)";
    const SANS = '-apple-system,BlinkMacSystemFont,"SF Pro Display","Inter",system-ui,sans-serif';
    const MONO = '"SF Mono",SFMono-Regular,Menlo,monospace';
    const LOGO = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="3.5" cy="4" r="2"/><circle cx="12.5" cy="4" r="2"/><circle cx="8" cy="12.5" r="2"/><path d="M5.5 4h5M4.6 5.8l2.3 5M11.4 5.8l-2.3 5"/></svg>';

    const css = `
.s5b-root{position:absolute;inset:0;background:#f5f5f7;color:#1d1d1f;font-family:${SANS};overflow:hidden;-webkit-font-smoothing:antialiased}
.s5b-cap{position:absolute;left:44px;top:34px;font-size:15px;font-weight:600;letter-spacing:.02em;color:#6e6e73;opacity:0;transform:translateY(-6px);transition:all .7s ${E};z-index:5}
.s5b-cap b{color:#0071e3;font-weight:600}
.s5b-cap.on{opacity:1;transform:none}
.s5b-h{position:absolute;left:0;right:0;top:66px;text-align:center;font-size:42px;font-weight:700;letter-spacing:-.025em;opacity:0;transform:translateY(14px);transition:opacity .7s ${E},transform .7s ${E}}
.s5b-h span{color:#6e6e73}
.s5b-h.on{opacity:1;transform:none}
.s5b-h.off{opacity:0;transform:translateY(-12px);transition:opacity .45s ${M},transform .45s ${M}}
.s5b-fade{opacity:0;transform:translateY(16px) scale(.98);transition:opacity .6s ${E},transform .6s ${E}}
.s5b-fade.on{opacity:1;transform:none}
.s5b-fade.off{opacity:0;transform:translateY(-8px) scale(.98);transition:opacity .45s ${M},transform .45s ${M}}
/* before: team grid */
.s5b-card{position:absolute;width:204px;height:196px;box-sizing:border-box;background:#fff;border-radius:16px;box-shadow:0 1px 2px rgba(0,0,0,.04),0 10px 30px rgba(0,0,0,.06);border:1px solid rgba(0,0,0,.05)}
.s5b-who{position:absolute;left:14px;top:12px;right:14px;display:flex;align-items:center;gap:10px}
.s5b-av{width:32px;height:32px;border-radius:50%;color:#fff;display:grid;place-items:center;font-size:14px;font-weight:700;flex:none}
.s5b-nm{font-size:15px;font-weight:600}
.s5b-rl{font-size:14px;color:#86868b;margin-left:auto}
.s5b-pill{position:absolute;width:176px;height:28px;box-sizing:border-box;border-radius:8px;background:#f5f5f7;display:flex;align-items:center;gap:7px;padding:0 5px 0 8px;font-size:14px;font-weight:500;opacity:0;transform:translateY(8px) scale(.96);transition:opacity .4s ${E},transform .4s ${E};z-index:3;will-change:transform}
.s5b-pill.on{opacity:1;transform:none}
.s5b-pill svg{width:14px;height:14px;flex:none}
.s5b-seat{margin-left:auto;font-size:14px;font-weight:600;color:#b25000;background:#fff1de;border-radius:6px;padding:1px 6px;line-height:20px}
.s5b-counter{position:absolute;left:0;right:0;top:590px;display:flex;justify-content:center;z-index:4}
.s5b-cbox{display:flex;align-items:center;gap:16px;background:#fff;border-radius:999px;padding:10px 26px 10px 12px;box-shadow:0 1px 2px rgba(0,0,0,.04),0 12px 34px rgba(0,0,0,.08);border:1px solid rgba(0,0,0,.05)}
.s5b-cic{width:40px;height:40px;border-radius:50%;background:#fff1de;display:grid;place-items:center;transition:background .5s}
.s5b-cic svg{width:22px;height:22px}
.s5b-clab{font-size:16px;font-weight:600;color:#6e6e73}
.s5b-num{font-size:34px;font-weight:700;letter-spacing:-.02em;font-variant-numeric:tabular-nums;min-width:48px;color:#b25000;transition:color .4s}
.s5b-old{font-size:26px;font-weight:600;color:#86868b;text-decoration:line-through;text-decoration-thickness:2px;max-width:0;overflow:hidden;opacity:0;white-space:nowrap;transition:max-width .6s ${E},opacity .5s}
.s5b-old.on{max-width:120px;opacity:1}
.s5b-note{font-size:14px;color:#86868b;border-left:1px solid rgba(0,0,0,.1);padding-left:16px}
.s5b-counter.good .s5b-num{color:#248a3d}
.s5b-counter.good .s5b-cic{background:#e8f7ec}
/* with mesh */
.s5b-net{position:absolute;inset:0;pointer-events:none}
.s5b-line{fill:none;stroke:#0071e3;stroke-opacity:.45;stroke-width:1.5;stroke-dasharray:500;stroke-dashoffset:500;transition:stroke-dashoffset .9s ${E}}
.s5b-line.on{stroke-dashoffset:0}
.s5b-flow{fill:none;stroke:#0071e3;stroke-width:2.5;stroke-linecap:round;stroke-dasharray:2 14;opacity:0;transition:opacity .5s;animation:s5bdash 1.1s linear infinite}
.s5b-flow.on{opacity:.8}
@keyframes s5bdash{to{stroke-dashoffset:-32}}
.s5b-hub{position:absolute;left:560px;top:214px;width:160px;display:flex;flex-direction:column;align-items:center;gap:10px;opacity:0;transform:scale(.85);transition:opacity .6s ${E},transform .7s ${E}}
.s5b-hub.on{opacity:1;transform:none}
.s5b-mark{width:84px;height:84px;border-radius:22px;background:#1d1d1f;color:#fff;display:grid;place-items:center;box-shadow:0 18px 44px rgba(0,0,0,.22)}
.s5b-mark svg{width:50px;height:50px}
.s5b-word{font-size:22px;font-weight:600;letter-spacing:-.01em}
.s5b-own{position:absolute;width:330px;height:88px;box-sizing:border-box;background:#fff;border-radius:16px;border:1px solid rgba(0,0,0,.05);box-shadow:0 1px 2px rgba(0,0,0,.04),0 14px 36px rgba(0,0,0,.08);display:flex;align-items:center;gap:14px;padding:0 16px;opacity:0;transform:scale(.9);transition:opacity .5s ${E},transform .6s ${E}}
.s5b-own.on{opacity:1;transform:none}
.s5b-own.hit{animation:s5bhit .6s ${E}}
@keyframes s5bhit{40%{transform:scale(1.035);box-shadow:0 0 0 6px rgba(0,113,227,.12),0 14px 36px rgba(0,0,0,.08)}}
.s5b-oic{width:48px;height:48px;border-radius:13px;background:#f5f5f7;display:grid;place-items:center;flex:none;position:relative}
.s5b-oic svg{width:24px;height:24px}
.s5b-dev{position:absolute;right:-4px;bottom:-4px;width:20px;height:20px;border-radius:6px;background:#1d1d1f;display:grid;place-items:center}
.s5b-dev svg{width:12px;height:12px}
.s5b-ot{font-size:16px;font-weight:600;line-height:1.25}
.s5b-os{font-size:14px;color:#6e6e73;margin-top:3px;display:flex;align-items:center;gap:5px}
.s5b-os svg{width:13px;height:13px}
.s5b-one{margin-left:auto;font-size:14px;font-weight:600;color:#248a3d;background:#e8f7ec;border-radius:7px;padding:3px 8px;white-space:nowrap}
.s5b-team{position:absolute;left:0;right:0;top:444px;display:flex;flex-wrap:wrap;justify-content:center;gap:12px 16px;width:1010px;margin:0 auto}
.s5b-mate{display:flex;align-items:center;gap:8px;background:#fff;border-radius:999px;padding:5px 12px 5px 5px;border:1px solid rgba(0,0,0,.05);box-shadow:0 1px 2px rgba(0,0,0,.03),0 8px 20px rgba(0,0,0,.05);opacity:0;transform:translateY(12px);transition:opacity .5s ${E},transform .5s ${E}}
.s5b-mate.on{opacity:1;transform:none}
.s5b-mate .s5b-av{width:30px;height:30px}
.s5b-chip{font-size:14px;font-weight:500;color:#0066cc;background:#f0f6ff;border-radius:999px;padding:3px 10px;white-space:nowrap}
.s5b-chip i{font-style:normal;color:#248a3d}
/* use cases */
.s5b-grid{position:absolute;left:76px;top:176px;width:1128px;display:grid;grid-template-columns:repeat(3,1fr);gap:22px}
.s5b-tile{background:#fff;border-radius:22px;border:1px solid rgba(0,0,0,.05);box-shadow:0 1px 2px rgba(0,0,0,.04),0 14px 40px rgba(0,0,0,.07);padding:24px 24px 22px;height:196px;box-sizing:border-box;opacity:0;transform:translateY(26px) scale(.98);transition:opacity .7s ${E},transform .7s ${E}}
.s5b-tile.on{opacity:1;transform:none}
.s5b-tile.off{opacity:0;transform:translateY(-10px) scale(.98);transition:opacity .45s ${M},transform .45s ${M}}
.s5b-tic{width:46px;height:46px;border-radius:13px;background:#eaf3ff;color:#0071e3;display:grid;place-items:center;margin-bottom:16px}
.s5b-tic svg{width:26px;height:26px}
.s5b-tt{font-size:20px;font-weight:650;font-weight:600;letter-spacing:-.01em;line-height:1.2}
.s5b-td{font-size:15px;color:#6e6e73;line-height:1.4;margin-top:6px}
.s5b-foot{position:absolute;left:0;right:0;top:612px;text-align:center;font-size:15px;color:#86868b}
/* end line */
.s5b-end{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:0}
.s5b-end .s5b-mark{width:72px;height:72px;border-radius:19px}
.s5b-end .s5b-mark svg{width:42px;height:42px}
.s5b-l1,.s5b-l2{font-size:56px;font-weight:700;letter-spacing:-.03em;line-height:1.1;opacity:0;transform:translateY(18px);transition:opacity .8s ${E},transform .8s ${E}}
.s5b-l1{margin-top:34px}
.s5b-l2{color:#6e6e73}
.s5b-l1.on,.s5b-l2.on{opacity:1;transform:none}
.s5b-l2 b{color:#1d1d1f;font-weight:700}
`;

    const TOOLS = {
      figma: '<svg viewBox="0 0 12 18"><path fill="#f24e1e" d="M3 0h3v6H3a3 3 0 010-6z"/><path fill="#ff7262" d="M6 0h3a3 3 0 010 6H6z"/><path fill="#a259ff" d="M3 6h3v6H3a3 3 0 010-6z"/><circle fill="#1abcfe" cx="9" cy="9" r="3"/><path fill="#0acf83" d="M3 12h3v3a3 3 0 11-3-3z"/></svg>',
      supabase: '<svg viewBox="0 0 24 24"><path fill="#3ecf8e" d="M13.6 2.3c-.4-.5-1.3-.2-1.3.5v8.5H4.1c-.9 0-1.4 1-.8 1.7l8.9 9c.5.5 1.3.2 1.3-.5v-8.5h8.3c.9 0 1.4-1 .8-1.7z"/></svg>',
      datadog: '<svg viewBox="0 0 24 24"><rect x="2" y="2" width="20" height="20" rx="5" fill="#632ca6"/><path d="M7 15.5c1.8-.6 3-2 3.6-4 .5 1.6 1.7 2.6 3.4 2.6M9.4 9.2h.01M14.8 9.2h.01" stroke="#fff" stroke-width="2" stroke-linecap="round" fill="none"/></svg>',
      linear: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" fill="#5e6ad2"/><path d="M5.5 13.5l5 5M5 10l9 9M6.8 6.8l10.4 10.4" stroke="#fff" stroke-width="1.6" stroke-linecap="round"/></svg>',
    };
    const NAMES = { figma: "Figma", supabase: "Supabase", datadog: "Datadog", linear: "Linear" };
    const ORDER = ["figma", "supabase", "datadog", "linear"];
    const PEOPLE = [
      ["Dev", "#0071e3", "#64d2ff"], ["Tarush", "#bf5af2", "#ff6482"], ["Abhi", "#ff9f0a", "#ff375f"], ["Priya", "#30b0c7", "#34c759"], ["Sam", "#5e5ce6", "#0a84ff"],
      ["Maya", "#ff375f", "#ff9f0a"], ["Leo", "#34c759", "#30b0c7"], ["Nina", "#ac8e68", "#ff9f0a"], ["Omar", "#0a84ff", "#5e5ce6"], ["Kai", "#8e8e93", "#48484a"],
    ];
    const av = (p) => `<div class="s5b-av" style="background:linear-gradient(135deg,${p[1]},${p[2]})">${p[0][0]}</div>`;
    const LAPTOP = '<svg viewBox="0 0 16 16" fill="none" stroke="#fff" stroke-width="1.6"><rect x="3" y="3.5" width="10" height="7" rx="1"/><path d="M1.5 12.5h13"/></svg>';
    const LOCK = '<svg viewBox="0 0 16 16" fill="none" stroke="#b25000" stroke-width="1.7" stroke-linecap="round"><rect x="3.5" y="7" width="9" height="7" rx="1.6"/><path d="M5.5 7V5a2.5 2.5 0 015 0v2"/></svg>';

    const style = document.createElement("style");
    style.textContent = css;
    root.appendChild(style);
    const wrap = document.createElement("div");
    wrap.className = "s5b-root";
    root.appendChild(wrap);
    const el = (cls, html, parent = wrap) => { const d = document.createElement("div"); d.className = cls; if (html != null) d.innerHTML = html; parent.appendChild(d); return d; };
    const on = (e) => e && e.classList.add("on");
    const off = (e) => { if (!e) return; e.classList.add("off"); };

    const cap = el("s5b-cap", "<b>04</b> · Share MCP servers, not seats");
    const h1 = el("s5b-h", "Every agent wants its own seat.");
    const h2 = el("s5b-h", "With mesh: one owner per tool.");
    const h3 = el("s5b-h", "What teams use it for.");

    // ---- BEFORE: team grid ----
    const CW = 204, GX = 20, X0 = 90, Y0 = 146, RH = 214;
    const cards = [], pills = [];
    PEOPLE.forEach((p, i) => {
      const r = Math.floor(i / 5), c = i % 5;
      const x = X0 + c * (CW + GX), y = Y0 + r * RH;
      const card = el("s5b-card s5b-fade", `<div class="s5b-who">${av(p)}<div class="s5b-nm">${p[0]}</div><div class="s5b-rl">agent</div></div>`);
      card.style.left = x + "px"; card.style.top = y + "px";
      cards.push(card);
      ORDER.forEach((t, k) => {
        const pill = el("s5b-pill", `${TOOLS[t]}<span>${NAMES[t]}</span><span class="s5b-seat">+1 seat</span>`);
        pill.style.left = x + 14 + "px"; pill.style.top = y + 56 + k * 33 + "px";
        pills.push({ pill, t, x: x + 14, y: y + 56 + k * 33, i, k });
      });
    });

    const counter = el("s5b-counter s5b-fade", `<div class="s5b-cbox"><div class="s5b-cic"><svg viewBox="0 0 24 24" fill="none" stroke="#1d1d1f" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="6" width="18" height="13" rx="2.5"/><path d="M3 10h18M7 15h4"/></svg></div><div class="s5b-clab">Paid seats</div><div class="s5b-old">40</div><div class="s5b-num">0</div><div class="s5b-note">illustrative team of 10</div></div>`);
    const num = counter.querySelector(".s5b-num"), old = counter.querySelector(".s5b-old");

    // ---- WITH MESH ----
    const OWN = {
      figma: { x: 80, y: 180, who: "Tarush's laptop", sub: "Figma · owner" },
      supabase: { x: 80, y: 300, who: "Priya's workstation", sub: `${LOCK}Prod DB · read-only`, ro: true },
      datadog: { x: 870, y: 180, who: "Sam's laptop", sub: "Datadog · owner" },
      linear: { x: 870, y: 300, who: "Maya's Mac", sub: "Linear · owner" },
    };
    const svgNS = "http://www.w3.org/2000/svg";
    const net = document.createElementNS(svgNS, "svg");
    net.setAttribute("class", "s5b-net"); net.setAttribute("viewBox", "0 0 1280 720"); net.setAttribute("width", "1280"); net.setAttribute("height", "720");
    wrap.appendChild(net);
    const paths = [
      "M596 256 C 520 256, 480 224, 410 224", "M596 256 C 520 256, 480 344, 410 344",
      "M684 256 C 760 256, 800 224, 870 224", "M684 256 C 760 256, 800 344, 870 344",
      "M640 348 L 640 436",
    ];
    const lines = [], flows = [];
    paths.forEach((d) => {
      const a = document.createElementNS(svgNS, "path"); a.setAttribute("d", d); a.setAttribute("class", "s5b-line"); net.appendChild(a); lines.push(a);
      const b = document.createElementNS(svgNS, "path"); b.setAttribute("d", d); b.setAttribute("class", "s5b-flow"); net.appendChild(b); flows.push(b);
    });
    const hub = el("s5b-hub", `<div class="s5b-mark">${LOGO}</div><div class="s5b-word">mesh</div>`);
    const owners = {};
    ORDER.forEach((t) => {
      const o = OWN[t];
      const d = el("s5b-own", `<div class="s5b-oic">${TOOLS[t]}<div class="s5b-dev">${LAPTOP}</div></div><div><div class="s5b-ot">${o.who}</div><div class="s5b-os">${o.sub}</div></div><div class="s5b-one">1 seat</div>`);
      d.style.left = o.x + "px"; d.style.top = o.y + "px";
      owners[t] = d;
    });
    const team = el("s5b-team", "");
    const mates = PEOPLE.map((p) => el("s5b-mate", `${av(p)}<span class="s5b-chip">borrow · <i>approve</i></span>`, team));

    // ---- USE CASES ----
    const I = (d) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
    const CASES = [
      [I('<circle cx="9" cy="8" r="3.2"/><path d="M3.5 19a5.5 5.5 0 0111 0"/><path d="M16 11h5"/>'), "Fewer enterprise seats", "Owners keep the seat. Agents borrow it."],
      [I('<rect x="3" y="7" width="13" height="10" rx="2"/><path d="M8 4h11a2 2 0 012 2v8"/><path d="M4 20L20 4"/>'), "No double subscriptions", "One Figma plan. Every agent can reach it."],
      [I('<circle cx="8" cy="12" r="3.5"/><path d="M11.5 12H21M17.5 12v3M20.5 12v2"/><path d="M3 3l18 18"/>'), "Contractors without credentials", "Approved calls, never a token or an invite."],
      [I('<ellipse cx="11" cy="6" rx="7" ry="2.8"/><path d="M4 6v11c0 1.5 3.1 2.8 7 2.8"/><path d="M18 6v4"/><rect x="14" y="15" width="7" height="5.5" rx="1.2"/><path d="M15.5 15v-1.5a2 2 0 014 0V15"/>'), "Read-only prod access, owner-approved", "Every query waits for the owner's click."],
      [I('<rect x="6" y="6" width="12" height="12" rx="2"/><rect x="9.5" y="9.5" width="5" height="5" rx=".8"/><path d="M9 3v3M15 3v3M9 18v3M15 18v3M3 9h3M3 15h3M18 9h3M18 15h3"/>'), "Borrow a teammate's GPU / local model", "Run inference on the box that has the GPU."],
      [I('<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/><path d="M9 10l2 2 4-4"/>'), "Licensed desktop tools, shared safely", "Renders run where the license lives."],
    ];
    const grid = el("s5b-grid", "");
    const tiles = CASES.map(([ic, t, d]) => el("s5b-tile", `<div class="s5b-tic">${ic}</div><div class="s5b-tt">${t}</div><div class="s5b-td">${d}</div>`, grid));
    const foot = el("s5b-foot s5b-fade", "Credentials never leave the owner's machine.");

    // ---- END LINE ----
    const end = el("s5b-end", "");
    const endMark = el("s5b-mark s5b-fade", LOGO, end);
    const l1 = el("s5b-l1", "Pay for the tool once.", end);
    const l2 = el("s5b-l2", "Share the capability, <b>never the key.</b>", end);

    // ================= TIMELINE =================
    at(100, () => on(cap));
    at(250, () => on(h1));
    cards.forEach((c, i) => at(500 + i * 70, () => on(c)));
    at(900, () => on(counter));
    // pills stack up, interleaved by tool row so seats pile up everywhere
    const seq = [];
    ORDER.forEach((_, k) => pills.filter((p) => p.k === k).forEach((p) => seq.push(p)));
    let count = 0;
    seq.forEach((p, n) => at(1300 + n * 88, () => { on(p.pill); count++; num.textContent = count; }));

    // 6.0 s: with mesh
    at(5900, () => { h1.classList.remove("on"); off(h1); });
    at(6200, () => { on(h2); on(hub); });
    at(6000, () => cards.forEach((c) => off(c)));
    at(6150, () => {
      pills.forEach((p, n) => {
        const o = OWN[p.t];
        const dx = o.x + 24 - p.x, dy = o.y + 30 - p.y;
        const a = p.pill.animate(
          [{ transform: "translate(0,0) scale(1)", opacity: 1 }, { transform: `translate(${dx}px,${dy}px) scale(.55)`, opacity: 0 }],
          { duration: 950, delay: n * 18, easing: M, fill: "forwards" }
        );
        anims.push(a);
      });
    });
    ORDER.forEach((t, i) => at(6750 + i * 110, () => { on(owners[t]); }));
    ORDER.forEach((t, i) => at(7300 + i * 110, () => { owners[t].classList.add("hit"); }));
    at(7100, () => lines.forEach((l, i) => at(i * 90, () => on(l))));
    // countdown 40 -> 4
    at(7600, () => { on(old); });
    for (let s = 0; s <= 12; s++) {
      at(7700 + s * 85, () => {
        const v = Math.round(40 - (36 * (1 - Math.pow(1 - s / 12, 2))));
        num.textContent = v;
        if (s === 12) counter.classList.add("good");
      });
    }
    mates.forEach((m, i) => at(8000 + i * 60, () => on(m)));
    at(8900, () => flows.forEach((f) => on(f)));

    // 11.6 s: use cases
    at(11500, () => {
      off(h2); off(counter);
      [hub, team, net, ...Object.values(owners)].forEach((e) => { e.style.transition = `opacity .5s ${M},transform .5s ${M}`; e.style.opacity = "0"; e.style.transform = "scale(.97)"; });
    });
    at(12100, () => on(h3));
    tiles.forEach((t, i) => at(12400 + i * 130, () => on(t)));
    at(13400, () => on(foot));

    // 17.2 s: closing line
    at(17100, () => { off(h3); off(foot); tiles.forEach((t) => off(t)); });
    at(17550, () => on(endMark));
    at(17750, () => on(l1));
    at(18150, () => on(l2));

    return () => {
      timers.forEach(clearTimeout);
      anims.forEach((a) => { try { a.cancel(); } catch (e) {} });
      root.innerHTML = "";
    };
  },
});
