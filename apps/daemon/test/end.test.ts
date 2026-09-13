/**
 * Ending a session, end to end against the real CLI (child processes) and the fake relay:
 *   A. the relay ends the room (room_ended + 4410): a joined daemon prints the message, exits 0, forgets config.json,
 *      never reconnects, and the plugin SessionStart hook does not bring it back; `mesh ask` into the ended room exits 2
 *   B. a daemon without the owner token: end_session → tool error, POST /end → 403, /health owner:false
 *   C. an owner link (#k=…&o=…): /health owner:true, config.json saves owner, end_session calls the relay's end route
 *      with x-mesh-key + x-mesh-owner, a teammate is told, the daemon exits; `mesh end` with --owner and with no daemon
 *   D. units: ownerFromLink; RelayClient.switchRoom into an ended room returns to the previous room
 * Every child runs with a throwaway HOME / project dir, a free port and a fake osascript/zenity on PATH.
 *   pnpm -F daemon exec tsx test/end.test.ts
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ownerFromLink } from "../src/owner.js";
import { RelayClient, RoomEndedError } from "../src/relay-client.js";
import { ownerToken, roomKey, startFakeRelay, type FakeRelay } from "./fake-relay.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const daemonDir = path.resolve(here, "..");
const repoRoot = path.resolve(daemonDir, "../..");
const CLI_TS = path.join(daemonDir, "src/cli.ts");
const TSX_CLI = [path.join(daemonDir, "node_modules/tsx/dist/cli.mjs"), path.join(repoRoot, "node_modules/tsx/dist/cli.mjs")].find((p) => fs.existsSync(p));
const HOOK = path.join(repoRoot, "plugin/bin/mesh-session-start");
const FAKE_DIALOG = path.join(here, "fixtures/leave-fake-dialog.sh");
const FORBIDDEN_PORTS = new Set([7337, 8095, 4040]);
const SECRET = "end-test-secret";

let failures = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  console.log(`${ok ? "  ok  " : "  FAIL"} ${name}${ok || detail === undefined ? "" : `  → ${JSON.stringify(detail)}`}`);
  if (!ok) failures++;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(pred: () => boolean | Promise<boolean>, ms = 3000, step = 50): Promise<boolean> {
  const stop = Date.now() + ms;
  while (Date.now() < stop) {
    if (await pred()) return true;
    await sleep(step);
  }
  return pred();
}
const freePort = () => new Promise<number>((res, rej) => {
  const s = net.createServer();
  s.listen(0, "127.0.0.1", () => {
    const p = (s.address() as net.AddressInfo).port;
    s.close(() => (FORBIDDEN_PORTS.has(p) ? freePort().then(res, rej) : res(p)));
  });
  s.on("error", rej);
});

// ---------- process bookkeeping ----------

const children = new Set<ChildProcess>();
const tmpDirs: string[] = [];
const clients: RelayClient[] = [];
interface Env { home: string; project: string; port: number; env: NodeJS.ProcessEnv }

function makeEnv(label: string, port: number): Env {
  if (FORBIDDEN_PORTS.has(port)) throw new Error(`refusing to use port ${port}`);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `mesh-end-${label}-home-`));
  const project = fs.mkdtempSync(path.join(os.tmpdir(), `mesh-end-${label}-proj-`));
  tmpDirs.push(home, project);
  const bin = path.join(home, "bin");
  const pids = path.join(home, "pids");
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(pids, { recursive: true });
  for (const name of ["osascript", "zenity"]) {
    fs.copyFileSync(FAKE_DIALOG, path.join(bin, name));
    fs.chmodSync(path.join(bin, name), 0o755);
  }
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of ["MESH_KEY", "MESH_OWNER", "MESH_RELAY", "MESH_BIN", "MESH_PORT", "MESH_BACKGROUND", "CLAUDE_PROJECT_DIR", "CLAUDE_CONFIG_DIR", "INIT_CWD", "SSH_CONNECTION", "SSH_TTY", "MESH_APPROVE"]) delete env[k];
  Object.assign(env, {
    HOME: home, USERPROFILE: home, INIT_CWD: project, MESH_PORT: String(port), CLAUDE_CONFIG_DIR: path.join(home, ".claude"),
    PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`, LEAVE_PIDS: pids,
  });
  return { home, project, port, env };
}
const cfgPath = (e: Env) => path.join(e.home, ".mesh", "config.json");
const statePath = (e: Env) => path.join(e.home, ".mesh", "daemon.json");
const SAFE_FLAGS = (port: number) => ["--no-register", "--no-git-watch", "--no-git-offers", "--port", String(port)];
const readJson = (p: string): Record<string, unknown> | undefined => { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return undefined; } };

interface Proc { child: ChildProcess; out: () => string; exit: Promise<number | null>; exited: () => boolean; code: () => number | null }
function spawnCli(e: Env, args: string[]): Proc {
  const child = spawn(process.execPath, [TSX_CLI!, CLI_TS, ...args], { cwd: e.project, env: e.env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  children.add(child);
  let out = "";
  child.stdout!.on("data", (d) => { out += d; });
  child.stderr!.on("data", (d) => { out += d; });
  let done = false;
  let code: number | null = null;
  const exit = new Promise<number | null>((res) => child.on("exit", (c) => { done = true; code = c; children.delete(child); res(c); }));
  return { child, out: () => out, exit, exited: () => done, code: () => code };
}
function killGroup(child: ChildProcess): void {
  if (!child.pid) return;
  try { process.kill(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch { /* gone */ } }
}
async function runCli(e: Env, args: string[], ms = 20_000): Promise<{ code: number | null; out: string }> {
  const p = spawnCli(e, args);
  const t = setTimeout(() => killGroup(p.child), ms);
  const code = await p.exit;
  clearTimeout(t);
  return { code, out: p.out() };
}
function runHook(e: Env, ms = 25_000): Promise<{ code: number | null; out: string }> {
  const env = { ...e.env, CLAUDE_PROJECT_DIR: e.project, MESH_BIN: `${process.execPath} ${TSX_CLI} ${CLI_TS}` };
  const child = spawn("bash", [HOOK], { cwd: e.project, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  children.add(child);
  let out = "";
  child.stdout!.on("data", (d) => { out += d; });
  child.stderr!.on("data", (d) => { out += d; });
  const t = setTimeout(() => killGroup(child), ms);
  return new Promise((res) => child.on("exit", (code) => { clearTimeout(t); children.delete(child); res({ code, out: out.trim() }); }));
}
async function health(port: number): Promise<Record<string, unknown> | undefined> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) });
    return r.ok ? ((await r.json()) as Record<string, unknown>) : undefined;
  } catch { return undefined; }
}
async function killBackground(e: Env): Promise<void> {
  const pid = Number(readJson(statePath(e))?.pid);
  if (!pid || !(await health(e.port))) return;
  try { process.kill(pid, "SIGKILL"); } catch { /* gone */ }
}
async function mcpCall(port: number, name: string, args: Record<string, unknown>): Promise<{ status: number; body: unknown; text: string }> {
  const r = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    signal: AbortSignal.timeout(15_000),
  });
  const raw = await r.text();
  let body: unknown = raw;
  try { body = JSON.parse(raw); } catch {
    const data = raw.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).filter(Boolean);
    try { body = data.length ? JSON.parse(data[data.length - 1]!) : raw; } catch { /* keep raw */ }
  }
  const result = (body as { result?: { content?: Array<{ text?: string }>; isError?: boolean } }).result;
  return { status: r.status, body, text: (result?.content ?? []).map((c) => c.text ?? "").join("\n") };
}
async function postJson(port: number, route: string, payload: unknown): Promise<{ status: number; body: Record<string, unknown> | undefined }> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}${route}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload), signal: AbortSignal.timeout(15_000) });
    return { status: r.status, body: (await r.json().catch(() => undefined)) as Record<string, unknown> | undefined };
  } catch (err) {
    return { status: 0, body: { error: (err as Error).message } };
  }
}

async function watcher(relayPort: number, room: string, key?: string, user = "watcher"): Promise<RelayClient> {
  const w = new RelayClient({ relay: `ws://127.0.0.1:${relayPort}`, room, user, role: "feed", offers: [], ...(key ? { key } : {}) });
  clients.push(w);
  await w.connect();
  return w;
}
const sees = (w: RelayClient, user: string) => !!w.presence()?.members.some((m) => m.user === user);

async function startDaemon(label: string, e: Env, w: RelayClient, user: string, args: string[]): Promise<Proc> {
  const p = spawnCli(e, args);
  const up = await until(async () => {
    if (p.exited()) return true;
    const h = await health(e.port);
    return h?.user === user && h?.room === w.room && sees(w, user);
  }, 20_000, 150);
  check(`${label}: daemon up (health + presence)`, up && !p.exited(), p.exited() ? { code: p.code(), out: p.out().slice(-400) } : undefined);
  return p;
}
async function assertEnded(label: string, e: Env, p: Proc, relay: FakeRelay, message: RegExp): Promise<void> {
  const gone = await until(() => p.exited(), 8000);
  check(`${label}: daemon exits within 8 s`, gone, gone ? undefined : p.out().slice(-400));
  if (gone) check(`${label}: exit code 0`, p.code() === 0, { code: p.code(), out: p.out().slice(-400) });
  check(`${label}: printed the end message`, message.test(p.out()), p.out().slice(-400));
  check(`${label}: /health down`, await until(async () => !(await health(e.port)), 5000, 150));
  check(`${label}: config.json removed`, !fs.existsSync(cfgPath(e)), readJson(cfgPath(e)));
  const before = relay.wsAttempts();
  await sleep(3000);
  check(`${label}: no relay reconnect attempts in 3 s`, relay.wsAttempts() === before, { before, after: relay.wsAttempts() });
}

async function main(): Promise<void> {
  if (!TSX_CLI) throw new Error("tsx cli not found (pnpm install)");
  const t0 = Date.now();
  const open = await startFakeRelay(0); // no keys
  const keyed = await startFakeRelay(0, { requireKey: true, secret: SECRET });
  const stamp = Date.now().toString(36);
  const room = (s: string) => `end-${stamp}-${s}`;

  try {
    // D. units first (fast)
    console.log("D. units");
    {
      const tok = ownerToken(SECRET, "otter-1");
      check("D: ownerFromLink(#k=…&o=…)", ownerFromLink(`https://relay.example/r/otter-1#k=abcdefghijklmnop&o=${tok}`) === tok);
      check("D: ownerFromLink(#o=…&k=…)", ownerFromLink(`https://relay.example/r/otter-1#o=${tok}&k=abcdefghijklmnop`) === tok);
      check("D: ownerFromLink without o= → undefined", ownerFromLink("https://relay.example/r/otter-1#k=abcdefghijklmnop") === undefined);
      check("D: ownerFromLink(plain room) → undefined", ownerFromLink("otter-1") === undefined);
      check("D: ownerFromLink(garbage o=) → undefined", ownerFromLink("https://relay.example/r/otter-1#k=abc&o=%20<x>") === undefined);

      const w1 = await watcher(open.port, room("d1"), undefined, "w1");
      const c = new RelayClient({ relay: `ws://127.0.0.1:${open.port}`, room: room("d1"), user: "switcher", role: "daemon", offers: [] });
      clients.push(c);
      await c.connect();
      check("D: switcher in d1", await until(() => sees(w1, "switcher"), 3000));
      open.endRoom(room("d2"), "dev"); // tombstone d2 (nobody in it)
      let endedEvents = 0;
      c.on("roomEnded", () => { endedEvents++; });
      let err: unknown;
      try { await c.switchRoom(room("d2")); } catch (e) { err = e; }
      check("D: switchRoom into an ended room rejects with RoomEndedError", err instanceof RoomEndedError, String(err));
      check("D: …client.switching is false again", c.switching === false);
      check("D: …and it is back in the previous room (room name + presence)", c.room === room("d1") && (await until(() => sees(w1, "switcher") && c.status() === "connected", 5000)), { room: c.room, status: c.status() });
      check("D: roomEnded was emitted once (during the switch)", endedEvents === 1, endedEvents);

      // an ended room while connected: roomEnded, no reconnect
      const msgs: string[] = [];
      c.on("roomEnded", (m) => msgs.push(m));
      const before = open.wsAttempts();
      const closed = open.endRoom(room("d1"), "dev", "demo over");
      check("D: fake relay closed sockets in d1", closed >= 2, closed);
      check("D: connected client gets roomEnded with the message", await until(() => msgs.includes("dev ended the session: demo over"), 3000), msgs);
      await sleep(2500);
      check("D: connected client does not reconnect after the end", open.wsAttempts() === before && c.status() === "disconnected", { before, after: open.wsAttempts() });
      let refused: unknown;
      try { await c.connect(); } catch (e) { refused = e; }
      check("D: a later connect() is refused (shut down)", refused instanceof Error, String(refused));
    }

    // B + A. a daemon without the owner token; then the relay ends its room
    console.log("B. non-owner daemon");
    const eA = makeEnv("a", await freePort());
    const wA = await watcher(open.port, room("a"));
    const pA = await startDaemon("A", eA, wA, "bob", ["join", room("a"), "--relay", `ws://127.0.0.1:${open.port}`, "--as", "bob", ...SAFE_FLAGS(eA.port)]);
    {
      const h = await health(eA.port);
      check("B: /health owner:false", h?.owner === false, h);
      check("B: config.json saved without owner", fs.existsSync(cfgPath(eA)) && readJson(cfgPath(eA))?.owner === undefined, readJson(cfgPath(eA)));
      const r = await mcpCall(eA.port, "end_session", {});
      check("B: end_session → tool error 'only the person who started this session'", /"isError":true/.test(JSON.stringify(r.body)) && /only the person who started this session/.test(r.text), r.body);
      const pe = await postJson(eA.port, "/end", {});
      check("B: POST /end → 403", pe.status === 403 && /only the person who started this session/.test(String(pe.body?.error)), pe);
      check("B: no relay end call was made", open.endCalls().length === 0, open.endCalls());
      check("B: daemon still running", !pA.exited() && !!(await health(eA.port)));
    }

    console.log("A. relay ends the room");
    {
      check("A: config.json exists before the end", fs.existsSync(cfgPath(eA)));
      const closed = open.endRoom(room("a"), "dev");
      check("A: relay closed the daemon's socket", closed >= 1, closed);
      await assertEnded("A", eA, pA, open, /dev ended the session/);
      const h = await runHook(eA);
      check("A: SessionStart hook exits 0", h.code === 0, h.out);
      await sleep(3000);
      check("A: hook did not restart the daemon", !(await health(eA.port)), h.out);
      await killBackground(eA);
      const ask = await runCli(eA, ["ask", "bob", "echo hi", "--room", room("a"), "--relay", `ws://127.0.0.1:${open.port}`, "--as", "carol"], 20_000);
      check("A: mesh ask into the ended room exits 2 with the message", ask.code === 2 && /ended/.test(ask.out), { code: ask.code, out: ask.out.slice(-300) });
    }

    // C. owner link on a keyed relay → end_session over MCP
    console.log("C. owner ends the session (end_session)");
    {
      const r = room("c");
      const key = roomKey(SECRET, r);
      const owner = ownerToken(SECRET, r);
      const e = makeEnv("c", await freePort());
      const w = await watcher(keyed.port, r, key);
      const teammateMsgs: string[] = [];
      w.on("roomEnded", (m) => teammateMsgs.push(m));
      const link = `http://127.0.0.1:${keyed.port}/r/${r}#k=${key}&o=${owner}`;
      const p = await startDaemon("C", e, w, "alice", ["join", link, "--as", "alice", ...SAFE_FLAGS(e.port)]);
      const h = await health(e.port);
      check("C: /health owner:true", h?.owner === true, h);
      check("C: config.json saves owner + key", readJson(cfgPath(e))?.owner === owner && readJson(cfgPath(e))?.key === key, readJson(cfgPath(e)));
      check("C: the token is never printed in full", !p.out().includes(owner), p.out().slice(-400));
      const res = await mcpCall(e.port, "end_session", { reason: "demo over" });
      let parsed: Record<string, unknown> = {};
      try { parsed = JSON.parse(res.text); } catch { /* not json */ }
      check("C: end_session → ok, ended: room, closed ≥ 1", res.status === 200 && parsed.ok === true && parsed.ended === r && Number(parsed.closed) >= 1, res.body);
      const call = keyed.endCalls().at(-1);
      check("C: relay got POST /api/rooms/<room>/end with x-mesh-key + x-mesh-owner", call?.room === r && call.key === key && call.owner === owner, call);
      check("C: …body by=alice, reason", call?.body.by === "alice" && call.body.reason === "demo over", call?.body);
      check("C: teammate got roomEnded 'alice ended the session: demo over'", await until(() => teammateMsgs.includes("alice ended the session: demo over"), 3000), teammateMsgs);
      await assertEnded("C", e, p, keyed, /alice ended the session|you ended the session|ended the session/);
    }

    console.log("C2. mesh end (--owner flag, POST /end via the CLI)");
    {
      const r = room("c2");
      const key = roomKey(SECRET, r);
      const owner = ownerToken(SECRET, r);
      const e = makeEnv("c2", await freePort());
      const w = await watcher(keyed.port, r, key);
      const p = await startDaemon("C2", e, w, "amy", ["join", r, "--relay", `ws://127.0.0.1:${keyed.port}`, "--key", key, "--owner", owner, "--as", "amy", ...SAFE_FLAGS(e.port)]);
      check("C2: /health owner:true", (await health(e.port))?.owner === true);
      const out = await runCli(e, ["end", "--port", String(e.port)]);
      check("C2: mesh end exits 0 and prints 'ended <room> for everyone'", out.code === 0 && out.out.includes(`ended ${r} for everyone`), out);
      await assertEnded("C2", e, p, keyed, /ended the session/);
      const again = await postJson(e.port, "/end", {});
      check("C2: nothing left listening", again.status === 0);
    }

    console.log("C3. mesh end with no daemon (saved join with owner)");
    {
      const r = room("c3");
      const key = roomKey(SECRET, r);
      const owner = ownerToken(SECRET, r);
      const e = makeEnv("c3", await freePort());
      const w = await watcher(keyed.port, r, key);
      const msgs: string[] = [];
      w.on("roomEnded", (m) => msgs.push(m));
      fs.mkdirSync(path.dirname(cfgPath(e)), { recursive: true });
      fs.writeFileSync(cfgPath(e), JSON.stringify({ room: r, relay: `ws://127.0.0.1:${keyed.port}`, user: "ann", port: e.port, cwd: e.project, updatedAt: new Date().toISOString(), key, owner }));
      const out = await runCli(e, ["end", "--port", String(e.port)]);
      check("C3: mesh end exits 0, prints ended", out.code === 0 && out.out.includes(`ended ${r} for everyone`), out);
      check("C3: teammate told", await until(() => msgs.some((m) => /ann ended the session/.test(m)), 3000), msgs);
      check("C3: saved join forgotten", !fs.existsSync(cfgPath(e)));
      fs.writeFileSync(cfgPath(e), JSON.stringify({ room: r, relay: `ws://127.0.0.1:${keyed.port}`, user: "ann", port: e.port, cwd: e.project, updatedAt: new Date().toISOString(), key }));
      const noOwner = await runCli(e, ["end", "--port", String(e.port)]);
      check("C3: without an owner token mesh end exits non-zero with the owner message", noOwner.code !== 0 && /only the person who started this session/.test(noOwner.out), noOwner);
    }
  } finally {
    for (const c of clients) c.close();
    for (const c of children) killGroup(c);
    await open.close();
    await keyed.close();
    for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
    console.log(`(${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  }
}

main()
  .catch((e) => { console.error(e); failures++; })
  .finally(() => {
    console.log(failures ? `\n${failures} check(s) failed` : "\nall end checks passed");
    process.exit(failures ? 1 : 0);
  });
