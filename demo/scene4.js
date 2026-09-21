(window.MESH_SCENES = window.MESH_SCENES || []).push({
  id: 4, title: "Approve + handoff", duration: 20000,
  mount(root) {
    const T = [], A = [];
    const at = (ms, fn) => T.push(setTimeout(fn, ms));
    const E = "cubic-bezier(.2,.8,.2,1)", MV = "cubic-bezier(.4,0,.2,1)";
    const F = '-apple-system,BlinkMacSystemFont,"SF Pro Display","Inter",system-ui,sans-serif';
    const M = '"SF Mono",SFMono-Regular,Menlo,monospace';
    const LOGO = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="3.5" cy="4" r="2"/><circle cx="12.5" cy="4" r="2"/><circle cx="8" cy="12.5" r="2"/><path d="M5.5 4h5M4.6 5.8l2.3 5M11.4 5.8l-2.3 5"/></svg>';
    const ic = d => '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">' + d + '</svg>';
    const CHECK = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 8.5l3 3 6-7"/></svg>';
    const FRAME_SVG = '<svg viewBox="0 0 160 100" xmlns="http://www.w3.org/2000/svg">' +
      '<rect width="160" height="100" fill="#fbfbfd"/>' +
      '<circle cx="12" cy="10" r="3" fill="#0071e3"/><rect x="18" y="8" width="22" height="4" rx="2" fill="#1d1d1f" opacity=".75"/>' +
      '<rect x="116" y="8.5" width="6" height="3" rx="1.5" fill="#d2d2d7"/><rect x="124" y="8.5" width="12" height="3" rx="1.5" fill="#0071e3"/>' +
      '<rect x="138" y="8.5" width="6" height="3" rx="1.5" fill="#d2d2d7"/><rect x="146" y="8.5" width="6" height="3" rx="1.5" fill="#d2d2d7"/>' +
      '<rect x="12" y="29" width="64" height="7" rx="2" fill="#1d1d1f"/><rect x="12" y="39" width="46" height="7" rx="2" fill="#1d1d1f"/>' +
      '<rect x="12" y="53" width="66" height="3" rx="1.5" fill="#86868b"/><rect x="12" y="59" width="58" height="3" rx="1.5" fill="#86868b"/>' +
      '<rect x="12" y="65" width="42" height="3" rx="1.5" fill="#86868b"/>' +
      '<rect x="12" y="76" width="34" height="11" rx="5.5" fill="#0071e3"/><rect x="19" y="80.5" width="20" height="2" rx="1" fill="#fff"/>' +
      '<rect x="50.5" y="76.5" width="27" height="10" rx="5" fill="none" stroke="#d2d2d7"/>' +
      '<rect x="90" y="21.5" width="58" height="67" rx="7" fill="#fff" stroke="#e5e5ea"/>' +
      '<rect x="96" y="28" width="46" height="27" rx="4" fill="#e8f2fd"/><circle cx="109" cy="41.5" r="7" fill="#0071e3" opacity=".85"/>' +
      '<rect x="120" y="37" width="16" height="3" rx="1.5" fill="#0071e3" opacity=".5"/><rect x="120" y="43" width="11" height="3" rx="1.5" fill="#0071e3" opacity=".35"/>' +
      '<rect x="96" y="61" width="30" height="4" rx="2" fill="#1d1d1f" opacity=".8"/>' +
      '<rect x="96" y="69" width="40" height="3" rx="1.5" fill="#86868b" opacity=".7"/><rect x="96" y="75" width="33" height="3" rx="1.5" fill="#86868b" opacity=".7"/>' +
      '<circle cx="140" cy="81" r="3.5" fill="#28cd41"/></svg>';

    const style = document.createElement("style");
    style.textContent = `
.s4-root{position:absolute;inset:0;font-family:${F};color:#1d1d1f;background:#e9e9ee;overflow:hidden;-webkit-font-smoothing:antialiased}
.s4-cap{position:absolute;left:40px;top:14px;z-index:50;font-size:20px;font-weight:600;letter-spacing:-.01em;color:#6e6e73;background:rgba(255,255,255,.78);backdrop-filter:blur(20px);-webkit-backdrop-filter:blur(20px);padding:8px 14px;border-radius:999px;box-shadow:0 4px 20px rgba(0,0,0,.08);opacity:0;transform:translateY(-8px);transition:opacity .7s ${E},transform .8s ${E}}
.s4-cap b{color:#0071e3;font-weight:600}
.s4-in{opacity:1!important;transform:none!important}
.s4-desk{position:absolute;inset:0;background:radial-gradient(900px 500px at 30% 0%,#f4f6fb 0%,transparent 70%),linear-gradient(180deg,#eceef3,#e2e4ea);transition:opacity .9s ${MV}}
.s4-desk.gone{opacity:0}
.s4-ed{position:absolute;left:40px;top:74px;width:690px;height:560px;border-radius:10px;background:#fff;box-shadow:0 20px 50px -20px rgba(0,0,0,.25),0 0 0 1px rgba(0,0,0,.06);overflow:hidden;opacity:0;transform:translateY(14px);transition:opacity .9s ${E},transform .9s ${E}}
.s4-ed.s4-in{opacity:.55!important;filter:saturate(.5)}
.s4-edbar{height:36px;display:flex;align-items:center;padding:0 0 0 14px;background:#f3f3f3;font-size:14px;color:#6e6e73;border-bottom:1px solid #e5e5ea}
.s4-edbar span{flex:1}.s4-edbar i{width:46px;height:36px;display:grid;place-items:center;font-style:normal;color:#8e8e93}
.s4-edb{display:flex;height:calc(100% - 36px)}
.s4-edside{width:54px;background:#f7f7f8;border-right:1px solid #ececef}
.s4-edcode{padding:20px 24px;display:grid;gap:13px;align-content:start;flex:1}
.s4-edcode div{height:9px;border-radius:5px}
.s4-task{position:absolute;left:0;right:0;bottom:0;height:48px;background:rgba(250,250,252,.8);backdrop-filter:blur(20px);border-top:1px solid rgba(0,0,0,.06);display:flex;align-items:center;justify-content:center;gap:10px}
.s4-task i{width:28px;height:28px;border-radius:7px;background:#d8dae0}.s4-task i:first-child{background:#0078d4}
.s4-task span{position:absolute;right:24px;font-size:14px;color:#6e6e73}
.s4-ov{position:absolute;left:760px;top:74px;width:480px;height:568px;border-radius:16px;background:#f5f5f7;box-shadow:0 30px 80px -20px rgba(0,0,0,.3),0 0 0 .5px rgba(0,0,0,.1);display:flex;flex-direction:column;overflow:hidden;opacity:0;transform:translateX(60px) scale(.98);transition:opacity .8s ${E},transform .9s ${E},height .7s ${MV}}
.s4-ov.s4-in{opacity:1}
.s4-ov.moved{transform:translateX(-720px)!important;height:620px;transition:transform 1s ${MV},height .7s ${MV},opacity .8s}
.s4-ov.out{transform:translateX(-1260px)!important;opacity:0!important}
.s4-hd{display:flex;align-items:center;gap:10px;padding:14px 14px 10px 16px}
.s4-mk{position:relative;width:30px;height:30px;border-radius:8px;background:#1d1d1f;color:#fff;display:grid;place-items:center;flex:none}.s4-mk svg{width:19px;height:19px}
.s4-wb{position:absolute;top:-6px;right:-7px;min-width:20px;height:20px;padding:0 5px;border-radius:999px;background:#0071e3;color:#fff;font:600 14px/20px ${F};text-align:center;box-shadow:0 0 0 2px #f5f5f7;transform:scale(0);transition:transform .45s ${E}}
.s4-hd .nm{font-size:18px;font-weight:600;letter-spacing:-.01em}
.s4-hd .rm{flex:1;font-size:15px;color:#6e6e73}
.s4-hd .tl{display:flex;gap:4px;color:#8e8e93}.s4-hd .tl span{width:30px;height:30px;display:grid;place-items:center}.s4-hd .tl svg{width:18px;height:18px}
.s4-main{flex:1;padding:4px 16px 12px;overflow:hidden}
.s4-sh{display:flex;align-items:center;gap:8px;margin:0 2px 10px;font-size:14px;font-weight:600;color:#6e6e73}
.s4-badge{min-width:22px;height:22px;padding:0 6px;border-radius:999px;background:#0071e3;color:#fff;font:600 14px/22px ${F};text-align:center;transform:scale(0);transition:transform .45s ${E}}
.s4-live{margin-left:auto;display:flex;align-items:center;gap:6px;color:#248a3d;font-size:14px;font-weight:600}
.s4-live i{width:8px;height:8px;border-radius:50%;background:#30d158;animation:s4pulse 1.4s ease-in-out infinite}
@keyframes s4pulse{50%{box-shadow:0 0 0 5px rgba(48,209,88,.2)}}
.s4-sec+.s4-sec{margin-top:18px}
.s4-req{position:relative;border-radius:14px;background:#fff;box-shadow:0 0 0 .5px rgba(0,0,0,.07),0 1px 2px rgba(0,0,0,.04),0 8px 20px -8px rgba(0,0,0,.12);overflow:hidden;opacity:0;transform:translateY(10px);transition:opacity .6s ${E},transform .6s ${E},height .6s ${MV},box-shadow .6s}
.s4-req.ring{animation:s4ring 1.4s ease-out 1}
@keyframes s4ring{0%{box-shadow:0 0 0 0 rgba(0,113,227,.45),0 8px 20px -8px rgba(0,0,0,.12)}100%{box-shadow:0 0 0 14px rgba(0,113,227,0),0 8px 20px -8px rgba(0,0,0,.12)}}
.s4-front{padding:16px;transition:opacity .3s}
.s4-rh{display:flex;align-items:center;gap:10px}
.s4-av{width:36px;height:36px;border-radius:50%;background:rgba(0,113,227,.12);color:#0066cc;display:grid;place-items:center;font-size:16px;font-weight:600;flex:none}
.s4-who{flex:1;line-height:1.25}.s4-who b{display:block;font-size:17px}.s4-who span{font-size:14px;color:#6e6e73}
.s4-rh time{align-self:flex-start;font-size:14px;color:#8e8e93}
.s4-why{margin:12px 0 0;font-size:15px;line-height:1.45;color:#1d1d1f;padding-left:12px;border-left:3px solid #d2d2d7}
.s4-code{margin-top:10px;padding:10px 12px;border-radius:9px;background:rgba(0,0,0,.045);font:14px/1.5 ${M};color:#1d1d1f}.s4-code .p{color:#6e6e73}
.s4-acts{display:flex;gap:10px;margin-top:14px}
.s4-btn{flex:1;position:relative;overflow:hidden;height:42px;border-radius:10px;display:grid;place-items:center;font-size:15px;font-weight:500;background:rgba(0,0,0,.05);transition:transform .12s ${MV},background-color .2s}
.s4-btn.ok{background:#0071e3;color:#fff;font-weight:600}.s4-btn.ok.hov{background:#0077ed}.s4-btn.dn{transform:scale(.96)}
.s4-rip{position:absolute;width:24px;height:24px;margin:-12px 0 0 -12px;border-radius:50%;background:rgba(255,255,255,.6);pointer-events:none}
.s4-back{position:absolute;inset:0;display:flex;align-items:center;gap:12px;padding:0 16px;opacity:0;transition:opacity .4s ${E} .15s}
.s4-gc{width:30px;height:30px;border-radius:50%;background:#30d158;color:#fff;display:grid;place-items:center;flex:none}.s4-gc svg{width:17px;height:17px}
.s4-back .tx{flex:1;font-size:15px;line-height:1.3}.s4-back .tx b{font-weight:600}.s4-back .tx span{color:#6e6e73}
.s4-back .st{font-size:14px;color:#6e6e73;display:flex;align-items:center;gap:6px;white-space:nowrap}
.s4-spin{width:16px;height:16px;border-radius:50%;border:2px solid #d2d2d7;border-top-color:#0071e3;animation:s4spin .8s linear infinite}
@keyframes s4spin{to{transform:rotate(360deg)}}
.s4-back .st.done{color:#248a3d;font-weight:600}
.s4-hwrap{height:0;opacity:0;overflow:hidden;transition:height .6s ${MV},opacity .5s ${E},margin .6s ${MV}}
.s4-hwrap.open{height:226px;opacity:1;margin-top:12px}
.s4-handoff{padding:14px 16px;border-radius:14px;background:#fff;box-shadow:0 0 0 .5px rgba(0,0,0,.07),0 8px 20px -8px rgba(0,0,0,.12)}
.s4-hh{display:flex;align-items:center;gap:7px;font-size:14px;color:#6e6e73;margin-bottom:12px}
.s4-hh svg{width:18px;height:18px;color:#0066cc}.s4-hh .fn{font-family:${M};color:#1d1d1f}
.s4-hfile{display:flex;align-items:center;gap:14px;padding:12px;border-radius:14px;background:#fbfbfd;border:1px solid rgba(0,0,0,.08)}
.s4-thumb{flex:none;width:136px;aspect-ratio:16/10;border-radius:8px;overflow:hidden;background:#fbfbfd;border:1px solid rgba(0,0,0,.14);box-shadow:0 1px 2px rgba(0,0,0,.06)}
.s4-thumb svg{display:block;width:100%;height:100%}
.s4-meta{flex:1;min-width:0}
.s4-fname{font:500 15px/1.35 ${M};color:#1d1d1f}
.s4-fsub{margin-top:3px;font-size:14px;color:#6e6e73;font-variant-numeric:tabular-nums}
.s4-prog{height:5px;margin-top:12px;border-radius:3px;background:rgba(0,0,0,.07);overflow:hidden}
.s4-prog i{display:block;height:100%;width:0;border-radius:inherit;background:#0071e3;transition:background-color .3s}
.s4-hstat{display:flex;align-items:center;gap:7px;margin-top:12px;font-size:14px;color:#86868b;transition:color .3s}
.s4-hstat svg{width:17px;height:17px}
.s4-handoff.delivered .s4-prog i{background:#1f9d3a}.s4-handoff.delivered .s4-hstat{color:#1f9d3a;font-weight:600}
.s4-feed{margin:0 2px;font:14px/1.65 ${M}}
.s4-feed .empty{font-family:${F};color:#8e8e93}
.s4-feed div.ln{opacity:0;transform:translateY(6px);transition:opacity .45s ${E},transform .45s ${E};white-space:nowrap}
.s4-feed .t{color:#8e8e93}.s4-feed .u{font-weight:600}.s4-feed .ok{color:#248a3d}.s4-feed .out{color:#6e6e73;padding-left:14px}
.s4-chip{display:inline-block;margin-left:6px;padding:0 9px;border-radius:999px;background:rgba(0,0,0,.05);color:#0066cc;font:14px/1.6 ${F}}.s4-chip span{color:#6e6e73}
.s4-ft{display:flex;align-items:center;gap:8px;padding:10px 16px;border-top:1px solid rgba(0,0,0,.08);font-size:14px;color:#6e6e73}
.s4-ft i{width:8px;height:8px;border-radius:50%;background:#248a3d}.s4-ft .r{color:#8e8e93}.s4-ft .set{margin-left:auto;font-weight:500}
.s4-cur{position:absolute;left:0;top:0;z-index:60;width:28px;height:28px;opacity:0;pointer-events:none;filter:drop-shadow(0 3px 5px rgba(0,0,0,.3))}
.s4-dev{position:absolute;left:580px;top:74px;width:660px;height:600px;border-radius:14px;background:#1c1c1e;box-shadow:0 30px 80px -20px rgba(0,0,0,.45),0 0 0 .5px rgba(0,0,0,.2);overflow:hidden;opacity:0;transform:translateX(120px);transition:opacity .9s ${E},transform 1s ${E},height .8s ${MV}}
.s4-dev.moved{transform:translateX(-540px)!important;height:548px;transition:transform 1s ${MV},height .8s ${MV}}
.s4-bar{height:44px;display:flex;align-items:center;gap:8px;padding:0 16px;border-bottom:1px solid #2c2c2e}
.s4-bar i{width:12px;height:12px;border-radius:50%}
.s4-bar span{flex:1;text-align:center;margin-right:52px;color:#8e8e93;font-size:14px;font-weight:500}
.s4-db{padding:16px 22px;font:15px/1.6 ${M};color:#e5e5ea;display:flex;flex-direction:column;gap:8px}
.s4-dl{opacity:0;transform:translateY(8px);transition:opacity .5s ${E},transform .5s ${E}}
.s4-pr{color:#8e8e93}.s4-pr b{color:#0a84ff;font-weight:400;margin-right:8px}
.s4-call{display:flex;align-items:center;gap:10px}
.s4-ci{width:16px;height:16px;position:relative;flex:none}
.s4-ci .sp{position:absolute;inset:0;border-radius:50%;border:2px solid #3a3a3c;border-top-color:#0a84ff;animation:s4spin .8s linear infinite}
.s4-ci .ck{position:absolute;inset:0;border-radius:50%;background:#30d158;color:#1c1c1e;display:grid;place-items:center;transform:scale(0);transition:transform .4s ${E}}.s4-ci .ck svg{width:11px;height:11px}
.s4-ci.done .sp{display:none}.s4-ci.done .ck{transform:scale(1)}
.s4-mesh{color:#bf5af2;font-weight:600}.s4-fnm{color:#fff;font-weight:600}.s4-arg{color:#8e8e93}
.s4-res{padding-left:26px;color:#aeaeb2;font-size:14px}.s4-res .g{color:#30d158}
.s4-art{display:flex;align-items:center;gap:14px;margin-left:26px;width:400px;padding:9px 16px 9px 9px;border-radius:12px;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.1)}
.s4-art .s4-thumb{width:112px;border:1.5px dashed rgba(255,255,255,.28);background:transparent;box-shadow:none;transition:border-color .4s}
.s4-art .s4-thumb svg{opacity:0;transition:opacity .4s}
.s4-art.landed .s4-thumb{border:1px solid rgba(255,255,255,.16)}.s4-art.landed .s4-thumb svg{opacity:1}
.s4-art .s4-fname{color:#fff;font-size:15px}.s4-art .s4-fsub{color:#8a8a93}
.s4-art.landed{animation:s4land .9s ease-out 1}
@keyframes s4land{0%{box-shadow:0 0 0 0 rgba(10,132,255,.55)}100%{box-shadow:0 0 0 16px rgba(10,132,255,0)}}
.s4-src{margin-left:26px;padding:10px 14px;border-radius:10px;background:#111113;border:1px solid #2c2c2e;font:14px/1.55 ${M};white-space:pre;color:#e5e5ea}
.s4-src div{opacity:0;transition:opacity .35s ${E}}
.k{color:#ff7ab2}.f{color:#67b7ff}.tg{color:#5dd8ff}.a{color:#d0bf69}.s{color:#fc6a5d}.pu{color:#8e8e93}
.s4-fly{position:absolute;z-index:40;margin:0;transform-origin:0 0;box-shadow:0 24px 50px -14px rgba(0,0,0,.45),0 2px 6px rgba(0,0,0,.12)}
.s4-phone{position:absolute;left:864px;top:78px;width:252px;height:506px;border-radius:44px;background:#1d1d1f;padding:10px;box-shadow:0 30px 70px -20px rgba(0,0,0,.4);opacity:0;transform:translateY(40px) scale(.96);transition:opacity .8s ${E},transform .9s ${E}}
.s4-scr{position:relative;width:100%;height:100%;border-radius:35px;background:#fbfbfd;overflow:hidden;padding:38px 18px 18px;display:flex;flex-direction:column}
.s4-isl{position:absolute;left:50%;top:10px;width:78px;height:22px;margin-left:-39px;border-radius:12px;background:#1d1d1f}
.s4-scr .rw{display:flex;align-items:center;gap:6px}
.s4-scr .dt{width:10px;height:10px;border-radius:50%;background:#0071e3}.s4-scr .br{width:44px;height:8px;border-radius:4px;background:#1d1d1f;opacity:.75}
.s4-steps{margin-left:auto;display:flex;gap:4px}.s4-steps i{width:10px;height:6px;border-radius:3px;background:#d2d2d7}.s4-steps i.on{width:22px;background:#0071e3}
.s4-scr h3{margin:22px 0 6px;font-size:24px;line-height:1.12;font-weight:700;letter-spacing:-.02em}
.s4-scr p{margin:0;font-size:14px;line-height:1.35;color:#6e6e73}
.s4-pc{margin-top:14px;padding:10px;border-radius:14px;background:#fff;border:1px solid #e5e5ea}
.s4-pc .il{height:62px;border-radius:9px;background:#e8f2fd;display:flex;align-items:center;gap:10px;padding:0 12px}
.s4-pc .il b{width:30px;height:30px;border-radius:50%;background:#0071e3;opacity:.85}.s4-pc .il span{display:grid;gap:5px}.s4-pc .il span i{height:5px;width:48px;border-radius:3px;background:#0071e3;opacity:.45}.s4-pc .il span i+i{width:32px;opacity:.3}
.s4-pc .nm{display:flex;align-items:center;margin-top:8px;font-size:14px;font-weight:600}.s4-pc .nm i{margin-left:auto;width:9px;height:9px;border-radius:50%;background:#28cd41}
.s4-btns{margin-top:auto;display:flex;gap:8px}
.s4-btns span{flex:1;height:40px;border-radius:20px;display:grid;place-items:center;font-size:14px;font-weight:600}
.s4-btns .p1{flex:1.4;background:#0071e3;color:#fff}.s4-btns .p2{border:1px solid #d2d2d7;color:#1d1d1f}
.s4-scr .pi{opacity:0;transform:translateY(8px);transition:opacity .5s ${E},transform .5s ${E}}
.s4-plab{position:absolute;left:840px;width:300px;top:596px;text-align:center;font-size:14px;color:#6e6e73;opacity:0;transition:opacity .6s ${E}}
.s4-plab b{font-family:${M};font-weight:500;color:#1d1d1f}
.s4-tag{position:absolute;left:0;right:0;top:630px;text-align:center;font-size:30px;font-weight:700;letter-spacing:-.02em;opacity:0;transform:translateY(12px);transition:opacity .9s ${E},transform .9s ${E}}
.s4-tag span{color:#0071e3}
`;
    root.appendChild(style);
    const w = document.createElement("div");
    w.className = "s4-root";
    const bars = [["#c7c7cc", 38], ["#b4d4f7", 56], ["#d9d9de", 70], ["#f5c6d6", 44], ["#d9d9de", 62], ["#c7c7cc", 30], ["#b4d4f7", 52], ["#d9d9de", 66], ["#f5c6d6", 40], ["#d9d9de", 58], ["#c7c7cc", 34], ["#b4d4f7", 48], ["#d9d9de", 60], ["#d9d9de", 42], ["#c7c7cc", 50], ["#b4d4f7", 36], ["#d9d9de", 54], ["#f5c6d6", 46], ["#d9d9de", 30], ["#c7c7cc", 44], ["#d9d9de", 56], ["#b4d4f7", 38], ["#d9d9de", 50], ["#c7c7cc", 28], ["#d9d9de", 46], ["#b4d4f7", 34]]
      .map(([c, p], i) => `<div style="background:${c};width:${p}%;margin-left:${(i % 5 === 1 || i % 5 === 2) ? 28 : (i % 7 === 3 ? 56 : 0)}px"></div>`).join("");
    w.innerHTML = `
<div class="s4-desk">
  <div class="s4-ed"><div class="s4-edbar"><span>Step2.tsx — onboarding — Visual Studio Code</span><i>&#8212;</i><i>&#9633;</i><i>&#10005;</i></div>
    <div class="s4-edb"><div class="s4-edside"></div><div class="s4-edcode">${bars}</div></div></div>
  <div class="s4-task"><i></i><i></i><i></i><i></i><i></i><span>tarush-pc · 14:05</span></div>
</div>
<div class="s4-cap"><b>03</b> · One click to approve. The file comes back.</div>
<div class="s4-ov">
  <div class="s4-hd"><span class="s4-mk">${LOGO}<span class="s4-wb">1</span></span><span class="nm">mesh</span><span class="rm">· tango-bc7d92eb</span>
    <span class="tl"><span>${ic('<path d="M4 11.5V7.2a4 4 0 0 1 8 0v4.3l1.2 1.3H2.8z"/><path d="M6.6 14.3a1.5 1.5 0 0 0 2.8 0"/>')}</span><span>${ic('<path d="M4 6.5l4 4 4-4"/>')}</span></span></div>
  <div class="s4-main">
    <section class="s4-sec"><div class="s4-sh">Needs approval <span class="s4-badge">1</span></div>
      <article class="s4-req">
        <div class="s4-front">
          <div class="s4-rh"><span class="s4-av">d</span><div class="s4-who"><b>dev</b><span>wants to run a command</span></div><time>14:05</time></div>
          <p class="s4-why">“Export the Onboarding/Step-2 frame so I can build it pixel-for-pixel.”</p>
          <div class="s4-code"><span class="p">$</span> figma-export.sh "Onboarding/Step-2"</div>
          <div class="s4-acts"><span class="s4-btn">Deny</span><span class="s4-btn ok">Approve</span></div>
        </div>
        <div class="s4-back"><span class="s4-gc">${CHECK}</span><div class="tx"><b>approved</b> <span>· running on tarush's laptop</span></div><span class="st"><i class="s4-spin"></i>running</span></div>
      </article>
      <div class="s4-hwrap"><div class="s4-handoff">
        <div class="s4-hh">${ic('<rect x="2" y="2.5" width="12" height="11" rx="2"/><circle cx="5.8" cy="6.2" r="1.2"/><path d="M2.5 12l3.8-3.6 2.7 2.4 2-1.8 2.5 2.4"/>')}<span>exported from Figma ·</span><span class="fn">Onboarding/Step-2</span></div>
        <div class="s4-hfile"><div class="s4-thumb">${FRAME_SVG}</div><div class="s4-meta"><div class="s4-fname">step-2.png</div><div class="s4-fsub">1440×900 · 214 KB</div><div class="s4-prog"><i></i></div></div></div>
        <div class="s4-hstat">${ic('<path d="M8 11V3M4.8 6.2L8 3l3.2 3.2M3 13h10"/>')}<span>ready to send</span></div>
      </div></div>
    </section>
    <section class="s4-sec"><div class="s4-sh">Activity <span class="s4-live"><i></i>Live</span></div>
      <div class="s4-feed"><div class="empty">No activity yet</div>
        <div class="ln"><span class="t">14:05</span> <span class="u">dev</span> → tarush $ figma-export.sh …</div>
        <div class="ln"><span class="t">14:05</span> <span class="u">tarush</span> <span class="ok">✓ approved</span></div>
        <div class="ln"><span class="out">exported Onboarding/Step-2 → step-2.png</span></div>
        <div class="ln"><span class="t">14:05</span> <span class="u">tarush</span> <span class="ok">✔ exit 0 1.8s</span><span class="s4-chip">step-2.png <span>· 214 KB</span></span></div>
      </div>
    </section>
  </div>
  <div class="s4-ft"><i></i>mesh running · tarush-pc <span class="r">· relay connected</span><span class="set">Settings</span></div>
</div>
<div class="s4-dev">
  <div class="s4-bar"><i style="background:#ff5f57"></i><i style="background:#febc2e"></i><i style="background:#28c840"></i><span>dev — Claude Code — ~/app</span></div>
  <div class="s4-db">
    <div class="s4-dl s4-pr"><b>&gt;</b>implement onboarding step 2 to match Onboarding/Step-2</div>
    <div class="s4-dl"><div class="s4-call"><span class="s4-ci done"><i class="sp"></i><i class="ck">${CHECK}</i></span><span class="s4-mesh">mesh</span><span class="s4-arg">·</span><span class="s4-fnm">ask_teammate</span><span class="s4-arg">tarush figma-export.sh</span></div>
      <div class="s4-res">⎿ <span class="g">approved by tarush</span> · exit 0 in 1.8 s</div></div>
    <div class="s4-dl" data-k="fetch"><div class="s4-call"><span class="s4-ci"><i class="sp"></i><i class="ck">${CHECK}</i></span><span class="s4-mesh">mesh</span><span class="s4-arg">·</span><span class="s4-fnm">fetch_artifact</span><span class="s4-arg">step-2.png</span></div>
      <div class="s4-res" style="margin:2px 0 8px">⎿ from tarush's laptop</div>
      <div class="s4-art"><div class="s4-thumb">${FRAME_SVG}</div><div class="s4-meta"><div class="s4-fname">step-2.png</div><div class="s4-fsub">1440×900 · 214 KB</div></div></div></div>
    <div class="s4-dl" data-k="write"><div class="s4-call"><span class="s4-ci"><i class="sp"></i><i class="ck">${CHECK}</i></span><span class="s4-fnm">Write</span><span class="s4-arg">src/onboarding/Step2.tsx</span></div></div>
    <div class="s4-dl s4-src" data-k="src"><div><span class="k">export function</span> <span class="f">Step2</span><span class="pu">() {</span></div><div>  <span class="k">return</span> <span class="pu">(</span></div><div>    <span class="pu">&lt;</span><span class="tg">Screen</span> <span class="a">step</span><span class="pu">={</span>2<span class="pu">} </span><span class="a">of</span><span class="pu">={</span>4<span class="pu">}&gt;</span></div><div>      <span class="pu">&lt;</span><span class="tg">Title</span><span class="pu">&gt;</span>Connect your teammates<span class="pu">&lt;/</span><span class="tg">Title</span><span class="pu">&gt;</span></div><div>      <span class="pu">&lt;</span><span class="tg">TeammateCard</span> <span class="a">tool</span><span class="pu">=</span><span class="s">"figma"</span> <span class="pu">/&gt;</span></div><div>      <span class="pu">&lt;</span><span class="tg">Button</span> <span class="a">primary</span><span class="pu">&gt;</span>Continue<span class="pu">&lt;/</span><span class="tg">Button</span><span class="pu">&gt;</span></div></div>
    <div class="s4-dl s4-res" data-k="done" style="font-size:15px"><span class="g">✓</span> Step 2 matches the Figma frame</div>
  </div>
</div>
<div class="s4-phone"><div class="s4-scr"><div class="s4-isl"></div>
  <div class="rw pi"><i class="dt"></i><i class="br"></i><span class="s4-steps"><i></i><i class="on"></i><i></i><i></i></span></div>
  <h3 class="pi">Connect your teammates</h3>
  <p class="pi">Borrow a teammate's machine, not their credentials.</p>
  <div class="s4-pc pi"><div class="il"><b></b><span><i></i><i></i></span></div><div class="nm">Tarush · Figma<i></i></div></div>
  <div class="s4-btns pi"><span class="p1">Continue</span><span class="p2">Back</span></div>
</div></div>
<div class="s4-plab">preview · <b>Step2.tsx</b></div>
<div class="s4-tag">Ran on Tarush's machine, with his token. <span>The token never moved.</span></div>
<svg class="s4-cur" viewBox="0 0 28 28"><path d="M6 3l15 12.2-6.6.6 3.9 8.2-3.1 1.4-3.8-8.3L6 21.6z" fill="#1d1d1f" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>
`;
    root.appendChild(w);
    const $ = s => w.querySelector(s);
    const $$ = s => [...w.querySelectorAll(s)];
    const show = el => el && el.classList.add("s4-in");
    const ov = $(".s4-ov"), req = $(".s4-req"), dev = $(".s4-dev"), cur = $(".s4-cur");
    const K = () => (root.getBoundingClientRect().width / 1280) || 1;
    const rel = el => { const r = el.getBoundingClientRect(), R = root.getBoundingClientRect(), k = K(); return { x: (r.left - R.left) / k, y: (r.top - R.top) / k, w: r.width / k, h: r.height / k }; };
    const anim = (el, kf, o) => { const a = el.animate(kf, o); A.push(a); return a; };

    // 0-3 s: desktop + overlay
    at(80, () => show($(".s4-cap")));
    at(150, () => show($(".s4-ed")));
    at(700, () => { ov.classList.add("s4-in"); ov.style.transform = "none"; });
    at(2300, () => { $(".s4-wb").style.transform = "scale(1)"; $(".s4-badge").style.transform = "scale(1)"; });
    // 3-8 s: request card + click
    at(2900, () => { show(req); req.classList.add("ring"); });
    let cx = 1180, cy = 700;
    at(4300, () => {
      const b = rel($(".s4-btn.ok")); const tx = b.x + b.w * 0.55, ty = b.y + b.h * 0.5;
      cur.style.opacity = "1";
      anim(cur, [{ transform: `translate(${cx}px,${cy}px)`, opacity: 0 }, { transform: `translate(${cx - 20}px,${cy - 30}px)`, opacity: 1, offset: .15 }, { transform: `translate(${tx}px,${ty}px)`, opacity: 1 }], { duration: 1700, easing: MV, fill: "forwards" });
      cx = tx; cy = ty;
    });
    at(6000, () => $(".s4-btn.ok").classList.add("hov"));
    at(6500, () => {
      const btn = $(".s4-btn.ok"); btn.classList.add("dn");
      anim(cur, [{ transform: `translate(${cx}px,${cy}px) scale(1)` }, { transform: `translate(${cx}px,${cy}px) scale(.85)` }, { transform: `translate(${cx}px,${cy}px) scale(1)` }], { duration: 260, fill: "forwards" });
      const rp = document.createElement("i"); rp.className = "s4-rip"; rp.style.left = "55%"; rp.style.top = "50%"; btn.appendChild(rp);
      anim(rp, [{ transform: "scale(0)", opacity: 1 }, { transform: "scale(12)", opacity: 0 }], { duration: 700, easing: E, fill: "forwards" });
    });
    at(6700, () => { const btn = $(".s4-btn.ok"); btn.classList.remove("dn"); btn.firstChild.textContent = "Approving…"; });
    at(7400, () => anim(cur, [{ transform: `translate(${cx}px,${cy}px)`, opacity: 1 }, { transform: `translate(${cx + 60}px,${cy + 90}px)`, opacity: 0 }], { duration: 700, easing: MV, fill: "forwards" }));
    // 8-11 s: approved + live feed
    at(7900, () => {
      req.style.height = req.offsetHeight + "px"; void req.offsetHeight;
      req.style.height = "64px"; $(".s4-front").style.opacity = "0"; $(".s4-back").style.opacity = "1";
      $(".s4-wb").style.transform = "scale(0)"; $(".s4-badge").style.transform = "scale(0)";
    });
    const lines = $$(".s4-feed .ln");
    at(8300, () => { $(".s4-feed .empty").style.display = "none"; show(lines[0]); });
    at(8900, () => show(lines[1]));
    at(9600, () => show(lines[2]));
    at(10300, () => { show(lines[3]); const st = $(".s4-back .st"); st.classList.add("done"); st.innerHTML = "exit 0 in 1.8 s"; });
    // 11-16 s: camera move, handoff, flight
    at(11000, () => { $(".s4-desk").classList.add("gone"); ov.classList.add("moved"); show(dev); dev.style.transform = "none"; });
    $$(".s4-dev .s4-dl").slice(0, 2).forEach(el => el.classList.add("s4-in"));
    at(11400, () => $(".s4-hwrap").classList.add("open"));
    at(11900, () => show($('[data-k="fetch"]')));
    const prog = $(".s4-prog i"), hstat = $(".s4-hstat span");
    at(12500, () => { hstat.textContent = "sending to dev…"; anim(prog, [{ width: "0%" }, { width: "100%" }], { duration: 1700, easing: MV, fill: "forwards" }); });
    at(14200, () => {
      const src = $(".s4-hfile"), tgt = $(".s4-art"), s = rel(src), t = rel(tgt);
      const fly = src.cloneNode(true); fly.className = "s4-hfile s4-fly";
      Object.assign(fly.style, { left: s.x + "px", top: s.y + "px", width: s.w + "px" });
      w.appendChild(fly);
      const sc = t.w / s.w, dx = t.x - s.x, dy = t.y - s.y;
      anim(fly, [
        { transform: "translate(0,0) scale(1)", opacity: 1 },
        { transform: `translate(${dx * .5}px,${dy * .5 - 90}px) scale(${(1 + sc) / 2 + .06}) rotate(-2deg)`, opacity: 1, offset: .5 },
        { transform: `translate(${dx}px,${dy}px) scale(${sc})`, opacity: 1, offset: .85 },
        { transform: `translate(${dx}px,${dy}px) scale(${sc})`, opacity: 0 }
      ], { duration: 1150, easing: MV, fill: "forwards" });
    });
    at(15180, () => {
      $(".s4-art").classList.add("landed"); $('[data-k="fetch"] .s4-ci').classList.add("done");
      $(".s4-handoff").classList.add("delivered"); hstat.textContent = "delivered to dev";
      $(".s4-hstat svg").outerHTML = CHECK.replace("<svg ", '<svg style="width:17px;height:17px" ');
    });
    // 16-20 s: Dev builds it
    at(16000, () => { ov.classList.add("out"); dev.classList.add("moved"); });
    at(16500, () => show($('[data-k="write"]')));
    at(16700, () => { show($('[data-k="src"]')); $$(".s4-src div").forEach((d, i) => at(100 + i * 130, () => d.style.opacity = "1")); });
    at(17100, () => { show($(".s4-phone")); $$(".s4-scr .pi").forEach((el, i) => at(250 + i * 110, () => show(el))); });
    at(17700, () => { $('[data-k="write"] .s4-ci').classList.add("done"); show($('[data-k="done"]')); show($(".s4-plab")); });
    at(18000, () => show($(".s4-tag")));

    return () => { T.forEach(clearTimeout); A.forEach(a => { try { a.cancel(); } catch (e) {} }); };
  }
});
