(window.MESH_SCENES = window.MESH_SCENES || []).push({
  id: 6, title: "Safe by default", duration: 20000,
  mount(root) {
    const T = [];
    const at = (ms, fn) => T.push(setTimeout(fn, ms));
    const E = "cubic-bezier(.2,.8,.2,1)", MV = "cubic-bezier(.4,0,.2,1)";
    const F = '-apple-system,BlinkMacSystemFont,"SF Pro Display","Inter",system-ui,sans-serif';
    const M = '"SF Mono",SFMono-Regular,Menlo,monospace';
    const LOGO = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="3.5" cy="4" r="2"/><circle cx="12.5" cy="4" r="2"/><circle cx="8" cy="12.5" r="2"/><path d="M5.5 4h5M4.6 5.8l2.3 5M11.4 5.8l-2.3 5"/></svg>';
    const css = `
.s6-root{position:absolute;inset:0;font-family:${F};color:#1d1d1f;background:#f5f5f7;overflow:hidden;-webkit-font-smoothing:antialiased;letter-spacing:-.01em}
.s6-cap{position:absolute;left:40px;top:28px;z-index:60;font-size:18px;font-weight:600;color:#6e6e73;background:rgba(255,255,255,.8);backdrop-filter:blur(20px);-webkit-backdrop-filter:blur(20px);padding:8px 16px;border-radius:999px;box-shadow:0 0 0 .5px rgba(0,0,0,.07),0 6px 20px -6px rgba(0,0,0,.12);transition:opacity .6s ${E},transform .6s ${E}}
.s6-cap b{color:#0071e3;margin-right:2px}
.s6-st{position:absolute;inset:0;opacity:0;pointer-events:none;transition:opacity .7s ${E},transform .9s ${E};transform:scale(1.02)}
.s6-st.in{opacity:1;transform:none}.s6-st.out{opacity:0;transform:scale(.97)}
.s6-mark{display:grid;place-items:center;background:#1d1d1f;color:#fff}
/* stage 1: terminal + overlay */
.s6-term{position:absolute;left:64px;top:170px;width:640px;height:400px;background:#1c1c1e;border-radius:18px;box-shadow:0 30px 80px -20px rgba(0,0,0,.35),0 0 0 .5px rgba(0,0,0,.2);overflow:hidden;color:#e5e5ea;font:15px/1.7 ${M};transform:translateY(24px);opacity:0;transition:transform .9s ${E},opacity .7s ${E}}
.s6-term.in{transform:none;opacity:1}
.s6-tb{height:40px;display:flex;align-items:center;gap:8px;padding:0 16px;background:#2c2c2e;color:#8e8e93;font:14px ${F}}
.s6-tb i{width:12px;height:12px;border-radius:50%}
.s6-tb span{margin-left:auto;margin-right:auto;transform:translateX(-26px)}
.s6-tbody{padding:20px 24px}
.s6-l{opacity:0;transform:translateY(6px);transition:opacity .45s ${E},transform .45s ${E};white-space:pre-wrap}
.s6-l.in{opacity:1;transform:none}
.s6-l+.s6-l{margin-top:10px}
.s6-d{color:#8e8e93}.s6-b{color:#64d2ff}.s6-o{color:#ff9f0a}.s6-r{color:#ff6961}.s6-w{color:#fff}
.s6-say{font-family:${F};font-size:18px;line-height:1.45;color:#fff;font-weight:500}
.s6-spin{display:inline-block;width:12px;height:12px;border:2px solid #636366;border-top-color:#ff9f0a;border-radius:50%;vertical-align:-1px;margin-right:8px;animation:s6sp .8s linear infinite}
@keyframes s6sp{to{transform:rotate(360deg)}}
.s6-ov{position:absolute;right:64px;top:170px;width:470px;border-radius:16px;background:rgba(255,255,255,.86);backdrop-filter:blur(24px) saturate(1.6);-webkit-backdrop-filter:blur(24px) saturate(1.6);box-shadow:0 0 0 .5px rgba(0,0,0,.08),0 30px 80px -20px rgba(0,0,0,.25);transform:translateX(60px);opacity:0;transition:transform 1s ${E},opacity .7s ${E};overflow:hidden}
.s6-ov.in{transform:none;opacity:1}
.s6-hd{display:flex;align-items:center;gap:10px;padding:14px 16px 10px}
.s6-hd .s6-mark{width:28px;height:28px;border-radius:7px}.s6-hd .s6-mark svg{width:17px;height:17px}
.s6-hd .nm{font-size:16px;font-weight:600}.s6-hd .rm{font-size:14px;color:#6e6e73}
.s6-main{padding:4px 14px 14px}
.s6-sh{display:flex;align-items:center;gap:8px;margin:6px 2px 10px;font-size:14px;font-weight:600;color:#6e6e73}
.s6-badge{min-width:20px;height:20px;padding:0 6px;border-radius:999px;background:#0071e3;color:#fff;font:600 13px/20px ${F};text-align:center;transform:scale(0);transition:transform .5s ${E}}
.s6-badge.in{transform:scale(1)}
.s6-req{padding:16px;border-radius:12px;background:#fff;box-shadow:0 0 0 .5px rgba(0,0,0,.07),0 1px 2px rgba(0,0,0,.04),0 6px 16px -6px rgba(0,0,0,.1);opacity:0;transform:translateY(8px);transition:opacity .5s ${E},transform .5s ${E},box-shadow .5s}
.s6-req.in{opacity:1;transform:none;box-shadow:0 0 0 3px rgba(0,113,227,.28),0 6px 16px -6px rgba(0,0,0,.1)}
.s6-req.done{box-shadow:0 0 0 .5px rgba(0,0,0,.07),0 6px 16px -6px rgba(0,0,0,.1)}
.s6-rh{display:flex;align-items:center;gap:10px}
.s6-av{width:32px;height:32px;border-radius:50%;display:grid;place-items:center;background:rgba(0,113,227,.14);color:#0066cc;font-size:15px;font-weight:600}
.s6-who b{display:block;font-size:15px;font-weight:600}.s6-who span{font-size:14px;color:#6e6e73}
.s6-rh time{margin-left:auto;align-self:flex-start;font-size:14px;color:#8e8e93}
.s6-why{margin-top:12px;font-size:15px}
.s6-code{margin-top:8px;padding:10px 12px;border-radius:8px;background:rgba(0,0,0,.045);font:14px/1.5 ${M}}
.s6-code .k{color:#6e6e73}
.s6-acts{display:flex;gap:8px;margin-top:14px}
.s6-btn{flex:1;height:40px;border-radius:9px;display:grid;place-items:center;font-size:15px;font-weight:600;background:rgba(0,0,0,.045);color:#1d1d1f;transition:transform .12s ${MV},background .2s}
.s6-btn.ok{background:#0071e3;color:#fff}
.s6-btn.hov{background:rgba(0,0,0,.09)}.s6-btn.prs{transform:scale(.95)}
.s6-res{display:none;align-items:center;gap:10px;margin-top:14px;padding:10px 12px;border-radius:9px;background:rgba(215,0,21,.09);color:#d70015;font-size:15px;font-weight:600;animation:s6in .4s ${E}}
@keyframes s6in{from{opacity:0;transform:translateY(4px)}}
.s6-res svg{width:18px;height:18px}
.s6-feed{margin:16px 2px 0;font:14px/1.6 ${M};min-height:52px}
.s6-feed div{opacity:0;transition:opacity .4s}.s6-feed div.in{opacity:1}
.s6-feed .t{color:#8e8e93}.s6-feed .no{color:#d70015}
.s6-ft{display:flex;align-items:center;gap:8px;padding:10px 16px;border-top:1px solid rgba(0,0,0,.08);font-size:14px;color:#6e6e73}
.s6-dot{width:8px;height:8px;border-radius:50%;background:#248a3d}
/* stage 2 */
.s6-tiles{position:absolute;left:64px;right:64px;top:104px;display:grid;grid-template-columns:repeat(3,1fr);gap:20px}
.s6-tile{background:#fff;border-radius:20px;padding:22px 24px;box-shadow:0 0 0 .5px rgba(0,0,0,.06),0 10px 30px -12px rgba(0,0,0,.14);opacity:0;transform:translateY(18px);transition:opacity .6s ${E},transform .7s ${E}}
.s6-tile.in{opacity:1;transform:none}
.s6-ti{width:40px;height:40px;border-radius:11px;display:grid;place-items:center;margin-bottom:14px}
.s6-ti svg{width:22px;height:22px}
.s6-tile h3{margin:0;font-size:20px;font-weight:600;letter-spacing:-.02em}
.s6-tile p{margin:6px 0 0;font-size:15px;line-height:1.4;color:#6e6e73}
.s6-room{position:absolute;left:50%;top:318px;width:640px;margin-left:-320px;height:330px;background:#fff;border-radius:20px;box-shadow:0 0 0 .5px rgba(0,0,0,.06),0 24px 60px -20px rgba(0,0,0,.2);overflow:hidden;opacity:0;transform:translateY(24px);transition:opacity .7s ${E},transform .8s ${E}}
.s6-room.in{opacity:1;transform:none}
.s6-rnav{height:50px;display:flex;align-items:center;gap:10px;padding:0 20px;border-bottom:1px solid rgba(0,0,0,.08);font-size:17px;font-weight:600}
.s6-rnav .s6-mark{width:24px;height:24px;border-radius:6px}.s6-rnav .s6-mark svg{width:15px;height:15px}
.s6-rbadge{font:500 14px/1.6 ${M};color:#6e6e73;padding:1px 10px;border-radius:999px;background:rgba(0,0,0,.04);border:1px solid rgba(0,0,0,.08)}
.s6-rstat{margin-left:auto;display:flex;align-items:center;gap:7px;font-size:14px;font-weight:400;color:#6e6e73}
.s6-pd{width:9px;height:9px;border-radius:50%;background:#28cd41;box-shadow:0 0 0 3px rgba(40,205,65,.22);transition:background .5s,box-shadow .5s}
.s6-off .s6-pd{background:#86868b;box-shadow:none}
.s6-rbody{position:relative;padding:18px 24px}
.s6-mem{display:flex;align-items:center;gap:12px;padding:9px 0;transition:opacity .5s}
.s6-mem+.s6-mem{border-top:1px solid rgba(0,0,0,.08)}
.s6-ava{position:relative;width:36px;height:36px;border-radius:50%;background:rgba(0,0,0,.07);display:grid;place-items:center;font-size:14px;font-weight:600}
.s6-ava i{position:absolute;right:-1px;bottom:-1px;width:12px;height:12px;border-radius:50%;background:#28cd41;border:2px solid #fff;transition:background .5s}
.s6-off .s6-ava i{background:#86868b}
.s6-off .s6-mem{opacity:.55}
.s6-mem b{font-size:15px;font-weight:600}
.s6-mem>span:last-child{margin-left:auto;font-size:14px;color:#1f9d3a;transition:color .5s}
.s6-off .s6-mem>span:last-child{color:#86868b}
.s6-end{display:flex;align-items:center;gap:14px;margin-top:14px;padding-top:14px;border-top:1px solid rgba(0,0,0,.08)}
.s6-endb{height:38px;padding:0 16px;border-radius:999px;display:inline-flex;align-items:center;font-size:15px;font-weight:500;color:#d70015;border:1px solid rgba(215,0,21,.3);transition:background .2s,color .2s,transform .12s}
.s6-endb.armed{background:#d70015;color:#fff;border-color:#d70015}
.s6-endb.prs{transform:scale(.96)}
.s6-end p{margin:0;font-size:14px;color:#6e6e73}
.s6-notice{position:absolute;inset:50px 0 0;background:#fff;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;opacity:0;transform:scale(.98);transition:opacity .6s ${E},transform .7s ${E}}
.s6-notice.in{opacity:1;transform:none}
.s6-glyph{width:52px;height:52px;border-radius:50%;background:rgba(0,0,0,.07);color:#6e6e73;display:grid;place-items:center;margin-bottom:14px}
.s6-glyph svg{width:24px;height:24px}
.s6-notice h4{margin:0;font-size:28px;font-weight:700;letter-spacing:-.025em}
.s6-notice p{margin:8px 0 0;max-width:440px;font-size:15px;line-height:1.45;color:#6e6e73}
/* stage 3 */
.s6-h2{position:absolute;left:0;right:0;top:108px;text-align:center;font-size:44px;font-weight:700;letter-spacing:-.035em;opacity:0;transform:translateY(14px);transition:opacity .7s ${E},transform .8s ${E}}
.s6-h2.in{opacity:1;transform:none}
.s6-net{position:absolute;left:0;top:0;width:1280px;height:720px}
.s6-net path{fill:none;stroke:#0071e3;stroke-width:2;stroke-linecap:round;stroke-dasharray:6 8;opacity:0;transition:opacity .6s}
.s6-net path.in{opacity:.55;animation:s6dash 1.2s linear infinite}
@keyframes s6dash{to{stroke-dashoffset:-28}}
.s6-hub{position:absolute;left:640px;top:520px;width:104px;height:104px;margin:-52px;border-radius:26px;box-shadow:0 20px 50px -12px rgba(0,0,0,.4),0 0 0 10px rgba(0,113,227,.08);transform:scale(.6);opacity:0;transition:transform .8s ${E},opacity .5s}
.s6-hub.in{transform:none;opacity:1}
.s6-hub svg{width:60px;height:60px}
.s6-pill{position:absolute;top:290px;height:64px;margin-left:-110px;width:220px;border-radius:999px;background:#fff;box-shadow:0 0 0 .5px rgba(0,0,0,.07),0 14px 36px -12px rgba(0,0,0,.2);display:flex;align-items:center;justify-content:center;gap:12px;font-size:20px;font-weight:600;opacity:0;transform:translateY(16px);transition:opacity .6s ${E},transform .7s ${E}}
.s6-pill.in{opacity:1;transform:none}
.s6-pi{width:34px;height:34px;border-radius:10px;display:grid;place-items:center;color:#fff}
.s6-pi svg{width:20px;height:20px}
.s6-ok{position:absolute;right:-6px;top:-6px;width:22px;height:22px;border-radius:50%;background:#30d158;display:grid;place-items:center;box-shadow:0 0 0 3px #f5f5f7;transform:scale(0);transition:transform .45s ${E}}
.s6-ok.in{transform:scale(1)}
.s6-ok svg{width:12px;height:12px}
/* stage 4 */
.s6-cta{background:#fff;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center}
.s6-cta>*{opacity:0;transform:translateY(16px);transition:opacity .8s ${E},transform .9s ${E}}
.s6-cta.in>*{opacity:1;transform:none}
.s6-cta.in>:nth-child(2){transition-delay:.15s}.s6-cta.in>:nth-child(3){transition-delay:.35s}.s6-cta.in>:nth-child(4){transition-delay:.9s}
.s6-brand{display:flex;align-items:center;gap:18px;font-size:48px;font-weight:600;letter-spacing:-.03em}
.s6-brand .s6-mark{width:88px;height:88px;border-radius:22px;box-shadow:0 18px 40px -14px rgba(0,0,0,.45)}
.s6-brand .s6-mark svg{width:54px;height:54px}
.s6-hl{margin-top:40px;font-size:60px;line-height:1.05;font-weight:700;letter-spacing:-.045em;max-width:1000px}
.s6-sub{margin-top:18px;font-size:26px;color:#6e6e73;letter-spacing:-.015em}
.s6-row{margin-top:44px;display:flex;align-items:center;gap:14px}
.s6-url{height:52px;padding:0 22px;border-radius:999px;background:#f5f5f7;border:1px solid rgba(0,0,0,.08);display:flex;align-items:center;gap:10px;font:500 17px ${M};color:#1d1d1f}
.s6-url svg{width:16px;height:16px;color:#6e6e73}
.s6-go{height:52px;padding:0 28px;border-radius:999px;background:#0071e3;color:#fff;display:flex;align-items:center;font-size:18px;font-weight:600;animation:s6pulse 2s ${MV} 1.6s infinite}
@keyframes s6pulse{0%,100%{box-shadow:0 0 0 0 rgba(0,113,227,.35)}50%{box-shadow:0 0 0 12px rgba(0,113,227,0)}}
.s6-cur{position:absolute;left:760px;top:760px;width:26px;height:34px;z-index:70;pointer-events:none;filter:drop-shadow(0 3px 5px rgba(0,0,0,.3));transition:left 1.1s ${MV},top 1.1s ${MV},transform .12s,opacity .4s}
.s6-cur.prs{transform:scale(.85)}
.s6-rip{position:absolute;z-index:69;width:24px;height:24px;margin:-12px;border-radius:50%;background:rgba(0,113,227,.35);pointer-events:none;animation:s6rip .6s ${E} forwards}
@keyframes s6rip{to{transform:scale(3.4);opacity:0}}
`;
    const ic = {
      check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>',
      x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="m9 9 6 6M15 9l-6 6"/></svg>',
      shield: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3 5 6v5c0 4.5 3 8.3 7 10 4-1.7 7-5.5 7-10V6z"/><path d="m9 12 2 2 4-4"/></svg>',
      feed: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M3 12h4l3-7 4 14 3-7h4"/></svg>',
      stop: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="9"/><rect x="9" y="9" width="6" height="6" rx="1" fill="currentColor" stroke="none"/></svg>',
      link: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/></svg>',
      cc: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2.5l1.6 6.2 6.2-2.4-4.3 5 5 3.9-6.4.3.9 6.4-3-5.7-3 5.7.9-6.4-6.4-.3 5-3.9-4.3-5 6.2 2.4z"/></svg>',
      codex: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m8 8-4 4 4 4M16 8l4 4-4 4M13.5 5l-3 14"/></svg>',
      cursor: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M12 2 3 7v10l9 5 9-5V7z"/><path d="M12 22V12L3 7M12 12l9-5"/></svg>',
    };
    const mark = (cls) => `<span class="s6-mark ${cls || ""}">${LOGO}</span>`;
    root.innerHTML = `<style>${css}</style><div class="s6-root">
  <div class="s6-cap"><b>05</b> · Every request needs a yes</div>

  <div class="s6-st" id="a">
    <div class="s6-term"><div class="s6-tb"><i style="background:#ff5f57"></i><i style="background:#febc2e"></i><i style="background:#28c840"></i><span>dev — claude</span></div>
      <div class="s6-tbody">
        <div class="s6-l"><span class="s6-d">&gt;</span> <span class="s6-w">Ship onboarding step 2 to production</span></div>
        <div class="s6-l"><span class="s6-b">⏺ mesh · ask_teammate</span><span class="s6-d">(</span>abhi<span class="s6-d">,</span> <span class="s6-o">"vercel deploy --prod"</span><span class="s6-d">)</span></div>
        <div class="s6-l s6-d" id="wait"><span class="s6-spin"></span>waiting for abhi to approve…</div>
        <div class="s6-l s6-r" id="den">  ⎿ denied — owner declined</div>
        <div class="s6-l s6-say" style="margin-top:22px"><span class="s6-w">⏺</span> Abhi declined the production deploy. Leaving prod untouched.</div>
      </div></div>
    <div class="s6-ov"><div class="s6-hd">${mark()}<span class="nm">mesh</span><span class="rm">· tango-bc7d92eb</span></div>
      <div class="s6-main">
        <div class="s6-sh">Pending <span class="s6-badge">1</span></div>
        <div class="s6-req"><div class="s6-rh"><span class="s6-av">D</span><span class="s6-who"><b>dev</b><span>wants to run on your machine</span></span><time>now</time></div>
          <div class="s6-why">Ship onboarding step 2</div>
          <div class="s6-code"><span class="k">$</span> vercel deploy --prod</div>
          <div class="s6-acts"><div class="s6-btn ok">Approve</div><div class="s6-btn" id="deny">Deny</div></div>
          <div class="s6-res">${ic.x}Denied · nothing ran</div>
        </div>
        <div class="s6-sh" style="margin-top:16px">Live</div>
        <div class="s6-feed"><div><span class="t">14:02</span> dev → vercel deploy --prod</div><div><span class="t">14:02</span> <span class="no">✕ abhi denied</span></div></div>
      </div>
      <div class="s6-ft"><span class="s6-dot"></span>daemon connected <span style="color:#8e8e93">· relay ok</span></div>
    </div>
  </div>

  <div class="s6-st" id="b">
    <div class="s6-tiles">
      <div class="s6-tile"><div class="s6-ti" style="background:rgba(0,113,227,.1);color:#0066cc">${ic.shield}</div><h3>Approve per request</h3><p>Overlay, native dialog, or right in Claude Code.</p></div>
      <div class="s6-tile"><div class="s6-ti" style="background:rgba(36,138,61,.1);color:#248a3d">${ic.feed}</div><h3>Live room feed</h3><p>Every prompt, tool call and result.</p></div>
      <div class="s6-tile"><div class="s6-ti" style="background:rgba(215,0,21,.08);color:#d70015">${ic.stop}</div><h3>Leave or end anytime</h3><p>The owner ends the session; the link stops working.</p></div>
    </div>
    <div class="s6-room"><div class="s6-rnav">${mark()}mesh <span class="s6-rbadge">tango-bc7d92eb</span><span class="s6-rstat"><span class="s6-pd"></span><span id="rs">Live</span></span></div>
      <div class="s6-rbody">
        <div class="s6-mem"><span class="s6-ava">D<i></i></span><b>dev</b><span>online</span></div>
        <div class="s6-mem"><span class="s6-ava">T<i></i></span><b>tarush</b><span>online</span></div>
        <div class="s6-mem"><span class="s6-ava">A<i></i></span><b>abhi</b><span>online</span></div>
        <div class="s6-end"><span class="s6-endb">End session for everyone</span><p>You started this session, so only you can end it.</p></div>
      </div>
      <div class="s6-notice"><div class="s6-glyph">${ic.stop}</div><h4>This session has ended</h4><p>Everyone was disconnected and this link no longer works.</p></div>
    </div>
  </div>

  <div class="s6-st" id="c">
    <div class="s6-h2">Works with the agents you already use</div>
    <svg class="s6-net" viewBox="0 0 1280 720"><path d="M340 354 C340 460 520 520 590 520"/><path d="M640 354 L640 468"/><path d="M940 354 C940 460 760 520 690 520"/></svg>
    <div class="s6-pill" style="left:340px"><span class="s6-pi" style="background:#d97757">${ic.cc}</span>Claude Code<span class="s6-ok">${ic.check.replace('stroke="currentColor"', 'stroke="#fff"')}</span></div>
    <div class="s6-pill" style="left:640px"><span class="s6-pi" style="background:#1d1d1f">${ic.codex}</span>Codex<span class="s6-ok">${ic.check.replace('stroke="currentColor"', 'stroke="#fff"')}</span></div>
    <div class="s6-pill" style="left:940px"><span class="s6-pi" style="background:#5b5bd6">${ic.cursor}</span>Cursor<span class="s6-ok">${ic.check.replace('stroke="currentColor"', 'stroke="#fff"')}</span></div>
    <div class="s6-hub s6-mark">${LOGO}</div>
  </div>

  <div class="s6-st s6-cta" id="d">
    <div class="s6-brand">${mark()}mesh</div>
    <div class="s6-hl">Borrow a teammate's machine,<br>not their credentials.</div>
    <div class="s6-sub">One command. No clone. No vault.</div>
    <div class="s6-row"><div class="s6-url">${ic.link}relay-production-8eef.up.railway.app</div><div class="s6-go">Start a session</div></div>
  </div>

  <svg class="s6-cur" viewBox="0 0 26 34"><path d="M2 2v26l7-6.5 4.5 10 4-1.8-4.4-9.8H22z" fill="#1d1d1f" stroke="#fff" stroke-width="2" stroke-linejoin="round"/></svg>
</div>`;
    const q = (s) => root.querySelector(s), qa = (s) => [...root.querySelectorAll(s)];
    const add = (el, c) => el && el.classList.add(c), rm = (el, c) => el && el.classList.remove(c);
    const cur = q(".s6-cur"), rootEl = q(".s6-root");
    const moveCur = (el, dx, dy) => { const r = el.getBoundingClientRect(), b = rootEl.getBoundingClientRect(); const sx = b.width / 1280 || 1; cur.style.left = ((r.left - b.left) / sx + dx) + "px"; cur.style.top = ((r.top - b.top) / sx + dy) + "px"; };
    const click = (el) => { add(cur, "prs"); add(el, "prs"); const rp = document.createElement("div"); rp.className = "s6-rip"; rp.style.left = (parseFloat(cur.style.left) + 3) + "px"; rp.style.top = (parseFloat(cur.style.top) + 3) + "px"; rootEl.appendChild(rp); at(160, () => { rm(cur, "prs"); rm(el, "prs"); }); at(700, () => rp.remove()); };

    // stage 1: denial (0-6s)
    const A = q("#a"), L = qa("#a .s6-l");
    at(50, () => { add(A, "in"); add(q(".s6-term"), "in"); });
    at(500, () => add(L[0], "in"));
    at(1000, () => add(L[1], "in"));
    at(1300, () => { add(q(".s6-ov"), "in"); });
    at(1500, () => add(L[2], "in"));
    at(1800, () => { add(q(".s6-badge"), "in"); add(q(".s6-req"), "in"); add(qa(".s6-feed div")[0], "in"); });
    at(2300, () => moveCur(q("#deny"), 80, 16));
    at(3300, () => add(q("#deny"), "hov"));
    at(3600, () => { click(q("#deny")); });
    at(3800, () => { q(".s6-acts").style.display = "none"; q(".s6-res").style.display = "flex"; add(q(".s6-req"), "done"); rm(q(".s6-badge"), "in"); add(qa(".s6-feed div")[1], "in"); cur.style.opacity = "0"; });
    at(4200, () => { L[2].style.display = "none"; add(L[3], "in"); });
    at(4800, () => add(L[4], "in"));
    at(6000, () => { add(A, "out"); });

    // stage 2: features + end session (6-11s)
    const B = q("#b");
    at(6300, () => { add(B, "in"); qa(".s6-tile").forEach((t, i) => at(i * 160, () => add(t, "in"))); });
    at(6900, () => add(q(".s6-room"), "in"));
    at(7500, () => { cur.style.transition = "none"; cur.style.left = "900px"; cur.style.top = "700px"; cur.offsetWidth; cur.style.transition = ""; cur.style.opacity = "1"; moveCur(q(".s6-endb"), 110, 22); });
    at(8500, () => { click(q(".s6-endb")); add(q(".s6-endb"), "armed"); q(".s6-endb").textContent = "Click again to end it for everyone"; });
    at(9100, () => { click(q(".s6-endb")); q(".s6-endb").textContent = "Ending…"; });
    at(9400, () => { add(q(".s6-room"), "s6-off"); q("#rs").textContent = "Ended"; qa(".s6-mem>span:last-child").forEach((s) => (s.textContent = "offline")); cur.style.opacity = "0"; });
    at(10000, () => add(q(".s6-notice"), "in"));
    at(11000, () => add(B, "out"));

    // stage 3: agents (11-15s)
    const C = q("#c");
    at(11300, () => { add(C, "in"); add(q(".s6-h2"), "in"); });
    qa(".s6-pill").forEach((p, i) => at(11600 + i * 180, () => add(p, "in")));
    at(12200, () => add(q(".s6-hub"), "in"));
    qa(".s6-net path").forEach((p, i) => at(12500 + i * 150, () => add(p, "in")));
    qa(".s6-ok").forEach((p, i) => at(13000 + i * 200, () => add(p, "in")));
    at(14900, () => { add(C, "out"); q(".s6-cap").style.opacity = "0"; });

    // stage 4: CTA (15-20s)
    at(15200, () => { add(q("#d"), "in"); });

    return () => { T.forEach(clearTimeout); T.length = 0; root.querySelectorAll("*").forEach((el) => el.getAnimations && el.getAnimations().forEach((a) => a.cancel())); root.innerHTML = ""; };
  },
});
