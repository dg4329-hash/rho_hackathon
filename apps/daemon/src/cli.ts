#!/usr/bin/env node
/** `mesh` CLI: join / ask / init (CONTRACT §6). */
import { copyFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import chalk from "chalk";
import { DEFAULT_PORT, type Offer, type TeamConfig } from "@mesh/protocol";
import { configFromFlags, loadConfig, userCwd } from "./config.js";
import { createCore } from "./core.js";
import { createLocalServer } from "./local-server.js";
import { createMcpImport } from "./mcp-import.js";
import { resolveNotes, resolvePermission } from "./permissions.js";
import { RelayClient } from "./relay-client.js";
import { restoreTerminal } from "./approval.js";

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

function shellOffersFrom(config: TeamConfig): Offer[] {
  return config.offers.map((o) => ({
    kind: "command" as const,
    name: o.name,
    description: o.description,
    permission: resolvePermission(o.name, config, o.permission),
    notes: o.notes ?? resolveNotes(o.name, config),
  }));
}

type CommonFlags = { as?: string; relay?: string; config?: string; room?: string };

function loadWithFlags(room: string | undefined, flags: CommonFlags): { config: TeamConfig; cwd: string; source: string } {
  const overrides = { user: flags.as, room, relay: flags.relay };
  try {
    const loaded = loadConfig(flags.config, overrides);
    return { config: loaded.config, cwd: loaded.cwd, source: loaded.path };
  } catch (e) {
    // No file but all three flags given (typical for `mesh ask` from a scratch dir): synthesize a config.
    if (!flags.config && flags.as && room && flags.relay) {
      return { config: configFromFlags(flags.as, room, flags.relay), cwd: userCwd(), source: "flags" };
    }
    return fail((e as Error).message);
  }
}

// ---------- join ----------
program
  .command("join")
  .description("join a room as a daemon and serve your offers")
  .argument("<room>")
  .requiredOption("--as <user>", "your handle")
  .option("--relay <url>", "relay websocket url")
  .option("--config <path>", "path to team.json")
  .option("--port <n>", "local MCP/HTTP port", String(DEFAULT_PORT))
  .action(async (room: string, flags: CommonFlags & { port: string }) => {
    const { config, cwd, source } = loadWithFlags(room, flags);
    const port = Number(flags.port) || DEFAULT_PORT;

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

    let stopping = false;
    const stop = async () => {
      if (stopping) return;
      stopping = true;
      console.log(chalk.dim("\nstopping…"));
      restoreTerminal();
      client.close();
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

program.parseAsync(process.argv).catch((e) => fail((e as Error).message));
