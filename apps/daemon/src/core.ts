/**
 * DaemonCore: outgoing asks (request → decision/output/result), incoming requests
 * (permission → approval → shell/mcp execution → frames), events, activity, members.
 */
import { randomUUID } from "node:crypto";
import chalk from "chalk";
import {
  OUTPUT_TAIL_BYTES,
  type EventKind,
  type Frame,
  type Offer,
  type Permission,
  type RequestFrame,
  type TeamConfig,
  type JobResult,
} from "@mesh/protocol";
import type { ActivityEntry, AskInput, DaemonCore, Job, McpImport, Member } from "./api.js";
import { askApproval } from "./approval.js";
import { Jobs, toJobResult } from "./jobs.js";
import { resolvePermission } from "./permissions.js";
import { RelayClient, debug } from "./relay-client.js";
import { CHUNK_CHARS, matchShellOffer, runShell } from "./shell.js";

export interface CoreOptions {
  config: TeamConfig;
  cwd: string;
  client: RelayClient;
  mcpImport: McpImport;
  /** Shell offers as advertised in `hello` (built from config.offers by the CLI). */
  shellOffers: Offer[];
  /** Imported MCP offers (from mcpImport.start()). */
  mcpOffers: Offer[];
  /** Print human-facing lines (default: true). Tests turn it off. */
  quiet?: boolean;
}

const ACTIVITY_LIMIT = 100;

function chunkText(text: string, size = CHUNK_CHARS): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

export function createCore(opts: CoreOptions): DaemonCore & { client: RelayClient; jobs: Jobs } {
  const { config, cwd, client, mcpImport, shellOffers, mcpOffers } = opts;
  const me = config.user;
  const jobs = new Jobs();
  const say = (line: string) => {
    if (!opts.quiet) console.log(line);
  };

  // ---------- frames for jobs we own ----------
  function onOwnedFrame(frame: Frame): void {
    if (frame.type !== "decision" && frame.type !== "output" && frame.type !== "result") return;
    const job = jobs.get(frame.id);
    if (!job) return;
    if (frame.from === me) return; // our own echo (relay never echoes, but be safe)
    if (frame.from !== job.to) {
      // Anyone in the room can see job ids; only the teammate we asked may answer.
      debug(`ignoring ${frame.type} for job ${frame.id} from ${frame.from} (expected ${job.to})`);
      return;
    }
    switch (frame.type) {
      case "decision":
        if (frame.decision === "denied") {
          job.status = "denied";
          job.reason = frame.reason ?? "denied";
        } else if (job.status === "pending") {
          job.status = "running";
        }
        break;
      case "output":
        if (job.status === "pending") job.status = "running";
        job.chunks.push(frame.chunk);
        break;
      case "result":
        job.status = "completed";
        job.exitCode = frame.exitCode;
        job.durationMs = frame.durationMs;
        if (job.chunks.length === 0 && frame.tail) job.chunks.push(...chunkText(frame.tail));
        break;
    }
    jobs.notify(job.id);
  }

  // ---------- incoming requests addressed to me ----------
  function sendDecision(id: string, decision: "approved" | "denied" | "auto", reason?: string): void {
    client.send({ type: "decision", id, decision, ...(reason ? { reason } : {}) });
  }

  async function decide(
    req: RequestFrame,
    permission: Permission,
    notOfferedReason: string,
  ): Promise<boolean> {
    if (permission === "never") {
      sendDecision(req.id, "denied", notOfferedReason);
      say(chalk.red(`✗ denied ${req.from}: ${req.command ?? req.tool} (${notOfferedReason})`));
      return false;
    }
    if (permission === "always") {
      sendDecision(req.id, "auto");
      say(chalk.green(`⚡ ${req.from} › ${req.command ?? req.tool}  ${chalk.dim("(auto-approved)")}`));
      return true;
    }
    const answer = await askApproval({ from: req.from, why: req.why, command: req.command, tool: req.tool, args: req.args });
    if (!answer.approved) {
      sendDecision(req.id, "denied", answer.reason ?? "owner declined");
      return false;
    }
    sendDecision(req.id, "approved");
    return true;
  }

  async function serveShell(req: RequestFrame, command: string): Promise<void> {
    const match = matchShellOffer(command, config);
    const permission =
      match.kind === "offer" ? resolvePermission(match.offer.name, config, match.permission) : match.permission;
    const reason = match.kind === "offer" ? `'${match.offer.name}' is not offered (permission: never)` : "arbitrary commands are not allowed on this machine";
    if (!(await decide(req, permission, reason))) return;

    if (permission !== "always") say(chalk.dim(`  running for ${req.from}: ${command}`));
    const result = await runShell(command, { cwd, timeoutSeconds: config.timeoutSeconds }, (stream, chunk) => {
      client.send({ type: "output", id: req.id, stream, chunk });
    });
    client.send({ type: "result", id: req.id, ...result });
    say(
      chalk.dim(
        `  ✔ ${req.from} › ${command.length > 60 ? command.slice(0, 59) + "…" : command}  exit ${result.exitCode ?? "null"} in ${result.durationMs} ms${result.timedOut ? " (timed out)" : ""}`,
      ),
    );
  }

  async function serveTool(req: RequestFrame, tool: string): Promise<void> {
    const offer = mcpOffers.find((o) => o.name === tool);
    if (!offer) {
      sendDecision(req.id, "denied", `unknown tool '${tool}' — call list_teammates for what ${me} offers`);
      return;
    }
    const permission = resolvePermission(tool, config, offer.permission);
    if (permission === "never") {
      sendDecision(req.id, "denied", `'${tool}' is not offered (permission: never)`);
      say(chalk.red(`✗ denied ${req.from}: ${tool} (not offered)`));
      return;
    }
    const args = req.args ?? {};
    const invalid = mcpImport.validateArgs(tool, args);
    if (invalid) {
      sendDecision(req.id, "denied", `invalid args for ${tool}: ${invalid}`);
      say(chalk.red(`✗ denied ${req.from}: ${tool} (invalid args: ${invalid})`));
      return;
    }
    if (!(await decide(req, permission, "not offered"))) return;

    const started = Date.now();
    if (permission !== "always") say(chalk.dim(`  calling for ${req.from}: ${tool}`));
    let text: string;
    let isError: boolean;
    try {
      ({ text, isError } = await mcpImport.callTool(tool, args));
    } catch (e) {
      text = `tool call failed: ${(e as Error).message}`;
      isError = true;
    }
    for (const chunk of chunkText(text)) client.send({ type: "output", id: req.id, stream: isError ? "stderr" : "stdout", chunk });
    client.send({
      type: "result",
      id: req.id,
      exitCode: isError ? 1 : 0,
      durationMs: Date.now() - started,
      timedOut: false,
      tail: text.slice(-OUTPUT_TAIL_BYTES),
    });
    say(chalk.dim(`  ✔ ${req.from} › ${tool}  exit ${isError ? 1 : 0} in ${Date.now() - started} ms`));
  }

  const REQUEST_MAX_AGE_MS = 30_000;
  const seenRequests = new Set<string>();
  function onRequest(req: RequestFrame): void {
    if (req.to !== me) return;
    if (req.from === me) return;
    // Replay guard: the relay replays up to 200 frames on (re)join. Never re-run a request that's
    // stale, already decided in the replayed history, or one we've handled in this process.
    if (seenRequests.has(req.id)) return;
    const age = Date.now() - Date.parse(req.ts);
    if (!Number.isFinite(age) || age > REQUEST_MAX_AGE_MS) { debug(`ignoring stale request ${req.id} (${age} ms old)`); return; }
    if (client.recent().some((h) => h.frame.type === "decision" && h.frame.id === req.id)) { debug(`ignoring already-decided request ${req.id}`); return; }
    seenRequests.add(req.id);
    if (seenRequests.size > 1000) seenRequests.delete(seenRequests.values().next().value as string);
    const run = req.command ? serveShell(req, req.command) : req.tool ? serveTool(req, req.tool) : undefined;
    run?.catch((e) => {
      debug("serve failed", e);
      sendDecision(req.id, "denied", `daemon error: ${(e as Error).message}`);
    });
  }

  client.on("frame", (frame) => {
    if (frame.type === "request") onRequest(frame);
    else onOwnedFrame(frame);
  });

  // ---------- DaemonCore ----------
  const core: DaemonCore & { client: RelayClient; jobs: Jobs } = {
    me,
    config,
    client,
    jobs,

    members(): Member[] {
      const p = client.presence();
      if (!p) return [];
      return p.members.filter((m) => m.user !== me).map((m) => ({ user: m.user, role: m.role, offers: m.offers }));
    },

    findOffer(who: string, name: string): Offer | undefined {
      return core.members().find((m) => m.user === who)?.offers.find((o) => o.name === name);
    },

    async ask(input: AskInput): Promise<JobResult> {
      const id = randomUUID();
      const job: Job = {
        id,
        from: me,
        to: input.who,
        why: input.why,
        command: input.command,
        tool: input.tool,
        args: input.args,
        status: "pending",
        chunks: [],
        createdAt: Date.now(),
      };
      jobs.add(job);
      const sent = client.send({
        type: "request",
        id,
        to: input.who,
        why: input.why,
        ...(input.command ? { command: input.command } : {}),
        ...(input.tool ? { tool: input.tool } : {}),
        ...(input.args ? { args: input.args } : {}),
      });
      if (!sent) {
        job.status = "denied";
        job.reason = "relay disconnected; request not sent";
        jobs.notify(id);
        return toJobResult(job);
      }
      return core.checkJob(id, input.waitSeconds);
    },

    async checkJob(jobId: string, waitSeconds: number): Promise<JobResult> {
      const job = jobs.get(jobId);
      if (!job) return { jobId, status: "denied", reason: `unknown job ${jobId}` };
      const done = await jobs.waitFor(jobId, Math.max(0, waitSeconds) * 1000);
      if (done.status === "pending") return { jobId, status: "running" };
      return toJobResult(done);
    },

    postEvent(kind: EventKind, summary: string, data?: Record<string, unknown>): void {
      client.send({ type: "event", kind, summary, ...(data ? { data } : {}) });
    },

    activity(sinceMinutes: number): ActivityEntry[] {
      const cutoff = Date.now() - sinceMinutes * 60_000;
      const out: ActivityEntry[] = [];
      for (const { frame, receivedAt } of client.recent()) {
        if (receivedAt < cutoff) continue;
        let entry: ActivityEntry | undefined;
        switch (frame.type) {
          case "event":
            entry = { ts: frame.ts, from: frame.from, type: frame.kind, summary: frame.summary };
            break;
          case "request":
            entry = {
              ts: frame.ts,
              from: frame.from,
              type: "request",
              summary: `${frame.from} → ${frame.to}: ${frame.command ?? frame.tool ?? ""}`,
            };
            break;
          case "decision":
            entry = {
              ts: frame.ts,
              from: frame.from,
              type: "decision",
              summary: `${frame.from}: ${frame.decision}${frame.reason ? ` (${frame.reason})` : ""}`,
            };
            break;
          case "result":
            entry = {
              ts: frame.ts,
              from: frame.from,
              type: "result",
              summary: `${frame.from}: exit ${frame.exitCode ?? "null"} in ${frame.durationMs} ms${frame.timedOut ? " (timed out)" : ""}`,
            };
            break;
        }
        if (entry) out.push(entry);
      }
      return out.slice(-ACTIVITY_LIMIT);
    },

    relayStatus() {
      return client.status();
    },
  };

  // Keep hello offers on the client in sync (used on reconnect).
  client.offers = [...shellOffers, ...mcpOffers];
  return core;
}
