#!/usr/bin/env tsx
/**
 * End-to-end rooms test: multi-room, room keys, join / switch / leave / rejoin, messaging, approvals,
 * owner ends the session, relay restart. Three real daemons (isolated temp HOMEs, free ports, no agent registration) against a relay.
 *
 *   pnpm e2e:rooms                                   # spawns its own relay on a free port (random ROOM_SECRET)
 *   pnpm e2e:rooms --relay https://<app>.up.railway.app   # a deployed relay (restart check skipped)
 *
 * Flags: --relay <http(s) url>  --keep (leave temp dirs)  --verbose (dump all process logs at the end)
 *        --leave-wait <s> (how long a left daemon must stay gone, default 10)
 * Exit 0 when nothing FAILed. See docs/E2E-ROOMS.md.
 */
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import {
  cleanupAll, installSignalCleanup, runJoinOnce, sleep, startDaemon, startLocalRelay, waitFor,
  type DaemonHandle, type LocalRelay, type Proc,
} from "./e2e-rooms/harness.js";
import {
  createRoom, daemonHealth, daemonUrl, endRoom, getRoom, httpBase, httpGet, linkWithKey, mcpCall, roomMembers,
  type CreatedRoom, type ToolResult,
} from "./e2e-rooms/clients.js";

// ---------- args ----------
const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(`--${name}`);
const opt = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  if (i >= 0) return argv[i + 1];
  const eq = argv.find((a) => a.startsWith(`--${name}=`));
  return eq ? eq.slice(name.length + 3) : undefined;
};
if (flag("help") || flag("h")) {
  console.log("usage: tsx scripts/e2e-rooms.ts [--relay https://<relay>] [--keep] [--verbose] [--leave-wait <s>]");
  process.exit(0);
}
const REMOTE = opt("relay");
const KEEP = flag("keep");
const VERBOSE = flag("verbose");
const LEAVE_WAIT_S = Number(opt("leave-wait") ?? 10) || 10;
if (REMOTE && !/^https?:\/\//.test(REMOTE)) {
  console.error(`--relay must be an http(s) URL (got ${REMOTE})`);
  process.exit(2);
}
if (REMOTE && /gap-masses-sureness|:8095\b|:7337\b|:4040\b/.test(REMOTE)) {
  console.error("refusing to run against the live dev relay; point --relay at a test/Railway deploy");
  process.exit(2);
}
if (KEEP) process.env.MESH_E2E_KEEP = "1";

// ---------- result table ----------
type Status = "PASS" | "FAIL" | "SKIP";
interface Row { id: string; name: string; status: Status; ms: number; note: string }
const rows: Row[] = [];
const procs = new Map<string, Proc>(); // name → last known process, for log dumps

class Fail extends Error {}
function expect(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Fail(msg);
}
const short = (s: string, n = 160) => { const f = s.replace(/\s+/g, " ").trim(); return f.length > n ? f.slice(0, n - 1) + "…" : f; };

async function check(id: string, name: string, fn: () => Promise<string | void>, skip?: string): Promise<boolean> {
  if (skip) {
    rows.push({ id, name, status: "SKIP", ms: 0, note: skip });
    console.log(`  SKIP ${id}  ${name}  (${skip})`);
    return true;
  }
  const t0 = Date.now();
  process.stdout.write(`  …    ${id}  ${name}\n`);
  try {
    const note = (await fn()) ?? "";
    rows.push({ id, name, status: "PASS", ms: Date.now() - t0, note });
    console.log(`  PASS ${id}  ${name}  ${Date.now() - t0} ms${note ? `  ${note}` : ""}`);
    return true;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    rows.push({ id, name, status: "FAIL", ms: Date.now() - t0, note: msg });
    console.log(`  FAIL ${id}  ${name}  ${Date.now() - t0} ms  ${msg}`);
    return false;
  }
}

function printTable(): void {
  const w = { id: 3, name: Math.max(...rows.map((r) => r.name.length), 4), ms: 7 };
  console.log("\n" + ["#".padEnd(w.id), "check".padEnd(w.name), "result", "time".padStart(w.ms), "note"].join("  "));
  console.log("-".repeat(w.id + w.name + w.ms + 24));
  for (const r of rows) {
    const t = r.status === "SKIP" ? "" : `${(r.ms / 1000).toFixed(1)}s`;
    console.log([r.id.padEnd(w.id), r.name.padEnd(w.name), r.status.padEnd(6), t.padStart(w.ms), short(r.note, 200)].join("  "));
  }
  const fails = rows.filter((r) => r.status === "FAIL").length;
  console.log(`\n${fails === 0 ? "ALL PASS" : `${fails} FAIL`}  (${rows.filter((r) => r.status === "PASS").length} pass, ${rows.filter((r) => r.status === "SKIP").length} skip)`);
}

function dumpLogs(onlyFailing: boolean): void {
  for (const [name, p] of procs) {
    const lines = p.logs().split("\n").filter(Boolean);
    const tail = onlyFailing ? lines.slice(-30) : lines;
    console.log(`\n----- ${name} (pid ${p.pid}${p.exited() ? `, exited ${p.exitCode()}` : ""}) — ${onlyFailing ? "last 30 lines" : "log"} -----`);
    console.log(tail.join("\n") || "(no output)");
  }
}

// ---------- helpers ----------
const rand = randomBytes(3).toString("hex");
const A = `e2e-a-${rand}`;
const B = `e2e-b-${rand}`;
const C = `e2e-c-${rand}`;
const D = `e2e-d-${rand}`; // check 8: starts the session (owner link)
const E = `e2e-e-${rand}`; // check 8: plain link
const F = `e2e-f-${rand}`; // check 8: plain link

const ok = (r: ToolResult, what: string): ToolResult => { expect(!r.isError, `${what} → tool error: ${short(r.text)}`); return r; };
function track(d: DaemonHandle): DaemonHandle { procs.set(d.name, d.proc); return d; }

async function members(base: string, room: string, key: string): Promise<string[]> {
  return (await roomMembers(base, room, key)) ?? [];
}
/** Wait until the relay's view of `room` satisfies pred; returns the last member list seen. */
async function waitMembers(base: string, room: string, key: string, pred: (m: string[]) => boolean, ms: number): Promise<{ ok: boolean; seen: string[] }> {
  let seen: string[] = [];
  const hit = await waitFor(async () => { seen = await members(base, room, key); return pred(seen) ? true : undefined; }, ms, 300);
  return { ok: hit === true, seen };
}
async function teammates(port: number): Promise<string[]> {
  const r = await mcpCall(port, "list_teammates", {});
  if (r.isError) return [];
  return ((r.json?.members ?? []) as Array<{ user: string }>).map((m) => m.user);
}
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

// ---------- main ----------
async function main(): Promise<void> {
  installSignalCleanup();
  const watchdog = setTimeout(() => { console.error("\nwatchdog: e2e run exceeded 8 minutes"); printTable(); void cleanupAll().then(() => process.exit(1)); }, 8 * 60_000);
  watchdog.unref();

  console.log(`mesh e2e rooms — ${REMOTE ? `remote relay ${REMOTE}` : "local relay"}; daemons ${A}, ${B}, ${C}\n`);
  let relay: LocalRelay | undefined;
  let base = REMOTE ? httpBase(REMOTE) : "";
  let R1: { room: string; key: string; link: string } | undefined;
  let R2: { room: string; key: string; link: string } | undefined;
  let a: DaemonHandle | undefined;
  let b: DaemonHandle | undefined;
  let c: DaemonHandle | undefined;
  const ended: DaemonHandle[] = []; // check 8's daemons (d owner, e, f)
  const need = <T,>(v: T | undefined, what: string): T => { expect(v !== undefined, `prerequisite missing: ${what}`); return v as T; };

  // 1. health + rooms
  await check("1", "relay health + create 2 rooms", async () => {
    if (!REMOTE) {
      relay = await startLocalRelay();
      procs.set("relay", relay.proc);
      base = relay.base;
    }
    const h = await httpGet(`${base}/health`);
    expect(h.status === 200, `GET /health → ${h.status} ${short(JSON.stringify(h.body))}`);
    R1 = await createRoom(base);
    R2 = await createRoom(base);
    expect(R1.room && R2.room && R1.room !== R2.room, `rooms not distinct: ${R1.room} / ${R2.room}`);
    expect(/#k=[a-z2-7]{16}$/.test(R1.link) && /#k=[a-z2-7]{16}$/.test(R2.link), `links lack #k=<key>: ${R1.link} ${R2.link}`);
    return `R1=${R1.room} R2=${R2.room} (${base})`;
  });

  // 2. join + isolation
  await check("2", "a,b join R1; c joins R2; isolation", async () => {
    const r1 = need(R1, "R1"); const r2 = need(R2, "R2");
    const [da, db, dc] = await Promise.allSettled([
      startDaemon({ name: A, joinArg: r1.link }),
      startDaemon({ name: B, joinArg: r1.link }),
      startDaemon({ name: C, joinArg: r2.link }),
    ]);
    if (da.status === "fulfilled") a = track(da.value);
    if (db.status === "fulfilled") b = track(db.value);
    if (dc.status === "fulfilled") c = track(dc.value);
    for (const [n, s] of [[A, da], [B, db], [C, dc]] as const) expect(s.status === "fulfilled", `${n} did not come up: ${short(String((s as PromiseRejectedResult).reason?.message ?? ""), 400)}`);
    const w1 = await waitMembers(base, r1.room, r1.key, (m) => m.includes(A) && m.includes(B), 15_000);
    expect(w1.ok, `R1 presence lacks a/b: [${w1.seen.join(", ")}]`);
    const w2 = await waitMembers(base, r2.room, r2.key, (m) => m.includes(C), 15_000);
    expect(w2.ok, `R2 presence lacks c: [${w2.seen.join(", ")}]`);
    const seesB = await waitFor(async () => (await teammates(a!.port)).includes(B) || undefined, 10_000);
    expect(seesB, `a's list_teammates lacks b: [${(await teammates(a!.port)).join(", ")}]`);
    const seesA = await waitFor(async () => (await teammates(b!.port)).includes(A) || undefined, 10_000);
    expect(seesA, `b's list_teammates lacks a`);
    const m1 = await members(base, r1.room, r1.key);
    expect(!m1.includes(C), `c leaked into R1 presence: [${m1.join(", ")}]`);
    const ta = await teammates(a!.port);
    expect(!ta.includes(C), `a sees c via list_teammates: [${ta.join(", ")}]`);
    const tc = await teammates(c!.port);
    expect(!tc.includes(A) && !tc.includes(B), `c sees R1 members: [${tc.join(", ")}]`);
    return `R1=[${m1.join(", ")}] R2=[${(await members(base, r2.room, r2.key)).join(", ")}]`;
  });

  // 3. key gate
  await check("3", "no key / wrong key rejected; GET room w/o key 401", async () => {
    const r1 = need(R1, "R1");
    const ws = base.replace(/^http/, "ws");
    const noKey = await runJoinOnce({ name: `e2e-x-${rand}`, joinArg: r1.room, extra: ["--relay", ws] });
    expect(!noKey.timedOut && noKey.exitCode === 2, `join without key: exit ${noKey.exitCode}${noKey.timedOut ? " (timed out — kept running?)" : ""}: ${short(noKey.output, 300)}`);
    expect(/room link|room key/i.test(noKey.output), `join without key: no readable room-key message: ${short(noKey.output, 300)}`);
    const wrong = await runJoinOnce({ name: `e2e-y-${rand}`, joinArg: linkWithKey(r1.link, "aaaaaaaaaaaaaaaa") });
    expect(!wrong.timedOut && wrong.exitCode === 2, `join with wrong key: exit ${wrong.exitCode}${wrong.timedOut ? " (timed out)" : ""}: ${short(wrong.output, 300)}`);
    expect(/room link|room key/i.test(wrong.output), `join with wrong key: no readable message: ${short(wrong.output, 300)}`);
    const g = await getRoom(base, r1.room);
    expect(g.status === 401, `GET /api/rooms/R1 without key → ${g.status}`);
    const gw = await getRoom(base, r1.room, "aaaaaaaaaaaaaaaa");
    expect(gw.status === 401, `GET /api/rooms/R1 with wrong key → ${gw.status}`);
    const gk = await getRoom(base, r1.room, r1.key);
    expect(gk.status === 200, `GET /api/rooms/R1 with key → ${gk.status}`);
    const msg = noKey.output.split("\n").map((l) => l.trim()).find((l) => /room link|room key/i.test(l)) ?? "";
    return `exit 2/2, 401/401; "${short(msg, 80)}"`;
  });

  // 4. messaging + approvals
  await check("4", "send_message, ask always, ask → approve", async () => {
    const da = need(a, "daemon a"); const dbb = need(b, "daemon b");
    // message
    const text = `e2e hello ${rand}`;
    ok(await mcpCall(da.port, "send_message", { to: B, text }), "send_message a→b");
    const got = await waitFor(async () => {
      const r = await mcpCall(dbb.port, "inbox", { unreadOnly: false, sinceMinutes: 10 });
      const msgs = (r.json?.messages ?? []) as Array<{ from: string; text: string }>;
      return msgs.some((m) => m.from === A && m.text === text) || undefined;
    }, 10_000, 300);
    expect(got, "message a→b never reached b's inbox");
    // always offer
    const echo = ok(await mcpCall(da.port, "ask_teammate", { who: B, command: `echo e2e-echo-${rand}`, why: "e2e always offer", waitSeconds: 20 }), "ask_teammate echo");
    expect(echo.json?.status === "completed" && echo.json?.exitCode === 0, `echo → ${short(echo.text, 300)}`);
    expect(String(echo.json?.output ?? "").includes(`e2e-echo-${rand}`), `echo output missing: ${short(echo.text, 300)}`);
    // ask offer → pending queue → approve_request
    const attach = await httpGet(daemonUrl(dbb.port, "/pending?wait=0")); // marks a watcher attached (what `mesh watch` does)
    expect(attach.status === 200, `b GET /pending → ${attach.status}`);
    const asked = ok(await mcpCall(da.port, "ask_teammate", { who: B, command: "uname", why: "e2e ask offer", waitSeconds: 2 }), "ask_teammate uname");
    expect(asked.json?.status === "running" && asked.json?.jobId, `uname should wait for approval, got: ${short(asked.text, 300)}`);
    const jobId = String(asked.json.jobId);
    let pendingId: string | undefined;
    await waitFor(async () => {
      const p = await httpGet(daemonUrl(dbb.port, "/pending?wait=3"), 8_000);
      const list = (p.body?.pending ?? []) as Array<{ id: string; from: string; command?: string }>;
      pendingId = list.find((x) => x.from === A && /uname/.test(x.command ?? ""))?.id;
      return pendingId;
    }, 15_000, 200);
    expect(pendingId, "uname request never showed up in b's /pending");
    ok(await mcpCall(dbb.port, "approve_request", { id: pendingId, decision: "approved" }), "approve_request");
    const done = ok(await mcpCall(da.port, "check_job", { jobId, waitSeconds: 20 }), "check_job");
    expect(done.json?.status === "completed" && done.json?.exitCode === 0 && String(done.json?.output ?? "").trim().length > 0, `after approval: ${short(done.text, 300)}`);
    return `inbox ok; echo ok; uname approved → ${short(String(done.json.output), 20)}`;
  });

  // 5. switch_room
  await check("5", "b switch_room R1 → R2 via link", async () => {
    const r1 = need(R1, "R1"); const r2 = need(R2, "R2"); const dbb = need(b, "daemon b"); need(c, "daemon c");
    const sw = ok(await mcpCall(dbb.port, "switch_room", { room: r2.link }), "switch_room");
    expect(sw.json?.room === r2.room, `switch_room returned ${short(sw.text)}`);
    const gone = await waitMembers(base, r1.room, r1.key, (m) => !m.includes(B), 10_000);
    expect(gone.ok, `b still in R1 presence: [${gone.seen.join(", ")}]`);
    const here = await waitMembers(base, r2.room, r2.key, (m) => m.includes(B) && m.includes(C), 15_000);
    expect(here.ok, `R2 presence lacks b/c: [${here.seen.join(", ")}]`);
    const h = await daemonHealth(dbb.port);
    expect(h?.room === r2.room && h?.relay === "connected", `b /health: ${JSON.stringify(h)}`);
    const seen = await waitFor(async () => (await teammates(c!.port)).includes(B) || undefined, 10_000);
    expect(seen, "c's list_teammates lacks b after the switch");
    const ta = await waitFor(async () => !(await teammates(a!.port)).includes(B) || undefined, 10_000);
    expect(ta, "a still lists b after b switched away");
    return `R1=[${(await members(base, r1.room, r1.key)).join(", ")}] R2=[${here.seen.join(", ")}]`;
  });

  // 6. leave_room
  await check("6", `c leave_room: gone, exits, stays gone ${LEAVE_WAIT_S}s`, async () => {
    const r2 = need(R2, "R2"); const dc = need(c, "daemon c");
    let res: ToolResult | undefined;
    try { res = await mcpCall(dc.port, "leave_room", { reason: "e2e leave" }, 10_000); } catch (e) { /* the daemon may exit mid-response */ res = { isError: false, text: `(no response: ${(e as Error).message})` }; }
    expect(!res.isError, `leave_room → ${short(res.text)}`);
    const gone = await waitMembers(base, r2.room, r2.key, (m) => !m.includes(C), 10_000);
    expect(gone.ok, `c still in R2 presence 10 s after leave_room: [${gone.seen.join(", ")}]`);
    const exited = await dc.proc.waitExit(10_000);
    expect(exited, `c's daemon process (pid ${dc.proc.pid}) still running 10 s after leave_room`);
    const t0 = Date.now();
    while (Date.now() - t0 < LEAVE_WAIT_S * 1000) {
      const m = await members(base, r2.room, r2.key);
      expect(!m.includes(C), `c came back into R2 ${((Date.now() - t0) / 1000).toFixed(1)} s after leaving: [${m.join(", ")}]`);
      await sleep(1000);
    }
    expect(!(await daemonHealth(dc.port)), `something answers /health on c's port ${dc.port} after leave`);
    const tb = await teammates(need(b, "daemon b").port);
    expect(!tb.includes(C), `b still lists c: [${tb.join(", ")}]`);
    return `exit code ${dc.proc.exitCode()}`;
  });

  // 7. rejoin
  await check("7", "c rejoins R2 with the link", async () => {
    const r2 = need(R2, "R2"); const old = need(c, "daemon c");
    if (!old.proc.exited()) await old.proc.kill(); // check 6 failed to stop it; don't let it mask the rejoin
    const dc = track(await startDaemon({ name: C, joinArg: r2.link, sandbox: old.sandbox }));
    c = dc;
    const here = await waitMembers(base, r2.room, r2.key, (m) => m.includes(C) && m.includes(B), 15_000);
    expect(here.ok, `R2 presence after rejoin: [${here.seen.join(", ")}]`);
    const seen = await waitFor(async () => (await teammates(b!.port)).includes(C) || undefined, 10_000);
    expect(seen, "b's list_teammates lacks c after rejoin");
    return `R2=[${here.seen.join(", ")}]`;
  });

  // 8. owner ends the session (END-SESSION spec / docs/CONTRACT.md). Uses its own room R3 and daemons d/e/f,
  // so checks 1–7 and 9 are unaffected; its daemons have all exited before the relay restart.
  await check("8", "owner end_session: everyone exits, link 410, rejoin refused", async () => {
    const r3: CreatedRoom = await createRoom(base);
    const OWNER_RE = /^[a-z2-7]{16}$/;
    expect(r3.ownerToken && OWNER_RE.test(r3.ownerToken), `POST /api/rooms returned no valid ownerToken (room ${r3.room})`);
    expect(r3.ownerLink && r3.ownerLink.endsWith(`#k=${r3.key}&o=${r3.ownerToken}`), `ownerLink is not <link>&o=<token>: ${r3.ownerLink}`);
    expect(!/[#&]o=/.test(r3.link), `shareable link leaks the owner token: ${r3.link}`);
    const owner = r3.ownerToken as string;
    const g0 = await getRoom(base, r3.room, r3.key);
    expect(g0.status === 200 && !JSON.stringify(g0.body).includes(owner), `GET /api/rooms/R3 → ${g0.status}; must be 200 and never include the owner token`);

    // d starts the session with the owner link; e and f join with the plain link.
    const started = await Promise.allSettled([
      startDaemon({ name: D, joinArg: r3.ownerLink as string }),
      startDaemon({ name: E, joinArg: r3.link }),
      startDaemon({ name: F, joinArg: r3.link }),
    ]);
    for (const s of started) if (s.status === "fulfilled") ended.push(track(s.value));
    for (const [n, s] of [[D, started[0]], [E, started[1]], [F, started[2]]] as const) expect(s.status === "fulfilled", `${n} did not come up: ${short(String((s as PromiseRejectedResult).reason?.message ?? ""), 400)}`);
    const [dd, de, df] = ended as [DaemonHandle, DaemonHandle, DaemonHandle];
    const w = await waitMembers(base, r3.room, r3.key, (m) => [D, E, F].every((u) => m.includes(u)), 15_000);
    expect(w.ok, `R3 presence lacks d/e/f: [${w.seen.join(", ")}]`);
    const hd = await daemonHealth(dd.port);
    const he = await daemonHealth(de.port);
    expect(hd?.owner === true, `d (owner link) /health owner should be true: ${JSON.stringify(hd)}`);
    expect(he?.owner === false, `e (plain link) /health owner should be false: ${JSON.stringify(he)}`);

    // Non-owners are refused (REST and MCP) and nothing ends.
    const noOwner = await endRoom(base, r3.room, r3.key);
    expect(noOwner.status === 403, `POST /end without an owner token → ${noOwner.status} ${short(JSON.stringify(noOwner.body))}`);
    const wrongOwner = await endRoom(base, r3.room, r3.key, "aaaaaaaaaaaaaaaa");
    expect(wrongOwner.status === 403, `POST /end with a wrong owner token → ${wrongOwner.status}`);
    const wrongKey = await endRoom(base, r3.room, "aaaaaaaaaaaaaaaa", owner);
    expect(wrongKey.status === 401, `POST /end with a wrong room key → ${wrongKey.status}`);
    const refused = await mcpCall(de.port, "end_session", { reason: "e2e non-owner" }, 15_000);
    expect(refused.isError && /only the person who started/i.test(refused.text), `e (non-owner) end_session should be a tool error, got: ${short(refused.text, 300)}`);
    await sleep(1000);
    const upNote = () => [dd, de, df].map((d) => `${d.name.split("-")[1]}:${d.proc.exited() ? d.proc.exitCode() : "running"}`).join(" ");
    expect([dd, de, df].every((d) => !d.proc.exited()), `a daemon exited after the refused ends: ${upNote()}`);
    const still = await members(base, r3.room, r3.key);
    expect([D, E, F].every((u) => still.includes(u)), `R3 presence changed after the refused ends: [${still.join(", ")}]`);

    // The owner ends it.
    const t0 = Date.now();
    let res: ToolResult;
    try { res = await mcpCall(dd.port, "end_session", { reason: "e2e end" }, 15_000); } catch (e) { /* the daemon may exit mid-response */ res = { isError: false, text: `(no response: ${(e as Error).message})` }; }
    expect(!res.isError, `d end_session → ${short(res.text, 300)}`);
    if (res.json) expect(res.json.ended === r3.room, `end_session result should name the room: ${short(res.text)}`);
    const [eOut, fOut, dOut] = await Promise.all([de, df, dd].map((d) => d.proc.waitExit(10_000)));
    const exitMs = Date.now() - t0;
    expect(eOut && fOut, `teammates still running 10 s after end_session: ${upNote()}`);
    expect(dOut, `the owner's daemon still running 10 s after end_session: ${upNote()}`);
    for (const d of [dd, de, df]) expect(!(await daemonHealth(d.port)), `something still answers /health on ${d.name}'s port ${d.port}`);
    for (const d of [de, df]) expect(d.proc.exitCode() === 0, `${d.name} should exit 0 via the leave path: ${upNote()}`);
    expect(/ended the session/i.test(de.proc.logs()), `e never printed "… ended the session"; log tail: ${short(de.proc.logs().slice(-400), 300)}`);
    for (const d of [dd, de, df]) {
      expect(!fs.existsSync(path.join(d.sandbox.home, ".mesh", "config.json")), `${d.name} still has a saved join (~/.mesh/config.json) after the end`);
    }

    // The link is dead: 410 on GET (key still checked first), a fresh join exits instead of staying up, ending twice is fine.
    const g = await getRoom(base, r3.room, r3.key);
    expect(g.status === 410, `GET /api/rooms/R3 after the end → ${g.status} ${short(JSON.stringify(g.body))}`);
    const gBad = await getRoom(base, r3.room, "aaaaaaaaaaaaaaaa");
    expect(gBad.status === 401, `GET /api/rooms/R3 after the end with a wrong key → ${gBad.status} (key check must come first)`);
    const again = await runJoinOnce({ name: `e2e-g-${rand}`, joinArg: r3.link, timeoutMs: 15_000 });
    expect(!again.timedOut, `join with the ended link was still running after 15 s: ${short(again.output, 300)}`);
    expect(/ended/i.test(again.output), `join with the ended link: no readable "ended" message (exit ${again.exitCode}): ${short(again.output, 300)}`);
    const twice = await endRoom(base, r3.room, r3.key, owner);
    expect(twice.status === 200 && twice.body?.alreadyEnded === true, `second end → ${twice.status} ${short(JSON.stringify(twice.body))}`);

    // Starting a new session still works and never hands out the ended name.
    const r4 = await createRoom(base);
    expect(r4.room && r4.room !== r3.room && r4.ownerToken, `POST /api/rooms after an end: room ${r4.room}, ownerToken ${r4.ownerToken ? "yes" : "no"}`);
    return `all exited in ${(exitMs / 1000).toFixed(1)} s (${upNote()}); GET 410; rejoin exit ${again.exitCode}; new room ok`;
  });

  // 9. relay restart
  const skip9 = REMOTE ? "remote relay: cannot restart" : undefined;
  await check("9a", "relay restart, same ROOM_SECRET: reconnect", async () => {
    const r = need(relay, "local relay"); const r1 = need(R1, "R1"); const r2 = need(R2, "R2");
    const da = need(a, "daemon a"); const dbb = need(b, "daemon b"); const dc = need(c, "daemon c");
    const t0 = Date.now();
    await r.restart();
    procs.set("relay", r.proc);
    const back = await waitFor(async () => {
      const hs = await Promise.all([da, dbb, dc].map((d) => daemonHealth(d.port)));
      return hs.every((h) => h?.relay === "connected") || undefined;
    }, 30_000, 300);
    expect(back, `daemons not reconnected 30 s after restart: ${JSON.stringify(await Promise.all([da, dbb, dc].map((d) => daemonHealth(d.port))))}`);
    const w1 = await waitMembers(base, r1.room, r1.key, (m) => m.includes(A), 15_000);
    expect(w1.ok, `R1 presence after restart: [${w1.seen.join(", ")}]`);
    const w2 = await waitMembers(base, r2.room, r2.key, (m) => m.includes(B) && m.includes(C), 15_000);
    expect(w2.ok, `R2 presence after restart: [${w2.seen.join(", ")}]`);
    const reconnectMs = Date.now() - t0;
    const text = `after restart ${rand}`;
    ok(await mcpCall(dc.port, "send_message", { to: B, text }), "send_message c→b after restart");
    const got = await waitFor(async () => {
      const m = (await mcpCall(dbb.port, "inbox", { unreadOnly: false, sinceMinutes: 10 })).json?.messages as Array<{ text: string }> | undefined;
      return m?.some((x) => x.text === text) || undefined;
    }, 10_000, 300);
    expect(got, "message c→b lost after restart");
    return `reconnected in ${(reconnectMs / 1000).toFixed(1)} s; old links valid`;
  }, skip9);

  await check("9b", "relay restart, new ROOM_SECRET: old link rejected", async () => {
    const r = need(relay, "local relay"); const r1 = need(R1, "R1");
    await r.restart({ secret: randomBytes(16).toString("hex") });
    procs.set("relay", r.proc);
    const g = await getRoom(base, r1.room, r1.key);
    expect(g.status === 401, `GET /api/rooms/R1 with the old key → ${g.status}`);
    const j = await runJoinOnce({ name: `e2e-z-${rand}`, joinArg: r1.link });
    expect(!j.timedOut && j.exitCode === 2, `join with the old link: exit ${j.exitCode}${j.timedOut ? " (timed out)" : ""}: ${short(j.output, 300)}`);
    // Daemons holding the old key get 4401 on reconnect and stop (exit 2) by design.
    const stopped = await Promise.all([a, b, c].filter((d): d is DaemonHandle => !!d).map(async (d) => (await d.proc.waitExit(20_000)) ? `${d.name.split("-")[1]}:${d.proc.exitCode()}` : `${d.name.split("-")[1]}:running`));
    return `401 + exit 2; old-key daemons → ${stopped.join(" ")}`;
  }, skip9);

  // 10. cleanup
  await check("10", "cleanup: processes killed, temp dirs removed", async () => {
    const all = [...procs.values()];
    const dirs = [a, b, c, ...ended].filter((d): d is DaemonHandle => !!d).map((d) => d.sandbox.dir);
    await cleanupAll();
    await sleep(300);
    const live = all.filter((p) => alive(p.pid));
    expect(live.length === 0, `still running: ${live.map((p) => `${p.name}(${p.pid})`).join(", ")}`);
    if (KEEP) return `--keep: temp dirs kept: ${dirs.join(" ")}`;
    const left = dirs.filter((d) => fs.existsSync(d));
    expect(left.length === 0, `temp dirs left: ${left.join(", ")}`);
    return `${all.length} processes, ${dirs.length} sandboxes`;
  });

  printTable();
  const failed = rows.some((r) => r.status === "FAIL");
  if (VERBOSE) dumpLogs(false);
  else if (failed) dumpLogs(true);
  await cleanupAll();
  process.exit(failed ? 1 : 0);
}

main().catch(async (e) => {
  console.error("e2e crashed:", e);
  printTable();
  dumpLogs(true);
  await cleanupAll();
  process.exit(1);
});
