/**
 * Leaving a room, end to end against the real CLI (child processes) and the fake relay:
 * leave_room (MCP), POST /leave, `mesh leave`, `mesh stop`, the plugin SessionStart hook not resurrecting a
 * left daemon (with a positive control proving it would), rejoin by room link, and switch_room.
 * Every child runs with a throwaway HOME / project dir and a free port; nothing touches the real ~/.mesh or :7337.
 *   pnpm -F daemon exec tsx test/leave.test.ts
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RelayClient } from "../src/relay-client.js";
import { startFakeRelay } from "./fake-relay.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const daemonDir = path.resolve(here, "..");
const repoRoot = path.resolve(daemonDir, "../..");
const CLI_TS = path.join(daemonDir, "src/cli.ts");
const TSX_CLI = [path.join(daemonDir, "node_modules/tsx/dist/cli.mjs"), path.join(repoRoot, "node_modules/tsx/dist/cli.mjs")].find((p) => fs.existsSync(p));
const HOOK = path.join(repoRoot, "plugin/bin/mesh-session-start");
const FORBIDDEN_PORTS = new Set([7337, 8095, 4040]);

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

// ---------- process bookkeeping (everything we start gets killed in finally) ----------

const children = new Set<ChildProcess>();
const tmpDirs: string[] = [];
interface Env { home: string; project: string; port: number; env: NodeJS.ProcessEnv }

function makeEnv(label: string, port: number): Env {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `mesh-leave-${label}-home-`));
  const project = fs.mkdtempSync(path.join(os.tmpdir(), `mesh-leave-${label}-proj-`));
  tmpDirs.push(home, project);
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of ["MESH_KEY", "MESH_RELAY", "MESH_BIN", "MESH_PORT", "MESH_BACKGROUND", "CLAUDE_PROJECT_DIR", "CLAUDE_CONFIG_DIR", "INIT_CWD"]) delete env[k];
  Object.assign(env, { HOME: home, USERPROFILE: home, INIT_CWD: project, MESH_PORT: String(port), CLAUDE_CONFIG_DIR: path.join(home, ".claude") });
  return { home, project, port, env };
}
const cfgPath = (e: Env) => path.join(e.home, ".mesh", "config.json");
const statePath = (e: Env) => path.join(e.home, ".mesh", "daemon.json");
const SAFE_FLAGS = (port: number) => ["--no-register", "--no-git-watch", "--no-git-offers", "--port", String(port)];

interface Proc { child: ChildProcess; out: () => string; exit: Promise<number | null>; exited: () => boolean; code: () => number | null }
function spawnCli(e: Env, args: string[]): Proc {
  if (FORBIDDEN_PORTS.has(e.port)) throw new Error(`refusing to use port ${e.port}`);
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
async function runCli(e: Env, args: string[], ms = 20_000): Promise<{ code: number | null; out: string }> {
  const p = spawnCli(e, args);
  const t = setTimeout(() => killGroup(p.child), ms);
  const code = await p.exit;
  clearTimeout(t);
  return { code, out: p.out() };
}
function killGroup(child: ChildProcess): void {
  if (!child.pid) return;
  try { process.kill(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch { /* gone */ } }
}
const joinArgs = (e: Env, room: string, user: string, relayPort: number, extra: string[] = []) =>
  ["join", room, "--relay", `ws://127.0.0.1:${relayPort}`, "--as", user, ...SAFE_FLAGS(e.port), ...extra];

async function health(port: number): Promise<Record<string, unknown> | undefined> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) });
    return r.ok ? ((await r.json()) as Record<string, unknown>) : undefined;
  } catch { return undefined; }
}
const pidAlive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const readJson = (p: string): Record<string, unknown> | undefined => { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return undefined; } };

/** Kill a background daemon recorded in this env's daemon.json, but only while our test port still answers (guards pid reuse). */
async function killBackground(e: Env): Promise<void> {
  const st = readJson(statePath(e));
  const pid = Number(st?.pid);
  if (!pid || !(await health(e.port))) return;
  try { process.kill(pid, "SIGKILL"); } catch { /* gone */ }
  await until(async () => !(await health(e.port)), 3000);
}
const envs: Env[] = [];

// ---------- relay watchers ----------

let relayPort = 0;
const watchers = new Map<string, RelayClient>();
async function watcher(room: string): Promise<RelayClient> {
  let w = watchers.get(room);
  if (!w) {
    w = new RelayClient({ relay: `ws://127.0.0.1:${relayPort}`, room, user: "watcher", role: "feed", offers: [] });
    watchers.set(room, w);
    await w.connect();
  }
  return w;
}
const sees = (w: RelayClient, user: string) => !!w.presence()?.members.some((m) => m.user === user);

async function startDaemon(label: string, e: Env, room: string, user: string, args?: string[]): Promise<Proc> {
  const w = await watcher(room);
  const p = spawnCli(e, args ?? joinArgs(e, room, user, relayPort));
  const up = await until(async () => {
    if (p.exited()) return true;
    const h = await health(e.port);
    return h?.user === user && h?.room === room && sees(w, user);
  }, 15_000, 150);
  check(`${label}: daemon up (health + watcher sees ${user})`, up && !p.exited(), p.exited() ? { code: p.code(), out: p.out().slice(-400) } : undefined);
  return p;
}

async function assertLeft(label: string, e: Env, room: string, user: string, relay: { wsAttempts(): number }, proc?: Proc, pid?: number): Promise<void> {
  if (proc) {
    const gone = await until(() => proc.exited(), 5000);
    check(`${label}: daemon process exits within 5 s`, gone, gone ? undefined : proc.out().slice(-300));
    if (gone) check(`${label}: exit code 0`, proc.code() === 0, proc.code());
  } else if (pid) {
    check(`${label}: background daemon pid exits within 5 s`, await until(() => !pidAlive(pid), 5000));
  }
  check(`${label}: /health down`, await until(async () => !(await health(e.port)), 5000, 150));
  const w = await watcher(room);
  check(`${label}: watcher sees ${user} gone within 5 s`, await until(() => !sees(w, user), 5000));
  check(`${label}: config.json removed`, !fs.existsSync(cfgPath(e)));
  check(`${label}: daemon.json removed`, !fs.existsSync(statePath(e)));
  const before = relay.wsAttempts();
  await sleep(2500);
  check(`${label}: no relay reconnect attempts in 2.5 s`, relay.wsAttempts() === before, { before, after: relay.wsAttempts() });
}

/** Stateless Streamable HTTP: one JSON-RPC request per POST; the answer may be JSON or an SSE stream. */
async function mcpCall(port: number, name: string, args: Record<string, unknown>): Promise<{ status: number; body: unknown }> {
  const r = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    signal: AbortSignal.timeout(5000),
  });
  const text = await r.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    const data = text.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).filter(Boolean);
    try { body = data.length ? JSON.parse(data[data.length - 1]!) : text; } catch { /* keep raw */ }
  }
  return { status: r.status, body };
}
async function postJson(port: number, route: string, payload: unknown): Promise<{ status: number; body: Record<string, unknown> | undefined }> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}${route}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload), signal: AbortSignal.timeout(5000) });
    return { status: r.status, body: (await r.json().catch(() => undefined)) as Record<string, unknown> | undefined };
  } catch (err) {
    return { status: 0, body: { error: (err as Error).message } };
  }
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

async function main(): Promise<void> {
  if (!TSX_CLI) throw new Error("tsx cli not found (pnpm install)");
  const t0 = Date.now();
  const relay = await startFakeRelay(0);
  relayPort = relay.port;
  const stamp = Date.now().toString(36);
  const room = (s: string) => `leave-${stamp}-${s}`;

  try {
    // A. leave_room over MCP
    console.log("A. leave_room (MCP tool)");
    {
      const e = makeEnv("a", await freePort()); envs.push(e);
      const p = await startDaemon("A", e, room("a"), "alice");
      check("A: config.json written by join", fs.existsSync(cfgPath(e)));
      const r = await mcpCall(e.port, "leave_room", { reason: "test A" });
      const text = JSON.stringify(r.body);
      check("A: tools/call leave_room → 200, not an error", r.status === 200 && !/"isError":true/.test(text) && !/"error"/.test(text), r);
      await assertLeft("A", e, room("a"), "alice", relay, p);
    }

    // B. POST /leave
    console.log("B. POST /leave");
    {
      const e = makeEnv("b", await freePort()); envs.push(e);
      const p = await startDaemon("B", e, room("b"), "bob");
      const r = await postJson(e.port, "/leave", { reason: "test B" });
      check("B: POST /leave → 200 ok", r.status === 200 && r.body?.ok === true, r);
      await assertLeft("B", e, room("b"), "bob", relay, p);
    }

    // C. mesh leave; then D (hook/status after leave) and E (rejoin by link) reuse this HOME
    console.log("C. mesh leave");
    const eC = makeEnv("c", await freePort()); envs.push(eC);
    {
      const p = await startDaemon("C", eC, room("c"), "carol");
      const r = await runCli(eC, ["leave", "--port", String(eC.port)]);
      check("C: mesh leave exits 0", r.code === 0, r.out.slice(-300));
      await assertLeft("C", eC, room("c"), "carol", relay, p);
      if (!p.exited()) { // keep D/E meaningful even when `mesh leave` is missing
        console.log("  (mesh leave did not stop the daemon; falling back to POST /leave + cleanup)");
        await postJson(eC.port, "/leave", {});
        if (!(await until(() => p.exited(), 5000))) killGroup(p.child);
        fs.rmSync(cfgPath(eC), { force: true });
        fs.rmSync(statePath(eC), { force: true });
      }
      fs.mkdirSync(path.dirname(cfgPath(eC)), { recursive: true });
      fs.writeFileSync(cfgPath(eC), JSON.stringify({ room: room("c"), relay: `ws://127.0.0.1:${relayPort}`, user: "carol", port: eC.port, cwd: eC.project, updatedAt: new Date().toISOString() }));
      const r2 = await runCli(eC, ["leave", "--port", String(eC.port)]);
      check("C: mesh leave with nothing running exits 0", r2.code === 0, r2.out.slice(-300));
      check("C: …and still removes config.json", !fs.existsSync(cfgPath(eC)));
      fs.rmSync(cfgPath(eC), { force: true }); // D must start from "left" regardless
    }

    console.log("D. after leave: status, SessionStart hook");
    {
      const st = await runCli(eC, ["status"]);
      check("D1: mesh status exits non-zero", st.code !== 0 && st.code !== null, { code: st.code, out: st.out.slice(-200) });
      check("D1: no daemon on the port", !(await health(eC.port)));

      const h = await runHook(eC);
      check("D2: hook exits 0", h.code === 0, h.out);
      await sleep(3000);
      const up = await health(eC.port);
      check("D2: hook did not start a daemon (health fails 3 s later)", !up, { up, hook: h.out });
      check("D2: watcher does not see carol", !sees(await watcher(room("c")), "carol"));
      await killBackground(eC);

      // D3 positive control: a saved join + no daemon → the hook brings it back
      const e3 = makeEnv("d3", await freePort()); envs.push(e3);
      const w3 = await watcher(room("d3"));
      fs.mkdirSync(path.dirname(cfgPath(e3)), { recursive: true });
      fs.writeFileSync(cfgPath(e3), JSON.stringify({ room: room("d3"), relay: `ws://127.0.0.1:${relayPort}`, user: "dora", port: e3.port, cwd: e3.project, updatedAt: new Date().toISOString() }));
      const h3 = await runHook(e3);
      check("D3 (control): hook exits 0", h3.code === 0, h3.out);
      const started = await until(async () => (await health(e3.port))?.user === "dora" && sees(w3, "dora"), 10_000, 150);
      check("D3 (control): hook DID start a daemon from config.json (health + presence)", started, h3.out);
      const pid3 = Number(readJson(statePath(e3))?.pid);
      check("D3 (control): daemon.json has a pid", pid3 > 0);
      await killBackground(e3);
      check("D3 (control): killed daemon exited", !!pid3 && (await until(() => !pidAlive(pid3), 5000)) && !(await health(e3.port)));

      // D4: join --background, then mesh stop → exits and forgets config.json so the hook doesn't revive it
      const e4 = makeEnv("d4", await freePort()); envs.push(e4);
      const w4 = await watcher(room("d4"));
      const bg = await runCli(e4, joinArgs(e4, room("d4"), "dan", relayPort, ["--background"]), 25_000);
      check("D4: join --background exits 0", bg.code === 0, bg.out.slice(-300));
      const pid4 = Number(readJson(statePath(e4))?.pid);
      check("D4: background daemon up (health + presence)", pid4 > 0 && (await until(async () => (await health(e4.port))?.user === "dan" && sees(w4, "dan"), 10_000, 150)));
      const stop = await runCli(e4, ["stop"]);
      check("D4: mesh stop exits 0", stop.code === 0, stop.out.slice(-200));
      await assertLeft("D4", e4, room("d4"), "dan", relay, undefined, pid4);
      const h4 = await runHook(e4);
      await sleep(3000);
      check("D4: hook after stop did not revive the daemon", !(await health(e4.port)) && !sees(w4, "dan"), h4.out);
      await killBackground(e4);
    }

    // E. fresh explicit join by room link (no --relay) after the leave
    console.log("E. rejoin by room link");
    {
      const link = `http://127.0.0.1:${relayPort}/r/${room("c")}`;
      const p = await startDaemon("E", eC, room("c"), "carol", ["join", link, "--as", "carol", ...SAFE_FLAGS(eC.port)]);
      const h = await health(eC.port);
      check("E: /health reports the room", h?.room === room("c"), h);
      check("E: config.json exists again", readJson(cfgPath(eC))?.room === room("c"), readJson(cfgPath(eC)));
      await postJson(eC.port, "/leave", {});
      check("E: cleanup leave exits", await until(() => p.exited(), 5000));
    }

    // F. switch_room still works, then leave
    console.log("F. switch room");
    {
      const e = makeEnv("f", await freePort()); envs.push(e);
      const w1 = await watcher(room("f1"));
      const w2 = await watcher(room("f2"));
      const p = await startDaemon("F", e, room("f1"), "frank");
      const r = await postJson(e.port, "/switch", { room: room("f2") });
      check("F: POST /switch → 200 ok", r.status === 200 && r.body?.ok === true, r);
      check("F: /health reports the new room", await until(async () => (await health(e.port))?.room === room("f2"), 5000, 150), await health(e.port));
      check("F: watcher in new room sees frank", await until(() => sees(w2, "frank"), 5000));
      check("F: watcher in old room no longer sees frank", await until(() => !sees(w1, "frank"), 5000));
      check("F: config.json room updated", await until(() => readJson(cfgPath(e))?.room === room("f2"), 3000), readJson(cfgPath(e)));
      const l = await postJson(e.port, "/leave", { reason: "test F" });
      check("F: POST /leave after switch → 200", l.status === 200, l);
      await assertLeft("F", e, room("f2"), "frank", relay, p);
    }
  } finally {
    for (const w of watchers.values()) w.close();
    for (const c of children) killGroup(c);
    for (const e of envs) await killBackground(e);
    await relay.close();
    for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
    console.log(`(${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  }
}

main()
  .catch((e) => { console.error(e); failures++; })
  .finally(() => {
    console.log(failures ? `\n${failures} check(s) failed` : "\nall leave checks passed");
    process.exit(failures ? 1 : 0);
  });
