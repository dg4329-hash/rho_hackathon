(window.MESH_SCENES = window.MESH_SCENES || []).push({
  id: 2,
  title: "Start a room",
  duration: 20000,
  mount(root) {
    const timers = [];
    const at = (ms, fn) => timers.push(setTimeout(fn, ms));
    const every = (ms, fn) => { const t = setInterval(fn, ms); timers.push(t); return t; };
    const E = "cubic-bezier(.2,.8,.2,1)";
    const M = "cubic-bezier(.4,0,.2,1)";
    const HOST = "relay-production-8eef.up.railway.app";
    const ORIGIN = "https://" + HOST;
    const ROOM = "tango-bc7d92eb";
    const LOGO = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="3.5" cy="4" r="2"/><circle cx="12.5" cy="4" r="2"/><circle cx="8" cy="12.5" r="2"/><path d="M5.5 4h5M4.6 5.8l2.3 5M11.4 5.8l-2.3 5"/></svg>';
    const CHECK = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 8.5l3 3 6-7"/></svg>';
    const KEYM = "••••••••";
    const CMD_SH = `curl -fsSL ${ORIGIN}/install.sh | bash -s -- ${ROOM} --key ${KEYM}`;
    const CMD_PS = `& ([scriptblock]::Create((irm -Headers @{'ngrok-skip-browser-warning'='1'} ${ORIGIN}/install.ps1))) ${ROOM} --key ${KEYM}`;

    const css = `
.s2-root{position:absolute;inset:0;background:#f5f5f7;color:#1d1d1f;font-family:-apple-system,BlinkMacSystemFont,"SF Pro Display","Inter",system-ui,sans-serif;letter-spacing:-.01em;overflow:hidden;-webkit-font-smoothing:antialiased}
.s2-root *{box-sizing:border-box}
.s2-root:before{content:"";position:absolute;left:50%;top:40%;width:1100px;height:700px;transform:translate(-50%,-50%);background:radial-gradient(closest-side,rgba(0,113,227,.07),transparent);pointer-events:none}
.s2-cap{position:absolute;left:40px;top:28px;z-index:50;font-size:20px;font-weight:600;letter-spacing:-.01em;color:#6e6e73;background:rgba(255,255,255,.72);backdrop-filter:blur(20px);-webkit-backdrop-filter:blur(20px);padding:8px 14px;border-radius:999px;box-shadow:0 4px 20px rgba(0,0,0,.08);opacity:0;transform:translateY(-8px);transition:opacity .7s ${E},transform .8s ${E}}
.s2-cap b{color:#0071e3;font-weight:600}
.s2-in{opacity:1!important;transform:none!important}
.s2-mono{font-family:"SF Mono",SFMono-Regular,Menlo,monospace;letter-spacing:0}
/* browser */
.s2-br{position:absolute;left:130px;top:92px;width:1020px;height:596px;background:#f5f5f7;border-radius:16px;overflow:hidden;box-shadow:0 0 0 1px rgba(0,0,0,.06),0 30px 80px -20px rgba(0,0,0,.25),0 10px 30px -10px rgba(0,0,0,.12);opacity:0;transform:translateY(40px) scale(.97);transition:opacity .9s ${E},transform 1s ${E}}
.s2-br.s2-away{opacity:0!important;transform:translateY(-20px) scale(.9)!important;filter:blur(4px);transition:opacity .6s ${M},transform .7s ${M},filter .6s}
.s2-bar{height:44px;background:#ececef;border-bottom:1px solid rgba(0,0,0,.08);display:flex;align-items:center;padding:0 16px;gap:8px;position:relative}
.s2-tl{width:12px;height:12px;border-radius:50%}
.s2-url{position:absolute;left:50%;top:8px;transform:translateX(-50%);width:520px;height:28px;border-radius:8px;background:#fff;display:flex;align-items:center;justify-content:center;gap:7px;font-size:14px;color:#1d1d1f;box-shadow:0 0 0 1px rgba(0,0,0,.05)}
.s2-url svg{width:11px;height:12px;flex:none}
.s2-url span{white-space:nowrap;transition:opacity .25s}
.s2-url em{font-style:normal;color:#86868b}
.s2-vp{position:absolute;left:0;right:0;top:44px;bottom:0;overflow:hidden}
.s2-nav{height:52px;background:rgba(255,255,255,.72);border-bottom:1px solid rgba(0,0,0,.08);display:flex;align-items:center;gap:10px;padding:0 36px}
.s2-brand{display:flex;align-items:center;gap:10px;font-weight:600;font-size:19px;letter-spacing:-.02em}
.s2-mark{width:26px;height:26px;border-radius:7px;display:grid;place-items:center;background:#1d1d1f;color:#fff}
.s2-mark svg{width:16px;height:16px}
.s2-badge{font:500 14px/1.5 "SF Mono",SFMono-Regular,Menlo,monospace;color:#6e6e73;padding:1px 10px;border-radius:999px;background:rgba(0,0,0,.04);border:1px solid rgba(0,0,0,.08);opacity:0;transition:opacity .4s}
.s2-status{margin-left:auto;display:flex;align-items:center;gap:7px;font-size:14px;color:#6e6e73;opacity:0;transition:opacity .4s}
.s2-dot{width:8px;height:8px;border-radius:50%;background:#28cd41;box-shadow:0 0 0 3px rgba(40,205,65,.22)}
.s2-page{position:absolute;left:0;right:0;top:52px;bottom:0;transition:opacity .45s ${M},transform .6s ${E}}
.s2-page.s2-off{opacity:0;transform:translateY(14px);pointer-events:none}
.s2-page.s2-gone{opacity:0;transform:translateY(-14px)}
/* front door */
.s2-head{text-align:center;padding:44px 0 30px}
.s2-eye{font-size:15px;font-weight:600;color:#0066cc;margin-bottom:12px}
.s2-h1{font-size:54px;line-height:1.04;font-weight:700;letter-spacing:-.04em}
.s2-lede{margin:16px auto 0;font-size:19px;line-height:1.45;color:#6e6e73;max-width:620px}
.s2-card{background:#fff;border:1px solid rgba(0,0,0,.08);border-radius:20px;box-shadow:0 1px 2px rgba(0,0,0,.04),0 8px 24px -8px rgba(0,0,0,.08)}
.s2-door{display:grid;grid-template-columns:1fr 1fr;width:800px;margin:0 auto}
.s2-door>div{padding:26px 30px}
.s2-door>div+div{border-left:1px solid rgba(0,0,0,.08)}
.s2-h2{font-size:17px;font-weight:600;letter-spacing:-.02em}
.s2-muted{color:#6e6e73;font-size:15px;margin:6px 0 18px;line-height:1.4}
.s2-btn{display:inline-flex;align-items:center;justify-content:center;min-height:48px;padding:0 26px;border-radius:999px;background:#0071e3;color:#fff;font-size:16px;font-weight:500;transition:transform .16s ${M},background .2s,box-shadow .3s;box-shadow:0 0 0 0 rgba(0,113,227,0)}
.s2-btn.s2-hover{background:#0068d1;box-shadow:0 6px 18px -4px rgba(0,113,227,.45)}
.s2-press{transform:scale(.95)!important}
.s2-field{display:flex;gap:8px}
.s2-input{flex:1;min-height:44px;border:1px solid rgba(0,0,0,.14);border-radius:12px;padding:0 14px;display:flex;align-items:center;color:#86868b;font-size:15px}
.s2-ghost{min-height:44px;padding:0 16px;border-radius:999px;background:rgba(0,0,0,.04);border:1px solid rgba(0,0,0,.08);display:flex;align-items:center;font-size:15px;font-weight:500}
/* room */
.s2-rhead{padding:26px 36px 18px}
.s2-rhead .s2-eye{margin-bottom:6px}
.s2-rh1{font-size:34px;line-height:1.1;font-weight:700;letter-spacing:-.032em}
.s2-rgrid{display:grid;grid-template-columns:minmax(0,1fr) 316px;gap:18px;padding:0 36px}
.s2-step{display:grid;grid-template-columns:28px minmax(0,1fr);column-gap:14px;padding:16px 22px}
.s2-step+.s2-step{border-top:1px solid rgba(0,0,0,.08)}
.s2-num{width:28px;height:28px;border-radius:50%;display:grid;place-items:center;font:600 14px/1 -apple-system,BlinkMacSystemFont,sans-serif}
.s2-num svg{width:14px;height:14px}
.s2-num.s2-done{background:#1f9d3a;color:#fff}
.s2-num.s2-now{background:#1d1d1f;color:#fff}
.s2-stitle{font-size:17px;font-weight:600;letter-spacing:-.02em;line-height:28px}
.s2-stitle span{font-weight:400;color:#6e6e73;font-size:15px}
.s2-sbody{grid-column:2;padding-top:6px}
.s2-sbody .s2-muted{margin:0 0 10px}
.s2-term{background:#0b0b0d;color:#e4e4e7;border-radius:14px;overflow:hidden;box-shadow:0 12px 32px -18px rgba(0,0,0,.5)}
.s2-tbar{display:flex;align-items:center;justify-content:space-between;padding:7px 8px 7px 10px;background:#1a1a1d;border-bottom:1px solid rgba(255,255,255,.07)}
.s2-tabs{display:inline-flex;padding:2px;border-radius:9px;background:rgba(255,255,255,.07)}
.s2-tab{min-height:30px;padding:0 13px;border-radius:7px;display:flex;align-items:center;color:#8a8a93;font-size:14px;transition:background .3s ${M},color .3s}
.s2-tab.s2-on{background:rgba(255,255,255,.16);color:#fff}
.s2-tcopy{min-height:30px;padding:0 12px;border-radius:999px;background:rgba(255,255,255,.1);border:1px solid rgba(255,255,255,.14);color:#fff;font-size:14px;display:flex;align-items:center}
.s2-code{display:flex;gap:10px;padding:14px 16px 16px;font:14px/1.6 "SF Mono",SFMono-Regular,Menlo,monospace;min-height:94px}
.s2-code .s2-pr{color:#8a8a93;flex:none}
.s2-code code{flex:1;min-width:0;white-space:pre-wrap;word-break:break-all;font:inherit;transition:opacity .25s}
.s2-code code i{font-style:normal;color:#7cc4ff}
.s2-ok{display:flex;gap:10px;align-items:center;margin-top:10px;padding:9px 12px;border-radius:12px;background:rgba(31,157,58,.09);font-size:14px}
.s2-ok:before{content:"";flex:none;width:8px;height:8px;border-radius:50%;background:#28cd41}
.s2-pad{padding:18px 20px}
.s2-link{margin-top:12px;padding:10px 12px;border-radius:12px;background:rgba(0,0,0,.04);border:1px solid rgba(0,0,0,.08);font:14px/1.5 "SF Mono",SFMono-Regular,Menlo,monospace;word-break:break-all;transition:background .4s,border-color .4s}
.s2-link.s2-sel{background:rgba(0,113,227,.1);border-color:rgba(0,113,227,.35)}
.s2-link b{font-weight:400;color:#86868b}
.s2-acts{display:flex;align-items:center;gap:10px;margin-top:12px}
.s2-copy{min-height:38px;padding:0 16px;border-radius:999px;background:#0071e3;color:#fff;font-size:15px;font-weight:500;display:inline-flex;align-items:center;gap:6px;transition:transform .16s ${M},background .3s}
.s2-copy svg{width:14px;height:14px;display:none}
.s2-copy.s2-done{background:#1f9d3a}.s2-copy.s2-done svg{display:block}
.s2-note{font-size:14px;color:#6e6e73;margin-top:12px;line-height:1.4}
.s2-toast{position:absolute;left:50%;bottom:26px;transform:translate(-50%,16px);background:rgba(29,29,31,.92);color:#fff;font-size:15px;font-weight:500;padding:10px 16px;border-radius:999px;display:flex;align-items:center;gap:8px;opacity:0;transition:opacity .45s ${E},transform .6s ${E};box-shadow:0 10px 30px -8px rgba(0,0,0,.35)}
.s2-toast svg{width:14px;height:14px;color:#30d158}
/* cursor */
.s2-cur{position:absolute;left:1180px;top:700px;width:26px;height:26px;z-index:40;opacity:0;pointer-events:none;transition:left 1.1s ${M},top 1.1s ${M},opacity .4s,transform .14s;filter:drop-shadow(0 2px 4px rgba(0,0,0,.3))}
.s2-cur.s2-click{transform:scale(.82)}
/* terminals */
.s2-terms{position:absolute;left:40px;right:40px;top:96px;display:grid;grid-template-columns:repeat(3,1fr);gap:20px}
.s2-tw{height:520px;background:#1c1c1e;border-radius:16px;overflow:hidden;box-shadow:0 0 0 1px rgba(0,0,0,.2),0 24px 60px -18px rgba(0,0,0,.35);opacity:0;transform:translateY(60px) scale(.96);transition:opacity .8s ${E},transform .9s ${E}}
.s2-tw.s2-fold{opacity:0!important;transform:translateY(-30px) scale(.86)!important;filter:blur(3px);transition:opacity .55s ${M},transform .65s ${M},filter .55s}
.s2-twbar{height:40px;display:flex;align-items:center;gap:7px;padding:0 14px;background:#2a2a2d;border-bottom:1px solid rgba(255,255,255,.06);position:relative}
.s2-twbar.s2-win{background:#012456;gap:0;padding:0}
.s2-twt{position:absolute;left:0;right:0;text-align:center;color:#a1a1a6;font-size:14px;font-weight:500;pointer-events:none}
.s2-win .s2-twt{text-align:left;left:42px;color:#e4e4e7}
.s2-winic{width:16px;height:16px;margin-left:16px;border-radius:3px;background:#2b7cd3;display:grid;place-items:center;color:#fff;font:700 10px/1 "SF Mono",Menlo,monospace}
.s2-winbtns{margin-left:auto;display:flex;color:#e4e4e7;font-size:14px}
.s2-winbtns span{width:40px;text-align:center}
.s2-tb{padding:16px 16px;font:14px/1.6 "SF Mono",SFMono-Regular,Menlo,monospace;color:#f5f5f7;white-space:pre-wrap;word-break:break-all}
.s2-tw.s2-pst{background:#012456}
.s2-p{color:#30d158}
.s2-ps .s2-p{color:#f5f5f7}
.s2-caret{display:inline-block;width:8px;height:16px;background:#f5f5f7;vertical-align:-3px;animation:s2blink 1s steps(1) infinite}
@keyframes s2blink{50%{opacity:0}}
.s2-out{margin-top:12px}
.s2-l{opacity:0;transform:translateY(6px);transition:opacity .45s ${E},transform .5s ${E};margin-top:4px}
.s2-dim{color:#8e8e93}.s2-g{color:#30d158}
.s2-l.s2-big{margin-top:12px;padding:8px 10px;border-radius:9px;background:rgba(48,209,88,.12);color:#4ade80}
/* members */
.s2-mem{position:absolute;left:50%;top:104px;width:760px;margin-left:-380px;padding:22px 28px 10px;opacity:0;transform:translateY(40px) scale(.94);transition:opacity .8s ${E},transform .9s ${E}}
.s2-mhead{display:flex;align-items:center;gap:12px;margin-bottom:6px}
.s2-mhead .s2-h2{font-size:22px}
.s2-mroom{font-size:14px;color:#6e6e73}
.s2-pill{margin-left:auto;display:inline-flex;align-items:center;gap:8px;padding:4px 12px;border-radius:999px;background:rgba(31,157,58,.1);color:#1f9d3a;font-size:14px;font-weight:600}
.s2-m{display:grid;grid-template-columns:52px minmax(0,1fr) auto;column-gap:16px;align-items:center;padding:14px 0;opacity:0;transform:translateY(14px);transition:opacity .55s ${E},transform .65s ${E}}
.s2-m+.s2-m{border-top:1px solid rgba(0,0,0,.08)}
.s2-av{position:relative;width:52px;height:52px;border-radius:50%;display:grid;place-items:center;color:#fff;font-size:21px;font-weight:600}
.s2-av i{position:absolute;right:-1px;bottom:-1px;width:16px;height:16px;border-radius:50%;background:#28cd41;border:3px solid #fff;transform:scale(0);transition:transform .5s cubic-bezier(.3,1.6,.5,1)}
.s2-mname{font-size:19px;font-weight:600;letter-spacing:-.02em;display:flex;align-items:center;gap:10px}
.s2-mos{font-size:14px;color:#6e6e73;font-weight:400}
.s2-offers{display:flex;gap:6px;margin-top:6px}
.s2-offer{padding:3px 11px;border-radius:999px;font-size:14px;font-weight:500;color:#0066cc;background:rgba(0,113,227,.09);opacity:0;transform:scale(.8);transition:opacity .4s ${E},transform .5s cubic-bezier(.3,1.5,.5,1)}
.s2-state{font-size:14px;color:#1f9d3a;font-weight:500}
.s2-tag{position:absolute;left:0;right:0;top:470px;text-align:center;opacity:0;transform:translateY(16px);transition:opacity .8s ${E},transform .9s ${E}}
.s2-tagline{font-size:40px;font-weight:700;letter-spacing:-.035em}
.s2-tagline span{color:#6e6e73}
.s2-agents{margin-top:18px;display:flex;justify-content:center;gap:10px}
.s2-agent{font-size:15px;font-weight:500;background:#fff;border:1px solid rgba(0,0,0,.08);border-radius:999px;padding:6px 16px;box-shadow:0 1px 2px rgba(0,0,0,.04);opacity:0;transform:translateY(8px);transition:opacity .5s ${E},transform .6s ${E}}
`;

    root.innerHTML = "";
    const wrap = document.createElement("div");
    wrap.className = "s2-root";
    const tl = '<span class="s2-tl" style="background:#ff5f57"></span><span class="s2-tl" style="background:#febc2e"></span><span class="s2-tl" style="background:#28c840"></span>';
    wrap.innerHTML = `<style>${css}</style>
<div class="s2-cap"><b>01</b> · Start a room in one click</div>
<div class="s2-br">
  <div class="s2-bar">${tl}
    <div class="s2-url"><svg viewBox="0 0 11 12"><rect x="1" y="5" width="9" height="7" rx="1.5" fill="#8e8e93"/><path d="M3 5V3.5a2.5 2.5 0 015 0V5" stroke="#8e8e93" stroke-width="1.4" fill="none"/></svg><span class="s2-urlt">${HOST}</span></div>
  </div>
  <div class="s2-vp">
    <div class="s2-nav"><div class="s2-brand"><span class="s2-mark">${LOGO}</span>mesh</div><span class="s2-badge">${ROOM}</span>
      <span class="s2-status"><span class="s2-dot"></span>Live</span></div>
    <div class="s2-page s2-door-page">
      <div class="s2-head"><div class="s2-eye">For Claude Code, Codex and Cursor</div>
        <div class="s2-h1">A meeting room<br>for your coding agents.</div>
        <div class="s2-lede">Everyone’s assistant joins one room and borrows each other’s tools, with a click to approve.</div></div>
      <div class="s2-card s2-door">
        <div><div class="s2-h2">Start a session</div><div class="s2-muted">Creates a room and gives you a link to send your team.</div><span class="s2-btn s2-start">Start a session</span></div>
        <div><div class="s2-h2">Join a room</div><div class="s2-muted">Someone sent you a link? Paste it here.</div><div class="s2-field"><span class="s2-input s2-mono">https://…/r/room#k=…</span><span class="s2-ghost">Open</span></div></div>
      </div>
    </div>
    <div class="s2-page s2-room-page s2-off">
      <div class="s2-rhead"><div class="s2-eye">Room ${ROOM}</div><div class="s2-rh1">Bring your coding assistant into the room.</div></div>
      <div class="s2-rgrid">
        <div class="s2-card">
          <div class="s2-step"><span class="s2-num s2-done">${CHECK}</span><div class="s2-stitle">Choose your name <span>· dev</span></div></div>
          <div class="s2-step"><span class="s2-num s2-now">2</span><div class="s2-stitle">Install mesh</div>
            <div class="s2-sbody"><div class="s2-muted">One command, about 20 seconds. Needs Node.js 20 or newer.</div>
              <div class="s2-term"><div class="s2-tbar"><div class="s2-tabs"><span class="s2-tab s2-on s2-tsh">macOS / Linux</span><span class="s2-tab s2-tps">Windows</span></div><span class="s2-tcopy">Copy command</span></div>
                <div class="s2-code"><span class="s2-pr">$</span><code class="s2-cmd"></code></div></div>
              <div class="s2-ok">When you see <span class="s2-mono">● mesh running in the background</span>, you’re in.</div>
            </div></div>
        </div>
        <div class="s2-card s2-pad">
          <div class="s2-h2">Invite your team</div>
          <div class="s2-link">${ORIGIN}/r/${ROOM}<b>#k=${KEYM}</b></div>
          <div class="s2-acts"><span class="s2-copy">${CHECK}<span class="s2-copyt">Copy link</span></span></div>
          <div class="s2-note">Anyone with this link can join. Share it only with your team.</div>
        </div>
      </div>
    </div>
    <div class="s2-toast">${CHECK}Link copied. Send it to your team.</div>
  </div>
</div>
<svg class="s2-cur" viewBox="0 0 24 24"><path d="M4 2l15 11-6.5 1.2L16 21l-3 1.4-3.4-6.9L4 20z" fill="#1d1d1f" stroke="#fff" stroke-width="1.5" stroke-linejoin="round"/></svg>
<div class="s2-terms"></div>
<div class="s2-card s2-mem">
  <div class="s2-mhead"><div class="s2-h2">Teammates</div><span class="s2-mroom s2-mono">${ROOM}</span><span class="s2-pill"><span class="s2-dot"></span>3 online</span></div>
  <div class="s2-mlist"></div>
</div>
<div class="s2-tag"><div class="s2-tagline">One command. <span>No clone. No config. No shared vault.</span></div>
  <div class="s2-agents"><span class="s2-agent">Claude Code</span><span class="s2-agent">Codex</span><span class="s2-agent">Cursor</span></div></div>`;
    root.appendChild(wrap);
    const $ = (s) => wrap.querySelector(s);
    const $$ = (s) => wrap.querySelectorAll(s);
    const show = (el) => el && el.classList.add("s2-in");
    $(".s2-cmd").textContent = CMD_SH;

    // ---- people ----
    const people = [
      { name: "Dev", os: "macOS", win: false, color: "linear-gradient(135deg,#0071e3,#5ac8fa)", prompt: "dev@mbp ~ % ",
        cmd: `curl -fsSL ${ORIGIN}/install.sh | bash -s -- ${ROOM} --key ${KEYM} --as dev`,
        servers: "playwright, files", n: 2, chips: ["Playwright", "Files"] },
      { name: "Tarush", os: "Windows", win: true, color: "linear-gradient(135deg,#ff9f0a,#ff375f)", prompt: "PS C:\\Users\\tarush> ",
        cmd: `& ([scriptblock]::Create((irm ${ORIGIN}/install.ps1))) ${ROOM} --key ${KEYM} --as tarush`,
        servers: "figma, supabase", n: 2, chips: ["Figma", "Supabase"] },
      { name: "Abhi", os: "macOS", win: false, color: "linear-gradient(135deg,#30d158,#0a84ff)", prompt: "abhi@air ~ % ",
        cmd: `curl -fsSL ${ORIGIN}/install.sh | bash -s -- ${ROOM} --key ${KEYM} --as abhi`,
        servers: "vercel", n: 1, chips: ["Vercel"] },
    ];
    const terms = $(".s2-terms"), list = $(".s2-mlist");
    people.forEach((p) => {
      const t = document.createElement("div");
      t.className = "s2-tw" + (p.win ? " s2-pst" : "");
      const bar = p.win
        ? `<div class="s2-twbar s2-win"><span class="s2-winic">&gt;_</span><span class="s2-twt">Windows PowerShell · Tarush</span><span class="s2-winbtns"><span>–</span><span>□</span><span>✕</span></span></div>`
        : `<div class="s2-twbar">${tl}<span class="s2-twt">${p.name.toLowerCase()} — zsh · ${p.name}</span></div>`;
      t.innerHTML = `${bar}<div class="s2-tb${p.win ? " s2-ps" : ""}"><span class="s2-p"></span><span class="s2-typed"></span><span class="s2-caret"></span><div class="s2-out"></div></div>`;
      t.querySelector(".s2-p").textContent = p.prompt;
      const lines = [
        ["s2-dim", "mesh: downloading mesh.mjs"],
        ["s2-g", `✓ imported ${p.n} MCP server${p.n > 1 ? "s" : ""} (${p.servers})`],
        ["s2-g", "✓ Claude Code plugin installed"],
        ["s2-big", `● connected · ${p.name.toLowerCase()}@${ROOM}`],
      ];
      const out = t.querySelector(".s2-out");
      lines.forEach(([c, txt]) => { const l = document.createElement("div"); l.className = "s2-l " + c; l.textContent = txt; out.appendChild(l); });
      terms.appendChild(t);
      p.term = t;
      const m = document.createElement("div");
      m.className = "s2-m";
      m.innerHTML = `<div class="s2-av" style="background:${p.color}">${p.name[0]}<i></i></div>
<div><div class="s2-mname">${p.name}<span class="s2-mos">${p.os}</span></div><div class="s2-offers">${p.chips.map((c) => `<span class="s2-offer">${c}</span>`).join("")}</div></div>
<span class="s2-state">online</span>`;
      list.appendChild(m);
      p.row = m;
    });

    // ---- cursor ----
    const cur = $(".s2-cur");
    const pos = (el, fx = 0.5, fy = 0.55) => {
      const w = wrap.getBoundingClientRect(), r = el.getBoundingClientRect(), k = 1280 / (w.width || 1280);
      return [(r.left - w.left + r.width * fx) * k, (r.top - w.top + r.height * fy) * k];
    };
    const moveTo = (el, fx, fy) => { const [x, y] = pos(el, fx, fy); cur.style.left = x + "px"; cur.style.top = y + "px"; };
    const click = (el) => {
      cur.classList.add("s2-click"); el && el.classList.add("s2-press");
      at(170, () => { cur.classList.remove("s2-click"); el && el.classList.remove("s2-press"); });
    };

    // ---- 0-5s front door ----
    at(80, () => show($(".s2-cap")));
    at(250, () => show($(".s2-br")));
    at(1300, () => { cur.style.left = "900px"; cur.style.top = "640px"; cur.style.opacity = "1"; });
    at(1500, () => moveTo($(".s2-start"), 0.55, 0.6));
    at(2700, () => $(".s2-start").classList.add("s2-hover"));
    at(3500, () => click($(".s2-start")));
    at(3700, () => { $(".s2-start").textContent = "Creating room…"; });
    at(4400, () => {
      const u = $(".s2-urlt"); u.style.opacity = "0";
      at(250, () => { u.innerHTML = `${HOST}<em>/r/${ROOM}#k=${KEYM}</em>`; u.style.opacity = "1"; });
      $(".s2-door-page").classList.add("s2-off", "s2-gone");
    });
    // ---- 5-9s room page ----
    at(4800, () => {
      $(".s2-room-page").classList.remove("s2-off");
      $(".s2-badge").style.opacity = "1"; $(".s2-status").style.opacity = "1";
    });
    at(5200, () => moveTo($(".s2-copy"), 0.5, 0.6));
    at(6300, () => {
      const c = $(".s2-copy"); click(c);
      $(".s2-link").classList.add("s2-sel");
      c.classList.add("s2-done"); $(".s2-copyt").textContent = "Copied";

    });
    at(6700, () => moveTo($(".s2-tps"), 0.5, 0.6));
    at(7600, () => {
      click($(".s2-tps"));
      $(".s2-tsh").classList.remove("s2-on"); $(".s2-tps").classList.add("s2-on");
      const code = $(".s2-cmd"); code.style.opacity = "0";
      at(220, () => { code.textContent = CMD_PS; $(".s2-pr").textContent = "PS>"; code.style.opacity = "1"; });
    });
    at(8000, () => $(".s2-toast").classList.remove("s2-in"));
    at(8700, () => { cur.style.opacity = "0"; $(".s2-br").classList.add("s2-away"); });

    // ---- 9-15s terminals ----
    people.forEach((p, i) => {
      const base = 9000 + i * 180;
      at(base, () => show(p.term));
      at(base + 500, () => {
        const typed = p.term.querySelector(".s2-typed");
        let n = 0;
        const step = Math.max(1, Math.ceil(p.cmd.length / 40));
        const iv = every(26, () => {
          n = Math.min(p.cmd.length, n + step);
          typed.textContent = p.cmd.slice(0, n);
          if (n >= p.cmd.length) {
            clearInterval(iv);
            p.term.querySelector(".s2-caret").style.display = "none";
            p.term.querySelectorAll(".s2-l").forEach((l, j) => at(300 + j * 700 + i * 150, () => show(l)));
          }
        });
      });
    });

    // ---- 15-20s members ----
    at(14900, () => people.forEach((p, i) => at(i * 80, () => p.term.classList.add("s2-fold"))));
    at(15300, () => show($(".s2-mem")));
    people.forEach((p, i) => {
      const base = 15700 + i * 320;
      at(base, () => show(p.row));
      at(base + 260, () => { p.row.querySelector(".s2-av i").style.transform = "scale(1)"; });
      p.row.querySelectorAll(".s2-offer").forEach((c, j) => at(base + 380 + j * 120, () => show(c)));
    });
    at(17000, () => show($(".s2-tag")));
    $$(".s2-agent").forEach((a, i) => at(17500 + i * 120, () => show(a)));

    return () => {
      timers.forEach((t) => { clearTimeout(t); clearInterval(t); });
      timers.length = 0;
    };
  },
});
