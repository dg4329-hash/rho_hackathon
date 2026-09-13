/**
 * Process harness for the end-to-end rooms test (scripts/e2e-rooms.ts).
 *
 * Spawns a private local relay and sandboxed daemons (temp HOME, temp cwd, no registration, no native
 * dialogs) and tears everything down again. Never touches the real ~/.mesh / ~/.claude / ~/.codex, and
 * never binds the ports a developer's live stack uses (7337 daemon, 8095 relay, 4040 ngrok, 8080).
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

// ---------- basics ----------

/**
 * This file's path. The root package.json has no "type": "module", so tsx loads scripts/ as CommonJS
 * (__filename exists, top-level await does NOT). Avoid `import.meta` so a plain tsc check of this file passes;
 * fall back to the stack trace (ESM) and finally to walking up from cwd to pnpm-workspace.yaml.
 */
function resolveRepoRoot(): string {
  if (typeof __filename === "string" && __filename) return path.resolve(path.dirname(__filename), "../..");
  const m = /(file:\/\/[^\s)]*?\/scripts\/e2e-rooms\/harness\.[cm]?[jt]s)/.exec(new Error().stack ?? "");
  if (m?.[1]) return path.resolve(path.dirname(fileURLToPath(m[1])), "../..");
  for (let d = process.cwd(); ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, "pnpm-workspace.yaml"))) return d;
    if (path.dirname(d) === d) throw new Error("harness: cannot locate the repo root");
  }
}
export const REPO_ROOT: string = resolveRepoRoot();
export const RELAY_ENTRY = path.join(REPO_ROOT, "apps/relay/src/index.ts");
export const DAEMON_ENTRY = path.join(REPO_ROOT, "apps/daemon/src/cli.ts");

/** Ports that belong to the developer's live stack: never hand these out. */
export const RESERVED_PORTS: ReadonlySet<number> = new Set([7337, 8095, 4040, 8080]);

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function waitFor<T>(
  fn: () => T | undefined | null | false | Promise<T | undefined | null | false>,
  timeoutMs: number,
  intervalMs = 150,
): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const v = await fn();
      if (v !== undefined && v !== null && v !== false) return v;
    } catch { /* not yet */ }
    if (Date.now() >= deadline) return undefined;
    await sleep(Math.min(intervalMs, Math.max(0, deadline - Date.now())));
  }
}

export async function freePort(): Promise<number> {
  for (let i = 0; i < 50; i++) {
    const port = await new Promise<number>((resolve, reject) => {
      const srv = net.createServer();
      srv.unref();
      srv.once("error", reject);
      srv.listen(0, "127.0.0.1", () => {
        const addr = srv.address();
        const p = typeof addr === "object" && addr ? addr.port : 0;
        srv.close(() => resolve(p));
      });
    });
    if (port > 0 && !RESERVED_PORTS.has(port)) return port;
  }
  throw new Error("freePort: could not find a free non-reserved port");
}

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[ -\/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;
export const stripAnsi = (s: string): string => s.replace(ANSI, "");

const LOG_CAP = 200 * 1024;

// ---------- tsx loader ----------

let loaderUrl: string | undefined;
/** file:// URL of tsx's ESM loader, so children run as a single `node --import <loader> entry.ts` process. */
export function tsxLoaderUrl(): string {
  if (loaderUrl) return loaderUrl;
  const req = createRequire(path.join(REPO_ROOT, "package.json"));
  let file: string;
  try {
    file = req.resolve("tsx"); // exports "." → dist/loader.mjs
  } catch {
    file = path.join(path.dirname(req.resolve("tsx/package.json")), "dist/loader.mjs");
  }
  if (!fs.existsSync(file)) throw new Error(`tsx loader not found at ${file} (run pnpm install at ${REPO_ROOT})`);
  loaderUrl = pathToFileURL(file).href;
  return loaderUrl;
}

// ---------- processes ----------

export interface Proc {
  name: string;
  pid: number;
  /** Combined stdout+stderr, ANSI stripped, last ~200 KB. */
  logs(): string;
  exited(): boolean;
  exitCode(): number | null;
  waitExit(timeoutMs: number): Promise<boolean>;
  /** SIGTERM, SIGKILL after 2 s; resolves when exited; no-op if already exited. */
  kill(): Promise<void>;
}

interface Registered { proc: Proc; child: ChildProcess }
const registry = new Set<Registered>();

function signalGroup(child: ChildProcess, sig: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  // Children are spawned detached (own process group): signal the group so grandchildren die too.
  try { process.kill(-child.pid, sig); return; } catch { /* group gone or not a leader */ }
  try { child.kill(sig); } catch { /* already gone */ }
}

export function spawnTs(name: string, entryAbs: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv }): Proc {
  const child = spawn(process.execPath, ["--import", tsxLoaderUrl(), entryAbs, ...args], {
    cwd: opts.cwd,
    env: opts.env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
    windowsHide: true,
  });
  let buf = "";
  let done = false;
  let code: number | null = null;
  const append = (d: Buffer | string) => {
    buf += stripAnsi(d.toString());
    if (buf.length > LOG_CAP) buf = buf.slice(buf.length - LOG_CAP);
  };
  child.stdout?.on("data", append);
  child.stderr?.on("data", append);
  const exitP = new Promise<void>((resolve) => {
    const finish = (c: number | null, err?: Error) => {
      if (done) return;
      done = true;
      code = c;
      if (err) append(`\n[harness] spawn error: ${err.message}\n`);
      resolve();
    };
    child.once("exit", (c) => finish(c));
    child.once("error", (e) => finish(null, e));
  });

  const proc: Proc = {
    name,
    pid: child.pid ?? -1,
    logs: () => buf,
    exited: () => done,
    exitCode: () => code,
    waitExit: async (timeoutMs) => {
      if (done) return true;
      let t: NodeJS.Timeout | undefined;
      await Promise.race([exitP, new Promise<void>((r) => { t = setTimeout(r, timeoutMs); })]);
      if (t) clearTimeout(t);
      return done;
    },
    kill: async () => {
      if (done) return;
      signalGroup(child, "SIGTERM");
      if (await proc.waitExit(2000)) return;
      signalGroup(child, "SIGKILL");
      await proc.waitExit(5000);
    },
  };
  const entry: Registered = { proc, child };
  registry.add(entry);
  void exitP.then(() => {
    // Sweep the group once the leader is gone, in case it left children behind.
    if (process.platform !== "win32" && child.pid !== undefined) { try { process.kill(-child.pid, "SIGKILL"); } catch { /* none */ } }
  });
  return proc;
}

function tail(s: string, lines: number): string {
  return s.split("\n").slice(-lines).join("\n");
}

async function getJson(url: string, timeoutMs = 1000): Promise<Record<string, unknown> | undefined> {
  const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!r.ok) return undefined;
  return (await r.json()) as Record<string, unknown>;
}

function withoutPrefixes(env: NodeJS.ProcessEnv, prefixes: string[]): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) if (!prefixes.some((p) => k.startsWith(p))) out[k] = v;
  return out;
}

// ---------- relay ----------

export interface LocalRelay {
  base: string;
  port: number;
  secret: string;
  proc: Proc;
  restart(opts?: { secret?: string }): Promise<void>;
  stop(): Promise<void>;
}

async function spawnRelay(port: number, secret: string, bindRetryMs: number): Promise<Proc> {
  const env = withoutPrefixes(process.env, ["MESH_"]);
  env.PORT = String(port);
  env.ROOM_SECRET = secret;
  delete env.MESH_REQUIRE_KEY;
  env.NO_COLOR = "1";
  env.FORCE_COLOR = "0";
  const deadline = Date.now() + bindRetryMs;
  for (let attempt = 1; ; attempt++) {
    const proc = spawnTs(`relay:${port}`, RELAY_ENTRY, [], { cwd: REPO_ROOT, env });
    const ok = await waitFor(async () => {
      if (proc.exited()) return true;
      const h = await getJson(`http://127.0.0.1:${port}/health`);
      return h && typeof h.rooms === "number" ? true : undefined;
    }, 20_000, 200);
    if (ok && !proc.exited()) return proc;
    const addrInUse = /EADDRINUSE/.test(proc.logs());
    await proc.kill();
    if (addrInUse && Date.now() < deadline) { await sleep(250); continue; }
    throw new Error(
      `relay on :${port} failed to start (attempt ${attempt}, exit ${proc.exitCode()}${ok ? "" : ", /health timed out after 20 s"})\n` +
        tail(proc.logs(), 40),
    );
  }
}

export async function startLocalRelay(opts: { secret?: string } = {}): Promise<LocalRelay> {
  const port = await freePort();
  const secret = opts.secret ?? randomBytes(16).toString("hex");
  const relay: LocalRelay = {
    base: `http://127.0.0.1:${port}`,
    port,
    secret,
    proc: await spawnRelay(port, secret, 3000),
    async restart(o = {}) {
      await relay.proc.kill();
      if (o.secret !== undefined) relay.secret = o.secret;
      relay.proc = await spawnRelay(port, relay.secret, 8000);
    },
    async stop() { await relay.proc.kill(); },
  };
  return relay;
}

// ---------- sandboxes ----------

export interface Sandbox { dir: string; home: string; cwd: string; config: string }

let tempRoot: string | undefined;
function runRoot(): string {
  if (!tempRoot) tempRoot = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "mesh-e2e-"));
  return tempRoot;
}
export function tempRootDir(): string | undefined { return tempRoot; }

export const SANDBOX_TEAM_JSON = {
  user: "placeholder",
  room: "placeholder",
  relay: "ws://127.0.0.1:1",
  allowArbitrary: "never",
  timeoutSeconds: 20,
  offers: [
    { name: "echo", command: "echo", description: "Usage: echo <text>", permission: "always" },
    { name: "uname", command: "uname", description: "Usage: uname", permission: "ask" },
  ],
};

let sandboxSeq = 0;
export function makeSandbox(name: string): Sandbox {
  const safe = name.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 40) || "sb";
  const dir = path.join(runRoot(), `${String(++sandboxSeq).padStart(2, "0")}-${safe}`);
  const home = path.join(dir, "home");
  const cwd = path.join(dir, "work");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(cwd, { recursive: true });
  const config = path.join(dir, "team.json");
  fs.writeFileSync(config, JSON.stringify(SANDBOX_TEAM_JSON, null, 2) + "\n");
  // GUI shims first on PATH: core.ts calls nativeNotify() (osascript `display notification`) for incoming messages
  // whenever no watcher polled /pending in the last 60 s, and that path is NOT gated by SSH_CONNECTION. The shims
  // swallow it (and any dialog) and append the argv to <dir>/gui.log so tests can assert on it.
  if (process.platform !== "win32") {
    const bin = path.join(dir, "bin");
    fs.mkdirSync(bin, { recursive: true });
    const log = path.join(dir, "gui.log");
    for (const tool of ["osascript", "notify-send", "zenity", "terminal-notifier"]) {
      fs.writeFileSync(path.join(bin, tool), `#!/bin/sh\nprintf '%s' "${tool}" >> '${log}'\nfor a in "$@"; do printf ' %s' "$a" >> '${log}'; done\necho >> '${log}'\nexit 0\n`, { mode: 0o755 });
    }
  }
  return { dir, home, cwd, config };
}

/** Lines the GUI shims recorded for this sandbox (notifications / dialogs the daemon tried to show). */
export function guiLog(sb: Sandbox): string[] {
  try { return fs.readFileSync(path.join(sb.dir, "gui.log"), "utf8").split("\n").filter(Boolean); } catch { return []; }
}

export function daemonEnv(sb: Sandbox): NodeJS.ProcessEnv {
  const env = withoutPrefixes(process.env, ["MESH_", "CLAUDE_", "CODEX_"]);
  Object.assign(env, {
    HOME: sb.home,
    USERPROFILE: sb.home,
    CLAUDE_CONFIG_DIR: path.join(sb.home, ".claude"),
    CODEX_HOME: path.join(sb.home, ".codex"),
    XDG_CONFIG_HOME: path.join(sb.home, ".config"),
    INIT_CWD: sb.cwd,
    SSH_CONNECTION: "e2e 0 e2e 0", // disables native approval dialogs (native.ts guiSession)
    MESH_APPROVE: "watcher",
    NO_COLOR: "1",
    FORCE_COLOR: "0",
    GIT_CEILING_DIRECTORIES: path.dirname(sb.dir), // the sandbox cwd must never look like a git repo
  });
  if (process.platform !== "win32") env.PATH = `${path.join(sb.dir, "bin")}${path.delimiter}${env.PATH ?? ""}`;
  return env;
}

export function joinArgs(o: { name: string; joinArg: string; port: number; sandbox: Sandbox; extra?: string[] }): string[] {
  return [
    "join", o.joinArg, "--as", o.name, "--port", String(o.port), "--config", o.sandbox.config,
    "--no-register", "--no-git-offers", "--no-git-watch", "--no-codex-wake", ...(o.extra ?? []),
  ];
}

// ---------- daemons ----------

export interface DaemonHandle { name: string; port: number; sandbox: Sandbox; proc: Proc }

export async function daemonHealth(port: number): Promise<Record<string, unknown> | undefined> {
  try { return await getJson(`http://127.0.0.1:${port}/health`); } catch { return undefined; }
}

export async function startDaemon(o: { name: string; joinArg: string; sandbox?: Sandbox; port?: number; extra?: string[]; timeoutMs?: number }): Promise<DaemonHandle> {
  const sandbox = o.sandbox ?? makeSandbox(o.name);
  const port = o.port ?? (await freePort());
  const timeoutMs = o.timeoutMs ?? 30_000;
  const proc = spawnTs(`daemon:${o.name}`, DAEMON_ENTRY, joinArgs({ name: o.name, joinArg: o.joinArg, port, sandbox, extra: o.extra }), {
    cwd: sandbox.cwd,
    env: daemonEnv(sandbox),
  });
  const ok = await waitFor(async () => {
    if (proc.exited()) return true;
    const h = await getJson(`http://127.0.0.1:${port}/health`);
    return h && h.user === o.name && h.relay === "connected" ? true : undefined;
  }, timeoutMs, 200);
  if (ok && !proc.exited()) return { name: o.name, port, sandbox, proc };
  const why = proc.exited() ? `exited with code ${proc.exitCode()}` : `not healthy+connected after ${timeoutMs} ms`;
  await proc.kill();
  throw new Error(`daemon ${o.name} (port ${port}) ${why}\n--- last 40 log lines ---\n${tail(proc.logs(), 40)}`);
}

export async function runJoinOnce(o: { name: string; joinArg: string; extra?: string[]; timeoutMs?: number }): Promise<{ exitCode: number | null; output: string; timedOut: boolean }> {
  const sandbox = makeSandbox(o.name);
  const port = await freePort();
  const proc = spawnTs(`join-once:${o.name}`, DAEMON_ENTRY, joinArgs({ name: o.name, joinArg: o.joinArg, port, sandbox, extra: o.extra }), {
    cwd: sandbox.cwd,
    env: daemonEnv(sandbox),
  });
  const exited = await proc.waitExit(o.timeoutMs ?? 15_000);
  if (!exited) await proc.kill();
  return { exitCode: exited ? proc.exitCode() : null, output: proc.logs(), timedOut: !exited };
}

// ---------- cleanup ----------

let cleaning: Promise<void> | undefined;
export async function cleanupAll(): Promise<void> {
  if (cleaning) return cleaning;
  cleaning = (async () => {
    const entries = [...registry];
    await Promise.all(entries.map((e) => e.proc.kill().catch(() => undefined)));
    for (const e of entries) registry.delete(e);
    if (tempRoot && process.env.MESH_E2E_KEEP === "1") {
      console.log(`kept temp dirs: ${tempRoot}`);
    } else if (tempRoot) {
      try { fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch { /* best effort */ }
    }
    tempRoot = undefined;
  })();
  try { await cleaning; } finally { cleaning = undefined; }
}

let signalsInstalled = false;
export function installSignalCleanup(): void {
  if (signalsInstalled) return;
  signalsInstalled = true;
  const onSignal = (sig: NodeJS.Signals, code: number) => {
    process.once(sig, () => process.exit(code)); // a second signal exits immediately
    void cleanupAll().finally(() => process.exit(code));
  };
  process.once("SIGINT", () => onSignal("SIGINT", 130));
  process.once("SIGTERM", () => onSignal("SIGTERM", 143));
  process.on("exit", () => {
    for (const e of registry) if (!e.proc.exited()) signalGroup(e.child, "SIGKILL");
    if (tempRoot && process.env.MESH_E2E_KEEP !== "1") { try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch { /* best effort */ } }
  });
}
