(window.MESH_SCENES = window.MESH_SCENES || []).push({
  id: 1,
  title: "The problem",
  duration: 20000,
  mount(root) {
    const timers = [];
    const intervals = [];
    const at = (ms, fn) => timers.push(setTimeout(fn, ms));
    const E = "cubic-bezier(.2,.8,.2,1)";
    const M = "cubic-bezier(.4,0,.2,1)";
    const FONT = `-apple-system,BlinkMacSystemFont,"SF Pro Display","Inter",system-ui,sans-serif`;
    const MONO = `"SF Mono",SFMono-Regular,Menlo,monospace`;

    const style = document.createElement("style");
    style.textContent = `
.s1-root{position:absolute;inset:0;background:#000;color:#f5f5f7;overflow:hidden;font-family:${FONT};
  -webkit-font-smoothing:antialiased;transition:background 2.2s ${M},color 2.2s ${M}}
.s1-root *{box-sizing:border-box}
.s1-root.s1-light{background:#f5f5f7;color:#1d1d1f}
.s1-glow{position:absolute;left:50%;top:50%;width:1400px;height:900px;margin:-450px 0 0 -700px;pointer-events:none;
  background:radial-gradient(closest-side,rgba(0,113,227,.10),rgba(0,113,227,0) 70%);opacity:0;transition:opacity 2s ${E}}
.s1-glow.s1-in{opacity:1}
.s1-stage{position:absolute;inset:0;transition:filter 1.1s ${M},opacity 1.1s ${M},transform 1.2s ${M}}
.s1-stage.s1-out{filter:blur(28px);opacity:0;transform:scale(.96)}
.s1-layer{position:absolute;inset:0;transition:opacity 1s ${M},transform 1.1s ${M},filter 1s ${M}}

/* intro */
.s1-intro{display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center}
.s1-intro.s1-gone{opacity:0;transform:translateY(-36px) scale(.98);filter:blur(12px)}
.s1-h1{font-size:76px;font-weight:700;letter-spacing:-.045em;line-height:1.04;white-space:nowrap}
.s1-w{display:inline-block;opacity:0;transform:translateY(40px);filter:blur(10px);margin:0 .11em;
  transition:opacity .9s ${E},transform 1s ${E},filter .9s ${E}}
.s1-w.s1-in{opacity:1;transform:none;filter:none}
.s1-grad{background:linear-gradient(100deg,#2997ff 0%,#0071e3 60%,#5e5ce6 100%);-webkit-background-clip:text;background-clip:text;color:transparent;padding-right:.04em}
.s1-sub{margin-top:30px;font-size:34px;font-weight:500;letter-spacing:-.015em;color:#86868b;display:flex;gap:.4em}
.s1-sub span{opacity:0;transform:translateY(16px);transition:opacity .8s ${E},transform .9s ${E}}
.s1-sub span.s1-in{opacity:1;transform:none}

/* split */
.s1-split{opacity:0}
.s1-split.s1-in{opacity:1}
.s1-split.s1-dim{opacity:.22;filter:blur(10px);transform:scale(.955)}
.s1-term{position:absolute;left:60px;top:84px;width:712px;height:552px;background:#1c1c1e;border-radius:18px;overflow:hidden;
  box-shadow:0 30px 80px -20px rgba(0,0,0,.45),0 2px 6px rgba(0,0,0,.08),0 0 0 1px rgba(0,0,0,.2);
  opacity:0;transform:translateY(40px) scale(.97);transition:opacity 1s ${E},transform 1.1s ${E}}
.s1-term.s1-in{opacity:1;transform:none}
.s1-bar{height:44px;display:flex;align-items:center;gap:8px;padding:0 16px;background:#2a2a2d;border-bottom:1px solid rgba(255,255,255,.06)}
.s1-dot{width:12px;height:12px;border-radius:50%}
.s1-bar-t{flex:1;text-align:center;color:#98989d;font-size:14px;font-weight:500;margin-right:56px}
.s1-body{padding:22px 26px;font-family:${MONO};font-size:17px;line-height:1.6;color:#e5e5ea}
.s1-welcome{border:1.5px solid #d97757;border-radius:10px;padding:12px 18px;margin-bottom:22px}
.s1-welcome b{color:#d97757;font-weight:600}
.s1-muted{color:#8a8a93}
.s1-input{border:1.5px solid #48484a;border-radius:10px;padding:11px 16px;display:flex;gap:10px;min-height:76px;align-items:flex-start}
.s1-input .s1-gt{color:#98989d}
.s1-typed{white-space:pre-wrap;flex:1}
.s1-caret{display:inline-block;width:10px;height:20px;background:#e5e5ea;vertical-align:-4px;margin-left:1px;animation:s1-blink 1s steps(1) infinite}
@keyframes s1-blink{50%{opacity:0}}
.s1-out-l{margin-top:14px;opacity:0;transform:translateY(8px);transition:opacity .7s ${E},transform .8s ${E}}
.s1-out-l.s1-in{opacity:1;transform:none}
.s1-bullet{color:#e5e5ea}
.s1-bullet i{font-style:normal;color:#8a8a93}
.s1-spin{display:inline-block;color:#d97757;width:1.2em}
.s1-sub-l{padding-left:22px;margin-top:4px;opacity:0;transform:translateX(-10px);transition:opacity .7s ${E},transform .8s ${E}}
.s1-sub-l.s1-in{opacity:1;transform:none}
.s1-red{color:#ff6961}
.s1-hook{color:#636366;margin-right:10px}

.s1-side{position:absolute;left:808px;top:84px;width:412px}
.s1-kick{font-size:15px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:#86868b;margin:0 0 16px 4px;
  opacity:0;transition:opacity .8s ${E}}
.s1-kick.s1-in{opacity:1}
.s1-mate{position:relative;background:#fff;border-radius:22px;padding:22px 24px;margin-bottom:18px;
  box-shadow:0 1px 2px rgba(0,0,0,.04),0 8px 24px -8px rgba(0,0,0,.08);border:1px solid rgba(0,0,0,.06);
  opacity:0;transform:translateX(40px);transition:opacity 1s ${E},transform 1.1s ${E},box-shadow 1s ${E},border-color 1s ${E}}
.s1-mate.s1-in{opacity:.55;transform:none}
.s1-mate.s1-lit{opacity:1;transform:translateY(-2px);border-color:rgba(0,113,227,.35);
  box-shadow:0 0 0 4px rgba(0,113,227,.10),0 24px 50px -16px rgba(0,113,227,.35)}
.s1-mhead{display:flex;align-items:center;gap:14px}
.s1-av{position:relative;width:48px;height:48px;border-radius:50%;display:grid;place-items:center;color:#fff;font-weight:600;font-size:19px}
.s1-av i{position:absolute;right:-1px;bottom:-1px;width:14px;height:14px;border-radius:50%;background:#28cd41;border:2.5px solid #fff}
.s1-name{font-size:22px;font-weight:600;letter-spacing:-.02em;color:#1d1d1f}
.s1-os{font-size:15px;color:#6e6e73;margin-top:1px}
.s1-tools{display:flex;gap:10px;margin-top:18px}
.s1-tool{display:flex;align-items:center;gap:8px;font-size:16px;font-weight:500;color:#1d1d1f;padding:8px 14px 8px 10px;
  border-radius:999px;background:rgba(0,0,0,.04)}
.s1-tool svg{width:18px;height:18px;flex:none}
.s1-note{margin:8px 4px 0;font-size:24px;line-height:1.3;font-weight:600;letter-spacing:-.02em;color:#1d1d1f;
  opacity:0;transform:translateY(14px);transition:opacity .9s ${E},transform 1s ${E}}
.s1-note.s1-in{opacity:1;transform:none}
.s1-note span{color:#0066cc}

/* chat */
.s1-chat{position:absolute;left:50%;top:0;width:620px;margin-left:-310px;height:720px;display:flex;flex-direction:column;justify-content:center;gap:16px;pointer-events:none}
.s1-chat-k{text-align:center;font-size:15px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:#6e6e73;margin-bottom:10px;
  opacity:0;transform:translateY(10px);transition:opacity .8s ${E},transform .9s ${E}}
.s1-chat-k.s1-in{opacity:1;transform:none}
.s1-msg{display:flex;align-items:flex-end;gap:12px;opacity:0;transform:translateY(26px) scale(.97);transition:opacity .8s ${E},transform .9s ${E}}
.s1-msg.s1-in{opacity:1;transform:none}
.s1-msg.s1-r{flex-direction:row-reverse}
.s1-mav{width:40px;height:40px;border-radius:50%;flex:none;display:grid;place-items:center;color:#fff;font-weight:600;font-size:16px;
  box-shadow:0 4px 12px rgba(0,0,0,.12)}
.s1-bub{position:relative;background:#fff;border-radius:22px;padding:14px 20px 15px;box-shadow:0 1px 2px rgba(0,0,0,.05),0 18px 44px -14px rgba(0,0,0,.22);
  max-width:470px}
.s1-r .s1-bub{background:#0071e3;color:#fff}
.s1-who{font-size:14px;font-weight:600;color:#86868b;margin-bottom:2px}
.s1-r .s1-who{color:rgba(255,255,255,.75)}
.s1-txt{position:relative;display:inline-block;font-size:24px;font-weight:500;letter-spacing:-.015em;line-height:1.25}
.s1-strike{position:absolute;left:-3px;right:-3px;top:54%;height:3px;border-radius:2px;background:#ff3b30;transform:scaleX(0);transform-origin:left;
  transition:transform .7s ${M}}
.s1-strike.s1-in{transform:scaleX(1)}
.s1-bad .s1-txt{transition:color .6s ${M}}
.s1-bad.s1-struck .s1-txt{color:#86868b}
.s1-never{position:absolute;left:calc(100% + 14px);top:50%;margin-top:-17px;height:34px;display:flex;align-items:center;gap:7px;
  padding:0 14px 0 11px;border-radius:999px;background:#fff;color:#d70015;font-size:16px;font-weight:600;white-space:nowrap;
  box-shadow:0 0 0 1px rgba(215,0,21,.18),0 10px 24px -8px rgba(215,0,21,.35);opacity:0;transform:translateX(-8px) scale(.9);
  transition:opacity .6s ${E},transform .7s ${E}}
.s1-never.s1-in{opacity:1;transform:none}
.s1-never svg{width:16px;height:16px}

/* logo */
.s1-logo{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;pointer-events:none}
.s1-lockup{display:flex;align-items:center;gap:30px}
.s1-mark{width:128px;height:128px;border-radius:34px;background:#1d1d1f;color:#fff;display:grid;place-items:center;
  box-shadow:0 30px 70px -20px rgba(0,0,0,.45),0 2px 6px rgba(0,0,0,.1);opacity:0;transform:scale(.6);filter:blur(8px);
  transition:opacity .9s ${E},transform 1.1s ${E},filter .9s ${E}}
.s1-mark.s1-in{opacity:1;transform:none;filter:none}
.s1-mark svg{width:78px;height:78px;overflow:visible}
.s1-mark circle{transform-box:fill-box;transform-origin:center;transform:scale(0);transition:transform .7s cubic-bezier(.3,1.5,.5,1)}
.s1-mark circle.s1-in{transform:scale(1)}
.s1-mark path{stroke-dasharray:1;stroke-dashoffset:1;transition:stroke-dashoffset .75s ${M}}
.s1-mark path.s1-in{stroke-dashoffset:0}
.s1-word{font-size:112px;font-weight:600;letter-spacing:-.05em;line-height:1;color:#1d1d1f;padding-bottom:10px;
  opacity:0;transform:translateX(-24px);filter:blur(8px);transition:opacity .9s ${E},transform 1s ${E},filter .9s ${E}}
.s1-word.s1-in{opacity:1;transform:none;filter:none}
.s1-tag{margin-top:40px;font-size:34px;font-weight:500;letter-spacing:-.02em;color:#6e6e73;
  opacity:0;transform:translateY(16px);transition:opacity 1s ${E},transform 1.1s ${E}}
.s1-tag.s1-in{opacity:1;transform:none}
.s1-tag em{font-style:normal;color:#1d1d1f}
`;
    root.appendChild(style);

    const el = (tag, cls, parent, text) => {
      const n = document.createElement(tag);
      if (cls) n.className = cls;
      if (text != null) n.textContent = text;
      if (parent) parent.appendChild(n);
      return n;
    };
    const add = (n, c) => n && n.classList.add(c);

    const wrap = el("div", "s1-root", root);
    const glow = el("div", "s1-glow", wrap);
    const stage = el("div", "s1-stage", wrap);

    // ---------- 0-4 s: headline
    const intro = el("div", "s1-layer s1-intro", stage);
    const h1 = el("div", "s1-h1", intro);
    const words = ["Every", "coding", "agent", "is", "single-player."].map((w) =>
      el("span", "s1-w" + (w.startsWith("single") ? " s1-grad" : ""), h1, w)
    );
    const sub = el("div", "s1-sub", intro);
    const subs = ["Your tools.", "Your keys.", "Your laptop."].map((t) => el("span", "", sub, t));

    // ---------- 4-11 s: terminal + teammates
    const split = el("div", "s1-layer s1-split", stage);
    const term = el("div", "s1-term", split);
    const bar = el("div", "s1-bar", term);
    ["#ff5f57", "#febc2e", "#28c840"].forEach((c) => (el("span", "s1-dot", bar).style.background = c));
    el("div", "s1-bar-t", bar, "dev — claude — ~/app");
    const body = el("div", "s1-body", term);
    const welcome = el("div", "s1-welcome", body);
    welcome.innerHTML = `<b>✻</b> Welcome to <b>Claude Code</b><br><span class="s1-muted">cwd: ~/app · onboarding-v2</span>`;
    const input = el("div", "s1-input", body);
    el("span", "s1-gt", input, ">");
    const typedWrap = el("div", "s1-typed", input);
    const typed = el("span", "", typedWrap);
    const caret = el("span", "s1-caret", typedWrap);

    const think = el("div", "s1-out-l s1-bullet", body);
    const spin = el("span", "s1-spin", think, "✻");
    think.appendChild(document.createTextNode("Checking tools for this task"));
    el("i", "", think, "…");
    const needs = [
      ["figma", "No Figma access on this machine"],
      ["supabase", "No Supabase credentials"],
    ].map(([, t]) => {
      const n = el("div", "s1-sub-l s1-red", body);
      el("span", "s1-hook", n, "⎿");
      n.appendChild(document.createTextNode(t));
      return n;
    });
    const stuck = el("div", "s1-out-l s1-muted", body, "  Can't continue without them.");
    stuck.style.marginTop = "18px";

    const ICON = {
      figma: `<svg viewBox="0 0 18 18"><rect x="5" y="1" width="4" height="5" rx="2" fill="#f24e1e"/><rect x="9" y="1" width="4" height="5" rx="2" fill="#ff7262"/><rect x="5" y="6" width="4" height="5" rx="2" fill="#a259ff"/><circle cx="11" cy="8.5" r="2" fill="#1abcfe"/><path d="M5 13a2 2 0 0 1 2-2h2v2a2 2 0 1 1-4 0z" fill="#0acf83"/></svg>`,
      supabase: `<svg viewBox="0 0 18 18"><path d="M10 1.5 3 10.2h6l-1 6.3 7-8.7H9z" fill="#3ecf8e"/></svg>`,
      vercel: `<svg viewBox="0 0 18 18"><path d="M9 3l7 12H2z" fill="#1d1d1f"/></svg>`,
    };
    const side = el("div", "s1-side", split);
    const kick = el("div", "s1-kick", side, "Your team");
    const mate = (initial, color, name, os, tools) => {
      const c = el("div", "s1-mate", side);
      const h = el("div", "s1-mhead", c);
      const av = el("div", "s1-av", h, initial);
      av.style.background = color;
      el("i", "", av);
      const t = el("div", "", h);
      el("div", "s1-name", t, name);
      el("div", "s1-os", t, os);
      const row = el("div", "s1-tools", c);
      tools.forEach((x) => {
        const p = el("span", "s1-tool", row);
        p.innerHTML = ICON[x.toLowerCase()] + x;
      });
      return c;
    };
    const tarush = mate("T", "#af52de", "Tarush", "Windows · online", ["Figma", "Supabase"]);
    const abhi = mate("A", "#ff9f0a", "Abhi", "macOS · online", ["Vercel"]);
    const note = el("div", "s1-note", side);
    note.innerHTML = `Someone on your team<br><span>already has the tool.</span>`;

    // ---------- 11-15 s: the workaround
    const chat = el("div", "s1-chat", stage);
    const chatK = el("div", "s1-chat-k", chat, "The workaround today");
    const msgs = [
      { who: "Dev", c: "#0071e3", t: "can you export that frame for me?", r: true },
      { who: "Dev", c: "#0071e3", t: "and what's the table name?", r: true },
      { who: "Tarush", c: "#af52de", t: "just send me your token", bad: true },
    ].map((m) => {
      const n = el("div", "s1-msg" + (m.r ? " s1-r" : "") + (m.bad ? " s1-bad" : ""), chat);
      el("div", "s1-mav", n, m.who[0]).style.background = m.c;
      const b = el("div", "s1-bub", n);
      el("div", "s1-who", b, m.who);
      const tx = el("div", "s1-txt", b, m.t);
      const r = { n };
      if (m.bad) {
        r.strike = el("span", "s1-strike", tx);
        r.never = el("span", "s1-never", b);
        r.never.innerHTML = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="8" cy="8" r="6.2"/><path d="M3.7 12.3l8.6-8.6"/></svg>never`;
      }
      return r;
    });
    // the "never" pill sits on the right of the left-aligned bubble
    msgs[2].n.style.paddingRight = "130px";
    msgs[0].n.style.paddingLeft = "60px";
    msgs[1].n.style.paddingLeft = "60px";
    chat.style.transition = `opacity 1s ${M},transform 1.1s ${M},filter 1s ${M}`;

    // ---------- 15-20 s: logo
    const logo = el("div", "s1-logo", wrap);
    const lockup = el("div", "s1-lockup", logo);
    const mark = el("div", "s1-mark", lockup);
    mark.innerHTML = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round">
      <path pathLength="1" d="M5.5 4h5"/><path pathLength="1" d="M4.6 5.8l2.3 5"/><path pathLength="1" d="M11.4 5.8l-2.3 5"/>
      <circle cx="3.5" cy="4" r="2"/><circle cx="12.5" cy="4" r="2"/><circle cx="8" cy="12.5" r="2"/></svg>`;
    const word = el("div", "s1-word", lockup, "mesh");
    const tag = el("div", "s1-tag", logo);
    tag.innerHTML = `Borrow a teammate's machine, <em>not their credentials.</em>`;

    // ---------- timeline
    at(80, () => add(wrap, "s1-light"));
    at(600, () => add(glow, "s1-in"));
    words.forEach((w, i) => at(350 + i * 190, () => add(w, "s1-in")));
    subs.forEach((s, i) => at(1750 + i * 320, () => add(s, "s1-in")));
    at(3700, () => {
      add(intro, "s1-gone");
      glow.classList.remove("s1-in");
    });

    at(4050, () => add(split, "s1-in"));
    at(4100, () => add(term, "s1-in"));
    at(4500, () => add(kick, "s1-in"));
    at(4600, () => add(tarush, "s1-in"));
    at(4800, () => add(abhi, "s1-in"));

    const cmd = "Implement onboarding step 2 to match the Figma frame Onboarding/Step-2";
    at(4900, () => {
      let i = 0;
      const iv = setInterval(() => {
        i += 1;
        typed.textContent = cmd.slice(0, i);
        if (i >= cmd.length) clearInterval(iv);
      }, 26);
      intervals.push(iv);
    });
    at(6900, () => {
      caret.style.display = "none";
      add(think, "s1-in");
      const frames = ["✻", "✶", "✳", "✢", "·", "✢", "✳", "✶"];
      let f = 0;
      const iv = setInterval(() => (spin.textContent = frames[(f = (f + 1) % frames.length)]), 140);
      intervals.push(iv);
      at(8900, () => {
        clearInterval(iv);
        spin.textContent = "⏺";
        spin.style.color = "#8a8a93";
      });
    });
    at(7700, () => add(needs[0], "s1-in"));
    at(8300, () => add(needs[1], "s1-in"));
    at(9000, () => add(stuck, "s1-in"));
    at(8900, () => add(tarush, "s1-lit"));
    at(9150, () => add(abhi, "s1-lit"));
    at(9500, () => add(note, "s1-in"));

    at(11000, () => add(split, "s1-dim"));
    at(11200, () => add(chatK, "s1-in"));
    msgs.forEach((m, i) => at(11450 + i * 700, () => add(m.n, "s1-in")));
    at(13300, () => {
      add(msgs[2].strike, "s1-in");
      add(msgs[2].n, "s1-struck");
    });
    at(13750, () => add(msgs[2].never, "s1-in"));

    at(15000, () => add(stage, "s1-out"));
    at(15600, () => add(mark, "s1-in"));
    mark.querySelectorAll("circle").forEach((c, i) => at(15950 + i * 150, () => add(c, "s1-in")));
    mark.querySelectorAll("path").forEach((p, i) => at(16400 + i * 160, () => add(p, "s1-in")));
    at(16700, () => add(word, "s1-in"));
    at(17400, () => add(tag, "s1-in"));

    return () => {
      timers.forEach(clearTimeout);
      intervals.forEach(clearInterval);
    };
  },
});
