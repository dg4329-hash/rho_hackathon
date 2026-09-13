#!/usr/bin/env node
/** `mesh` CLI: join / ask / init / watch / status / stop / log (CONTRACT §6). */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import chalk from "chalk";
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { DEFAULT_PORT, type Offer, type PendingRequest, type ShellOfferConfig, type TeamConfig } from "@mesh/protocol";
import { configFromFlags, loadConfig, userCwd } from "./config.js";
import { createCore } from "./core.js";
import { createLocalServer } from "./local-server.js";
import { createMcpImport } from "./mcp-import.js";
import { claudeHooksInstalled, findGitRoot, startGitWatch } from "./gitwatch.js";
import { resolveNotes, resolvePermission } from "./permissions.js";
import { defaultHandle, installClaudeHooks, parseRoomArg, printRegister, registerApproveAskRule, registerClaudeCode, registerClaudePlugin, registerCodex, registerCursor, type RegisterResult } from "./register.js";
import { RelayClient } from "./relay-client.js";
import { isFixedOffer } from "./shell.js";
import { restoreTerminal } from "./approval.js";
import { watchLine } from "./pending.js";

/** ~-relative path for banners. */
function shorten(p: string): string {
  const home = process.env.HOME ?? "";
  return home && p.startsWith(home) ? "~" + p.slice(home.length) : p;
}

const program = new Command();
program.name("mesh").description("borrow a teammate's machine, not their credentials");

function fail(msg: string, code = 1): never {
  console.error(chalk.red(msg));
  process.exit(code);
}

/**
 * Default visibility offers: read-only git commands, added automatically when the daemon's cwd is a git repo and the
 * owner hasn't defined an offer with the same name. Fixed lines (exact match only), so `always` can't leak into other
 * git commands. Disable with --no-git-offers or `"gitOffers": false` in team.json.
 */
export const DEFAULT_GIT_OFFERS: ShellOfferConfig[] = [
  { name: "git.status", command: "git status --short --branch", description: "Working-tree status of my repo (read-only). Call by name.", permission: "always" },
  { name: "git.diff", command: "git diff HEAD", description: "My uncommitted diff, staged + unstaged (read-only). Call by name.", permission: "always" },
  { name: "git.log", command: "git log --oneline -20", description: "My last 20 commits (read-only). Call by name.", permission: "always" },
  { name: "git.branch", command: "git rev-parse --abbrev-ref HEAD", description: "Which branch I'm on (read-only). Call by name.", permission: "always" },
];

function isGitRepo(dir: string): boolean {
  return spawnSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: dir, stdio: "ignore" }).status === 0;
}

/** config.offers plus DEFAULT_GIT_OFFERS (when enabled and in a git repo), without overriding user-defined names. */
export function effectiveShellOffers(config: TeamConfig, cwd: string, enableGitOffers: boolean): ShellOfferConfig[] {
  if (!enableGitOffers || config.gitOffers === false || !isGitRepo(cwd)) return config.offers;
  const names = new Set(config.offers.map((o) => o.name));
  return [...config.offers, ...DEFAULT_GIT_OFFERS.filter((o) => !names.has(o.name))];
}

function shellOffersFrom(config: TeamConfig): Offer[] {
  return config.offers.map((o) => ({
    kind: "command" as const,
    name: o.name,
    description: o.description,
    permission: resolvePermission(o.name, config, o.permission),
    notes: o.notes ?? resolveNotes(o.name, config),
    ...(isFixedOffer(o) ? { fixed: true } : {}),
  }));
}

type CommonFlags = { as?: string; relay?: string; config?: string; room?: string };

function loadWithFlags(room: string | undefined, flags: CommonFlags): { config: TeamConfig; cwd: string; source: string } {
  const overrides = { user: flags.as, room, relay: flags.relay };
  try {
    const loaded = loadConfig(flags.config, overrides);
    return { config: loaded.config, cwd: loaded.cwd, source: loaded.path };
  } catch (e) {
    // No file: synthesize a config from flags/defaults (zero-config join; `mesh ask` from a scratch dir).
    const relay = flags.relay ?? process.env.MESH_RELAY;
    if (!flags.config && room && relay) {
      return { config: configFromFlags(flags.as ?? defaultHandle(), room, relay), cwd: userCwd(), source: "defaults (no team.json)" };
    }
    return fail((e as Error).message + (relay ? "" : "\n  hint: pass the room link (https://<relay>/r/<room>) or --relay wss://<host>"));
  }
}

// ---------- join ----------
program
  .command("join")
  .description("join a room (name or room link) and serve your offers; registers the mesh MCP server with your agents")
  .argument("<room>", "room name, or a room link like https://<relay>/r/<room>")
  .option("--as <user>", "your handle (default: git user.name)")
  .option("--relay <url>", "relay websocket url (derived from a room link)")
  .option("--config <path>", "path to team.json")
  .option("--port <n>", "local MCP/HTTP port", String(DEFAULT_PORT))
  .option("--no-register", "don't touch Claude Code / Cursor / Codex config or hooks")
  .option("--cursor", "force Cursor registration even if no .cursor dir is present")
  .option("--codex", "force Codex registration even if codex isn't installed")
  .option("--background", "run detached in the background (approvals via native OS dialogs); see `mesh status` / `mesh stop`")
  .option("--no-git-offers", "don't add the default read-only git offers (git.status/diff/log/branch)")
  .option("--no-git-watch", "don't emit file_touched events from git status (on by default inside a git repo)")
  .action(async (roomArg: string, flags: CommonFlags & { port: string; register: boolean; cursor?: boolean; codex?: boolean; background?: boolean; gitWatch?: boolean; gitOffers?: boolean }) => {
    const target = parseRoomArg(roomArg);
    const room = target.room;
    if (target.relay && !flags.relay) flags.relay = target.relay;
    const { config, cwd, source } = loadWithFlags(room, flags);
    const port = Number(flags.port) || DEFAULT_PORT;
    // Remember how we joined so the Claude Code plugin's SessionStart hook can bring the daemon back later.
    try { writeJoinConfig({ room: config.room, relay: config.relay, user: config.user, port, cwd, updatedAt: new Date().toISOString() }); } catch { /* best effort */ }

    if (flags.background) {
      const running = await readState(port);
      if (running) {
        console.log(chalk.green(`mesh is already running`) + chalk.dim(`  ${running.user}@${running.room} pid ${running.pid} port ${running.port}  (mesh stop to end it)`));
        return;
      }
      const args = process.argv.slice(1).filter((a) => a !== "--background");
      mkdirSync(meshHome(), { recursive: true });
      const log = openSync(logPath(), "a");
      const child = spawn(process.execPath, [...process.execArgv, ...args], {
        cwd: userCwd(), env: { ...process.env, INIT_CWD: userCwd(), MESH_BACKGROUND: "1" }, detached: true, stdio: ["ignore", log, log], windowsHide: true,
      });
      child.unref();
      writeState({ pid: child.pid ?? 0, port, room: config.room, relay: config.relay, user: config.user, cwd, startedAt: new Date().toISOString() });
      // wait briefly for /health so the user gets a definite answer
      const ok = await waitHealth(port, 15_000);
      if (ok) {
        console.log(chalk.green(`● mesh running in the background`) + chalk.dim(`  ${config.user}@${config.room}  mcp=http://localhost:${port}/mcp  pid ${child.pid}`));
        console.log(chalk.dim(`  approvals pop up as system dialogs; log: ${logPath()}; \`mesh status\` / \`mesh stop\``));
        const tail = readFileSync(logPath(), "utf8").split("\n").filter((l) => /registered|already registered|restart your agent/.test(l)).slice(-6);
        for (const l of tail) console.log(l);
      } else {
        console.log(chalk.red(`mesh did not come up within 15 s; see ${logPath()}`));
        process.exitCode = 1;
      }
      return;
    }

    const mcpImport = createMcpImport();
    const imported = await mcpImport.start(config, cwd);
    const servers = new Map<string, number>();
    for (const o of imported.offers) servers.set(o.server ?? "?", (servers.get(o.server ?? "?") ?? 0) + 1);
    const perServer = [...servers].map(([s, n]) => `${s} ${n}`).join(", ");
    console.log(
      chalk.dim(
        `imported ${servers.size} servers, ${imported.offers.length} tools${perServer ? ` (${perServer})` : ""}` +
          (imported.skipped.length ? `; ${imported.skipped.map((s) => `skipped ${s.server}: ${s.reason}`).join("; ")}` : ""),
      ),
    );
    if (imported.skipped.length) console.log(chalk.dim("  (add a shell offer in team.json for anything skipped)"));

    config.offers = effectiveShellOffers(config, cwd, flags.gitOffers !== false);
    const shellOffers = shellOffersFrom(config);
    const client = new RelayClient({
      relay: config.relay,
      room: config.room,
      user: config.user,
      role: "daemon",
      offers: [...shellOffers, ...imported.offers],
    });
    const core = createCore({ config, cwd, client, mcpImport, shellOffers, mcpOffers: imported.offers });
    client.on("open", () => console.log(chalk.green(`● connected to ${config.relay} room=${config.room} as ${config.user}`)));
    client.on("close", () => console.log(chalk.yellow("○ relay disconnected; reconnecting…")));
    client.on("presence", (p) => {
      const others = p.members.filter((m) => m.user !== config.user).map((m) => `${m.user}(${m.role})`);
      console.log(chalk.dim(`  members: ${others.length ? others.join(", ") : "just you"}`));
    });
    client.connect().catch(() => undefined);

    // Register with the agents BEFORE the local server listens: `claude mcp get` / `codex mcp get` probe the URL,
    // and a probe against our own not-yet-serving port fails fast instead of stalling the (blocked) event loop.
    if (flags.register !== false) {
      const results: RegisterResult[] = [
        await registerClaudePlugin(config.relay, cwd),
        registerClaudeCode(port, cwd),
        installClaudeHooks(cwd, port),
        registerApproveAskRule(cwd),
        registerCursor(port, cwd, flags.cursor),
        registerCodex(port, flags.codex),
      ];
      console.log(chalk.dim("agents:"));
      printRegister(results);
      if (results.some((r) => r.status === "registered")) console.log(chalk.yellow("  ↻ restart your agent session so it picks up the mesh tools"));
    }
    const server = createLocalServer();
    try {
      await server.start(core, port);
    } catch (e) {
      fail(`local server failed to start on :${port}: ${(e as Error).message}`);
    }
    console.log(
      `${chalk.bold("mesh")} ${config.user}@${config.room}  offers=${shellOffers.length + imported.offers.length}  ` +
        `mcp=http://localhost:${port}/mcp\n  cwd=${shorten(cwd)}  config=${shorten(source)}`,
    );

    // Universal file_touched events for agents that have no hooks (Codex, Cursor, a human in vim).
    let gitWatch: { stop(): void } | undefined;
    if (flags.gitWatch !== false) {
      const root = findGitRoot(cwd);
      const log = (l: string) => console.log(chalk.dim(l));
      if (root && !claudeHooksInstalled(cwd, root)) {
        gitWatch = startGitWatch({ cwd, root, emit: (p) => core.postEvent("file_touched", p, { source: "git" }), log });
        log(`git watch: on (${root})`);
      } else if (root) {
        log("git watch: off (Claude Code hooks emit file events)");
      }
    }

    let stopping = false;
    const stop = async () => {
      if (stopping) return;
      stopping = true;
      console.log(chalk.dim("\nstopping…"));
      restoreTerminal();
      client.close();
      gitWatch?.stop();
      await Promise.allSettled([server.stop(), mcpImport.stop()]);
      process.exit(0);
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  });

// ---------- ask ----------
program
  .command("ask")
  .description("ask a teammate to run a shell command on their machine")
  .argument("<who>")
  .argument("<command>")
  .option("--why <text>", "why you need it", "manual request via mesh ask")
  .option("--room <room>")
  .option("--as <user>")
  .option("--relay <url>")
  .option("--config <path>")
  .option("--wait <seconds>", "how long to wait for completion", "120")
  .action(async (who: string, command: string, flags: CommonFlags & { why: string; wait: string }) => {
    const { config, cwd } = loadWithFlags(flags.room, flags);
    const client = new RelayClient({ relay: config.relay, room: config.room, user: config.user, role: "daemon", offers: [] });
    const mcpImport = createMcpImport();
    const core = createCore({ config, cwd, client, mcpImport, shellOffers: [], mcpOffers: [], quiet: true });

    let sawOutput = false;
    client.on("frame", (f) => {
      if (f.type === "output" && core.jobs.has(f.id)) {
        sawOutput = true;
        (f.stream === "stderr" ? process.stderr : process.stdout).write(f.chunk);
      }
    });

    const timer = setTimeout(() => fail(`could not reach relay ${config.relay}`, 2), 10_000);
    await client.connect();
    clearTimeout(timer);
    console.error(chalk.dim(`→ ${who}: ${command}`));

    const result = await core.ask({ who, command, why: flags.why, waitSeconds: Number(flags.wait) || 120 });
    client.close();
    if (result.status === "denied") {
      console.error(chalk.red(`denied: ${result.reason}`));
      process.exit(2);
    }
    if (result.status !== "completed") {
      console.error(chalk.yellow(`still ${result.status} after ${flags.wait}s (job ${result.jobId})`));
      process.exit(2);
    }
    if (!sawOutput && result.output) process.stdout.write(result.output);
    console.error(chalk.dim(`← exit ${result.exitCode ?? "null"} in ${result.durationMs} ms`));
    process.exit(result.exitCode ?? 1);
  });

// ---------- init ----------
program
  .command("init")
  .description("write a starter team.json in the current directory")
  .action(() => {
    const target = path.resolve(userCwd(), "team.json");
    if (existsSync(target)) return console.log(chalk.yellow(`${target} already exists; leaving it alone`));
    const here = path.dirname(fileURLToPath(import.meta.url));
    const candidates = [
      path.resolve(here, "../../../team.json.example"), // repo root from apps/daemon/{src,dist}
      path.resolve(here, "../team.json.example"),
      path.resolve(userCwd(), "team.json.example"),
    ];
    const example = candidates.find((p) => existsSync(p));
    if (!example) return fail("team.json.example not found; copy one from the repo root");
    copyFileSync(example, target);
    console.log(chalk.green(`wrote ${target}`) + chalk.dim(" — edit user/room/relay/cwd, then `mesh join <room> --as <user>`"));
  });

// ---------- watch (the Claude Code plugin's background monitor) ----------
program
  .command("watch")
  .description("print one line per teammate request waiting for your approval (run by the Claude Code plugin monitor; Ctrl-C / SIGTERM to stop)")
  .option("--port <n>", "local daemon port", String(DEFAULT_PORT))
  .action(async (flags: { port: string }) => {
    const port = Number(flags.port) || DEFAULT_PORT;
    const base = `http://localhost:${port}`;
    const printed = new Set<string>();
    let down = false;
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => process.exit(0));
    for (;;) {
      let list: PendingRequest[] | undefined;
      try {
        const r = await fetch(`${base}/pending?wait=25&messages=1`, { signal: AbortSignal.timeout(40_000) });
        if (r.ok) {
          const body = (await r.json()) as { pending?: PendingRequest[]; messages?: Array<{ id: string; from: string; to: string; text: string; artifact?: { id: string; name: string; mime: string; size: number; url: string } }> };
          list = body.pending ?? [];
          for (const m of body.messages ?? []) {
            if (printed.has("msg:" + m.id)) continue;
            printed.add("msg:" + m.id);
            if (m.artifact) {
              console.log(`mesh: ${m.from} sent you a file${m.to === "all" ? " (to everyone)" : ""}: ${m.artifact.name} (${m.artifact.mime}, ${m.artifact.size} bytes)${m.text && m.text !== `sent ${m.artifact.name}` ? `, note: ${JSON.stringify(m.text)}` : ""}. Tell the user; to look at it call the mesh fetch_artifact tool with url ${JSON.stringify(m.artifact.url)} (it lands in ./mesh-artifacts/ and images come back inline).`);
              continue;
            }
            console.log(`mesh: message from ${m.from}${m.to === "all" ? " (to everyone)" : ""}: ${JSON.stringify(m.text)}. Tell the user, and if a reply is needed use the mesh send_message tool (to: ${JSON.stringify(m.from)}).`);
          }
        }
      } catch { /* daemon down or restarting */ }
      if (!list) {
        if (!down) { console.error(`mesh watch: no daemon on :${port}; retrying every 3 s (mesh status / mesh join <room> --background)`); down = true; }
        await sleep(3000);
        continue;
      }
      if (down) { console.error(`mesh watch: connected to :${port}`); down = false; }
      const live = new Set(list.map((p) => p.id));
      for (const p of list) if (!printed.has(p.id)) { printed.add(p.id); console.log(watchLine(p)); }
      for (const id of printed) if (!live.has(id)) printed.delete(id);
    }
  });

// ---------- background state ----------
interface DaemonState { pid: number; port: number; room: string; relay: string; user: string; cwd: string; startedAt: string }
/** ~/.mesh/config.json: how the last `mesh join` was invoked (the plugin's SessionStart hook restarts the daemon from it). */
interface JoinConfig { room: string; relay: string; user: string; port: number; cwd: string; updatedAt: string }
const meshHome = () => path.join(homedir(), ".mesh");
const statePath = () => path.join(meshHome(), "daemon.json");
const logPath = () => path.join(meshHome(), "daemon.log");
const configPath = () => path.join(meshHome(), "config.json");
function writeJoinConfig(cfg: JoinConfig): void { mkdirSync(meshHome(), { recursive: true }); writeFileSync(configPath(), JSON.stringify(cfg, null, 2) + "\n"); }
function writeState(st: DaemonState): void { mkdirSync(meshHome(), { recursive: true }); writeFileSync(statePath(), JSON.stringify(st, null, 2)); }
function loadState(): DaemonState | undefined { try { return JSON.parse(readFileSync(statePath(), "utf8")) as DaemonState; } catch { return undefined; } }
async function health(port: number): Promise<Record<string, unknown> | undefined> {
  try { const r = await fetch(`http://localhost:${port}/health`, { signal: AbortSignal.timeout(1500) }); return r.ok ? (await r.json()) as Record<string, unknown> : undefined; } catch { return undefined; }
}
async function waitHealth(port: number, ms: number): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) { if (await health(port)) return true; await new Promise((r) => setTimeout(r, 400)); }
  return false;
}
/** State file + a live /health on that port → running. Stale file → cleaned up. */
async function readState(port?: number): Promise<DaemonState | undefined> {
  const st = loadState();
  if (!st) return undefined;
  if (port && st.port !== port) return undefined;
  if (await health(st.port)) return st;
  try { unlinkSync(statePath()); } catch { /* ignore */ }
  return undefined;
}

program
  .command("status")
  .description("is the background daemon running?")
  .action(async () => {
    const st = await readState();
    if (!st) { console.log(chalk.dim("mesh is not running in the background") + chalk.dim("  (mesh join <room> --background)")); process.exitCode = 1; return; }
    const h = await health(st.port);
    console.log(chalk.green("● running") + `  ${st.user}@${st.room}  relay=${String(h?.relay)}  members=${String(h?.members)}  mcp=http://localhost:${st.port}/mcp  pid ${st.pid}`);
    console.log(chalk.dim(`  since ${st.startedAt}  log ${logPath()}`));
  });

program
  .command("stop")
  .description("stop the background daemon")
  .action(async () => {
    const st = loadState();
    if (!st) { console.log(chalk.dim("nothing to stop")); return; }
    try { process.kill(st.pid, "SIGTERM"); console.log(chalk.green(`stopped mesh (pid ${st.pid})`)); } catch { console.log(chalk.dim(`process ${st.pid} was not running`)); }
    try { unlinkSync(statePath()); } catch { /* ignore */ }
  });

program
  .command("log")
  .description("print the background daemon's log")
  .action(() => { if (existsSync(logPath())) process.stdout.write(readFileSync(logPath(), "utf8")); else console.log(chalk.dim("no log yet")); });

program.parseAsync(process.argv).catch((e) => fail((e as Error).message));
