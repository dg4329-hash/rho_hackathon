(window.MESH_SCENES = window.MESH_SCENES || []).push({
  id: 3, title: "Your agent asks", duration: 20000,
  mount(root) {
    const timers = [];
    const at = (ms, fn) => timers.push(setTimeout(fn, ms));
    const E = "cubic-bezier(.2,.8,.2,1)";
    const M = "cubic-bezier(.4,0,.2,1)";
    const LOGO = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="3.5" cy="4" r="2"/><circle cx="12.5" cy="4" r="2"/><circle cx="8" cy="12.5" r="2"/><path d="M5.5 4h5M4.6 5.8l2.3 5M11.4 5.8l-2.3 5"/></svg>';
    const LOCK = '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><rect x="4" y="9" width="12" height="8.5" rx="2.2" fill="currentColor" fill-opacity=".14"/><path d="M7 9V6.5a3 3 0 0 1 6 0V9"/></svg>';
    const CHECK = '<svg viewBox="0 0 16 16" fill="none" stroke="#1c1c1e" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8.4l2.6 2.5L12 5.5"/></svg>';
    const style = document.createElement("style");
    style.textContent = `
.s3-wrap{position:absolute;inset:0;background:radial-gradient(1200px 700px at 30% 20%,#ffffff 0%,#f5f5f7 55%,#ececf0 100%);font-family:-apple-system,BlinkMacSystemFont,"SF Pro Display","Inter",system-ui,sans-serif;color:#1d1d1f;overflow:hidden;-webkit-font-smoothing:antialiased}
.s3-mono{font-family:"SF Mono",SFMono-Regular,Menlo,monospace}
.s3-in{opacity:1!important;transform:none!important}
.s3-cap{position:absolute;left:40px;top:28px;z-index:20;font-size:17px;font-weight:600;letter-spacing:-.005em;color:#6e6e73;background:rgba(255,255,255,.78);backdrop-filter:blur(20px);-webkit-backdrop-filter:blur(20px);padding:8px 16px;border-radius:999px;box-shadow:0 0 0 .5px rgba(0,0,0,.06),0 6px 20px -6px rgba(0,0,0,.12);opacity:0;transform:translateY(-8px);transition:opacity .7s ${E},transform .7s ${E}}
.s3-cap b{color:#0071e3;font-weight:700;margin-right:2px}
.s3-stage{position:absolute;inset:0;transition:transform 1s ${M}}
.s3-stage.s3-lift{transform:translateY(-10px)}
.s3-termpos{position:absolute;left:260px;top:86px;width:760px;height:520px;transition:transform 1.15s ${M}}
.s3-termpos.s3-left{transform:translateX(-220px)}
.s3-term{position:absolute;inset:0;background:#1c1c1e;border-radius:16px;box-shadow:0 0 0 .5px rgba(0,0,0,.4),0 40px 90px -24px rgba(0,0,0,.45),0 4px 12px rgba(0,0,0,.12);overflow:hidden;opacity:0;transform:translateY(36px) scale(.96);transition:opacity .9s ${E},transform 1.1s ${E}}
.s3-bar{height:40px;display:flex;align-items:center;padding:0 16px;gap:8px;background:#232325;border-bottom:1px solid #2c2c2e}
.s3-dot{width:12px;height:12px;border-radius:50%}
.s3-bar span{flex:1;text-align:center;color:#8e8e93;font-size:14px;font-weight:500;margin-right:52px}
.s3-body{position:relative;padding:18px 24px;font-size:15px;line-height:1.5;color:#e5e5ea}
.s3-inbox{border:1px solid #3a3a3c;border-radius:10px;padding:10px 14px;color:#fff;min-height:46px;transition:border-color .5s ${M},background .5s ${M}}
.s3-inbox.s3-sent{border-color:transparent;background:#2c2c2e;color:#d1d1d6}
.s3-gt{color:#8e8e93;margin-right:10px}
.s3-caret{display:inline-block;width:9px;height:18px;background:#e5e5ea;vertical-align:-3px;margin-left:2px;animation:s3blink 1s steps(1) infinite}
@keyframes s3blink{50%{opacity:0}}
.s3-row{margin-top:16px;opacity:0;transform:translateY(12px);transition:opacity .6s ${E},transform .6s ${E}}
.s3-call{display:flex;align-items:center;gap:10px;white-space:nowrap}
.s3-ic{width:18px;height:18px;position:relative;flex:none}
.s3-spin{position:absolute;inset:0;border:2px solid #3a3a3c;border-top-color:#0a84ff;border-radius:50%;animation:s3spin .75s linear infinite;transition:opacity .25s}
@keyframes s3spin{to{transform:rotate(360deg)}}
.s3-chk{position:absolute;inset:0;border-radius:50%;background:#30d158;display:grid;place-items:center;transform:scale(0);transition:transform .5s ${E}}
.s3-chk svg{width:13px;height:13px}
.s3-done .s3-spin{opacity:0}.s3-done .s3-chk{transform:scale(1)}
.s3-srv{color:#bf5af2;font-weight:600}.s3-fn{color:#fff;font-weight:600}.s3-arg{color:#8e8e93}.s3-tagm{color:#636366;font-size:14px}
.s3-res{margin:8px 0 0 8px;padding-left:20px;border-left:1.5px solid #3a3a3c;color:#aeaeb2;opacity:0;max-height:0;overflow:hidden;transition:opacity .6s ${E},max-height .7s ${E}}
.s3-res.s3-in{max-height:120px}
.s3-tbl{display:grid;grid-template-columns:84px 1fr;gap:4px 14px;padding:2px 0}
.s3-who{color:#ff9f0a;font-weight:600}.s3-ct{color:#64d2ff}
.s3-quote{color:#d1d1d6}.s3-quote i{font-style:normal;color:#8e8e93}
.s3-card{margin:10px 0 0 28px;border-radius:12px;padding:12px 16px 12px 16px;background:linear-gradient(180deg,rgba(10,132,255,.16),rgba(10,132,255,.07));box-shadow:inset 0 0 0 1px rgba(10,132,255,.55);opacity:0;transform:translateY(8px) scale(.98);transition:opacity .7s ${E},transform .7s ${E},box-shadow .6s ${M}}
.s3-card.s3-hot{box-shadow:inset 0 0 0 1px rgba(10,132,255,.9),0 0 32px -4px rgba(10,132,255,.55)}
.s3-kv{display:grid;grid-template-columns:86px 1fr;gap:5px 12px}
.s3-k{color:#8e8e93}.s3-v{color:#fff}.s3-s{color:#ffd60a}
.s3-pend{display:inline-flex;align-items:center;gap:7px;margin-left:auto;font-family:-apple-system,BlinkMacSystemFont,"SF Pro Display","Inter",system-ui,sans-serif;font-size:14px;font-weight:600;color:#ff9f0a;background:rgba(255,159,10,.14);padding:2px 10px;border-radius:999px}
.s3-wait{position:absolute;left:24px;right:24px;bottom:18px;display:flex;align-items:center;gap:10px;color:#ff9f0a;font-weight:600;opacity:0;transform:translateY(8px);transition:opacity .6s ${E},transform .6s ${E}}
.s3-pulse{width:10px;height:10px;border-radius:50%;background:#ff9f0a;animation:s3ring 1.4s ease-out infinite}
@keyframes s3ring{0%{box-shadow:0 0 0 0 rgba(255,159,10,.6)}100%{box-shadow:0 0 0 12px rgba(255,159,10,0)}}
.s3-wait .s3-t{animation:s3fade 1.4s ease-in-out infinite}
@keyframes s3fade{0%,100%{opacity:.55}50%{opacity:1}}
.s3-status{position:absolute;left:24px;right:24px;bottom:16px;display:flex;gap:18px;color:#636366;font-size:14px;transition:opacity .5s}
.s3-status .s3-g{color:#30d158}
.s3-net{position:absolute;left:836px;top:86px;width:404px;height:520px}
.s3-node{position:absolute;left:32px;width:340px;height:78px;box-sizing:border-box;background:#fff;border-radius:18px;box-shadow:0 0 0 .5px rgba(0,0,0,.06),0 1px 2px rgba(0,0,0,.04),0 14px 34px -12px rgba(0,0,0,.16);padding:0 18px;display:flex;align-items:center;gap:14px;opacity:0;transform:translateY(16px) scale(.96);transition:opacity .8s ${E},transform .8s ${E}}
.s3-av{width:44px;height:44px;border-radius:50%;display:grid;place-items:center;color:#fff;font-weight:600;font-size:18px;flex:none}
.s3-mark{width:44px;height:44px;border-radius:12px;display:grid;place-items:center;background:#fff;color:#1d1d1f;flex:none}
.s3-mark svg{width:27px;height:27px}
.s3-nt{font-size:17px;font-weight:600;letter-spacing:-.01em}.s3-ns{font-size:14px;color:#6e6e73;margin-top:2px}
.s3-os{margin-left:auto;font-size:14px;font-weight:500;color:#6e6e73;background:rgba(0,0,0,.045);padding:3px 10px;border-radius:999px}
.s3-relay{background:#1d1d1f;color:#fff}.s3-relay .s3-ns{color:#a1a1a6}
.s3-lk{position:absolute;left:50%;top:0;width:2px;margin-left:-1px;background:repeating-linear-gradient(#c7c7cc 0 5px,transparent 5px 10px);transform:scaleY(0);transform-origin:top;transition:transform .7s ${M}}
.s3-lk.s3-in{transform:scaleY(1)!important}
.s3-lock{position:absolute;left:50%;top:418px;transform:translate(-50%,-6px);display:flex;align-items:center;gap:8px;white-space:nowrap;background:#fff;border-radius:999px;padding:7px 14px 7px 10px;font-size:14px;font-weight:600;color:#1d1d1f;box-shadow:inset 0 0 0 1.5px rgba(36,138,61,.45),0 10px 26px -10px rgba(0,0,0,.2);opacity:0;transition:opacity .7s ${E},transform .7s ${E}}
.s3-lock.s3-in{transform:translate(-50%,0)!important}
.s3-lock svg{width:18px;height:18px;color:#248a3d}
.s3-lock code{font-family:"SF Mono",SFMono-Regular,Menlo,monospace;color:#248a3d;font-size:14px}
.s3-pkt{position:absolute;left:50%;top:0;width:0;height:0;opacity:0;z-index:5}
.s3-orb{position:absolute;left:-9px;top:-9px;width:18px;height:18px;border-radius:50%;background:#0a84ff;box-shadow:0 0 0 5px rgba(0,113,227,.18),0 0 26px 8px rgba(0,113,227,.5)}
.s3-plab{position:absolute;left:22px;top:-14px;white-space:nowrap;background:#0071e3;color:#fff;font-size:14px;font-weight:600;padding:4px 11px;border-radius:999px;box-shadow:0 6px 16px -6px rgba(0,113,227,.6)}
.s3-tag{position:absolute;left:0;right:0;bottom:34px;text-align:center;font-size:44px;font-weight:700;letter-spacing:-.03em;color:#1d1d1f;opacity:0;transform:translateY(16px);filter:blur(6px);transition:opacity 1.1s ${E},transform 1.1s ${E},filter 1.1s ${E}}
.s3-tag.s3-in{filter:none}
.s3-tag span{color:#6e6e73}
`;
    root.appendChild(style);
    const w = document.createElement("div");
    w.className = "s3-wrap";
    const call = (fn, arg) => `<div class="s3-call"><div class="s3-ic"><div class="s3-spin"></div><div class="s3-chk">${CHECK}</div></div><span><span class="s3-srv">mesh</span><span class="s3-arg"> · </span><span class="s3-fn">${fn}</span>${arg ? `<span class="s3-arg"> ${arg}</span>` : ""}</span><span class="s3-tagm">(MCP)</span></div>`;
    w.innerHTML = `
<div class="s3-cap"><b>02</b> · Your agent finds the right machine</div>
<div class="s3-stage">
<div class="s3-termpos"><div class="s3-term">
  <div class="s3-bar"><i class="s3-dot" style="background:#ff5f57"></i><i class="s3-dot" style="background:#febc2e"></i><i class="s3-dot" style="background:#28c840"></i><span>dev — claude — ~/onboarding-app</span></div>
  <div class="s3-body s3-mono">
    <div class="s3-inbox"><span class="s3-gt">&gt;</span><span class="s3-typed"></span><span class="s3-caret"></span></div>
    <div class="s3-row" data-r="1">${call("list_teammates", "")}
      <div class="s3-res"><div class="s3-tbl">
        <span class="s3-who">tarush</span><span><span class="s3-ct">figma.export</span><span class="s3-arg">, </span><span class="s3-ct">supabase.list_tables</span></span>
        <span class="s3-who">abhi</span><span class="s3-ct">vercel.deploy</span>
      </div></div>
    </div>
    <div class="s3-row" data-r="2">${call("describe_capability", "tarush figma.export")}
      <div class="s3-res"><div class="s3-quote"><i>owner note ·</i> “Exports any frame as PNG. Runs on my machine with my token.”</div></div>
    </div>
    <div class="s3-row" data-r="3">${call("ask_teammate", "")}
      <div class="s3-card"><div class="s3-kv">
        <span class="s3-k">who</span><span style="display:flex;align-items:center"><span class="s3-who">tarush</span><span class="s3-pend">needs approval</span></span>
        <span class="s3-k">command</span><span class="s3-v">figma-export.sh <span class="s3-s">"Onboarding/Step-2"</span></span>
        <span class="s3-k">why</span><span class="s3-s">"Need the Step 2 frame to build the screen"</span>
      </div></div>
    </div>
    </div>
  <div class="s3-status s3-mono"><span><span class="s3-g">●</span> mesh</span><span>room tango-bc7d92eb</span><span>3 teammates online</span></div>
  <div class="s3-wait s3-mono"><i class="s3-pulse"></i><span class="s3-t">waiting for tarush to approve…</span></div>
</div></div>
<div class="s3-net">
  <div class="s3-lk" style="top:78px;height:143px"></div>
  <div class="s3-lk" style="top:299px;height:143px"></div>
  <div class="s3-node" data-n="1" style="top:0"><div class="s3-av" style="background:#0071e3">D</div><div><div class="s3-nt">Dev's laptop</div><div class="s3-ns">Claude Code · mesh</div></div><span class="s3-os">macOS</span></div>
  <div class="s3-node s3-relay" data-n="2" style="top:221px"><div class="s3-mark">${LOGO}</div><div><div class="s3-nt">mesh relay</div><div class="s3-ns">just a pipe · sees no secrets</div></div></div>
  <div class="s3-node" data-n="3" style="top:442px"><div class="s3-av" style="background:#ff9f0a">T</div><div><div class="s3-nt">Tarush's laptop</div><div class="s3-ns">Figma · Supabase</div></div><span class="s3-os">Windows</span></div>
  <div class="s3-lock">${LOCK}<span><code>FIGMA_TOKEN</code> never leaves</span></div>
  <div class="s3-pkt"><div class="s3-orb"></div><div class="s3-plab">request + reason</div></div>
</div>
</div>
<div class="s3-tag">Capabilities move. <span>Credentials don't.</span></div>`;
    root.appendChild(w);
    const q = (s) => w.querySelector(s);
    const show = (el) => el && el.classList.add("s3-in");

    at(80, () => show(q(".s3-cap")));
    at(200, () => show(q(".s3-term")));

    const text = 'Implement onboarding step 2 to match the Figma frame "Onboarding/Step-2".';
    const typed = q(".s3-typed");
    let i = 0;
    at(900, function tick() {
      typed.textContent = text.slice(0, ++i);
      if (i < text.length) timers.push(setTimeout(tick, 34 + (text[i] === " " ? 24 : 0)));
    });
    at(3900, () => { q(".s3-caret").style.display = "none"; q(".s3-inbox").classList.add("s3-sent"); });

    const row = (n) => q(`.s3-row[data-r="${n}"]`);
    at(4300, () => show(row(1)));
    at(5400, () => { row(1).classList.add("s3-done"); show(row(1).querySelector(".s3-res")); });
    at(6700, () => show(row(2)));
    at(7800, () => { row(2).classList.add("s3-done"); show(row(2).querySelector(".s3-res")); });
    at(9100, () => show(row(3)));
    at(10100, () => { row(3).classList.add("s3-done"); show(row(3).querySelector(".s3-card")); });
    at(10800, () => q(".s3-card").classList.add("s3-hot"));

    // 12s: terminal slides aside, the path appears
    at(11700, () => q(".s3-termpos").classList.add("s3-left"));
    [0, 1, 2].forEach((k) => at(12000 + k * 220, () => show(q(`.s3-node[data-n="${k + 1}"]`))));
    at(12500, () => w.querySelectorAll(".s3-lk").forEach(show));
    at(12900, () => show(q(".s3-lock")));

    at(13400, () => {
      const p = q(".s3-pkt");
      p.animate(
        [
          { transform: "translateY(78px)", opacity: 0, offset: 0 },
          { transform: "translateY(96px)", opacity: 1, offset: 0.07 },
          { transform: "translateY(260px)", opacity: 1, offset: 0.36, easing: M },
          { transform: "translateY(260px)", opacity: 1, offset: 0.52 },
          { transform: "translateY(424px)", opacity: 1, offset: 0.9 },
          { transform: "translateY(442px)", opacity: 0, offset: 1 }
        ],
        { duration: 3000, easing: M, fill: "forwards" }
      );
      q(".s3-card").animate([{ boxShadow: "inset 0 0 0 1px rgba(10,132,255,.9), 0 0 0 0 rgba(10,132,255,.6)" }, { boxShadow: "inset 0 0 0 1px rgba(10,132,255,.9), 0 0 0 16px rgba(10,132,255,0)" }], { duration: 900, easing: "ease-out" });
      timers.push(setTimeout(() => q('.s3-node[data-n="2"]').animate([{ boxShadow: "0 0 0 0 rgba(10,132,255,.55)" }, { boxShadow: "0 0 0 18px rgba(10,132,255,0)" }], { duration: 1000, easing: "ease-out" }), 1050));
      timers.push(setTimeout(() => q('.s3-node[data-n="3"]').animate([{ boxShadow: "0 0 0 0 rgba(255,159,10,.55)" }, { boxShadow: "0 0 0 18px rgba(255,159,10,0)" }], { duration: 1000, easing: "ease-out" }), 2750));
      timers.push(setTimeout(() => q(".s3-lock").animate([{ transform: "translate(-50%,0) scale(1)" }, { transform: "translate(-50%,0) scale(1.08)" }, { transform: "translate(-50%,0) scale(1)" }], { duration: 700, easing: M }), 2950));
    });

    at(16900, () => { q(".s3-status").style.opacity = 0; show(q(".s3-wait")); });
    at(17300, () => { q(".s3-stage").classList.add("s3-lift"); show(q(".s3-tag")); });

    return () => {
      timers.forEach(clearTimeout); timers.length = 0;
      try { w.getAnimations({ subtree: true }).forEach((a) => a.cancel()); } catch (e) {}
    };
  }
});
