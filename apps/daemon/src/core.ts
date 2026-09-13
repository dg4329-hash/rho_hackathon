/**
 * DaemonCore: outgoing asks (request → decision/output/result), incoming requests
 * (permission → approval → shell/mcp execution → frames), events, activity, members.
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import chalk from "chalk";
import {
  OUTPUT_TAIL_BYTES,
  Artifact,
  type EventKind,
  type Frame,
  type Offer,
  type Permission,
  type RequestFrame,
  type TeamConfig,
  type JobResult,
  type InboxMessage,
  type EventFrame,
} from "@mesh/protocol";
import type { ActivityEntry, AskInput, DaemonCore, FetchedArtifact, Job, McpContentPart, McpImport, Member } from "./api.js";
import { askApproval } from "./approval.js";
import { artifactMeta, downloadArtifact, extFor, formatSize, mimeFor, scanOutputForFiles, uploadBytes, uploadFile } from "./artifacts.js";
import { nativeNotify } from "./native.js";
import { APPROVALS_MODES, PendingApprovals, type ApprovalsMode } from "./pending.js";
import { Jobs, toJobResult } from "./jobs.js";
import { resolvePermission } from "./permissions.js";
import { parseRoomArg } from "./register.js";
import { RelayClient, debug, RoomKeyError } from "./relay-client.js";
import { CHUNK_CHARS, isCompound, matchShellOffer, resolveOfferCommand, runShell } from "./shell.js";

export interface CoreOptions {
  /** Called by leave(): the CLI stops everything and exits. */
  onLeave?: (reason?: string) => void;
  /** Called after a successful switchRoom so the CLI can persist the new join target (and its room key). */
  onSwitch?: (room: string, relay: string, key?: string) => void;
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
/** Full command output kept for the MESH_FILE scan (the frame tail stays 8 KB). */
const SCAN_CAPTURE_BYTES = 8 * 1024 * 1024;
const KNOWN_ARTIFACTS_LIMIT = 500;

function chunkText(text: string, size = CHUNK_CHARS): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

export function createCore(opts: CoreOptions): DaemonCore & { client: RelayClient; jobs: Jobs } {
  const { config, cwd, client, mcpImport, shellOffers, mcpOffers } = opts;
  const me = config.user;
  const jobs = new Jobs();
  const pending = new PendingApprovals();
  const say = (line: string) => {
    if (!opts.quiet) console.log(line);
  };

  // ---------- artifacts we have seen (results + inbox), for fetch_artifact by id / url ----------
  const knownArtifacts = new Map<string, { artifact: Artifact; from: string }>();
  function remember(artifact: Artifact, from: string): void {
    knownArtifacts.set(artifact.id, { artifact, from });
    if (knownArtifacts.size > KNOWN_ARTIFACTS_LIMIT) knownArtifacts.delete(knownArtifacts.keys().next().value as string);
  }
  function knownByUrl(url: string): { artifact: Artifact; from: string } | undefined {
    for (const k of knownArtifacts.values()) if (k.artifact.url === url) return k;
    return undefined;
  }
  async function upload(name: string, bytes: Uint8Array, mime?: string): Promise<Artifact> {
    return uploadBytes(config.relay, config.room, me, name, bytes, mime, config.key);
  }

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
        if (frame.artifacts?.length) {
          job.artifacts = frame.artifacts;
          for (const a of frame.artifacts) remember(a, frame.from);
        }
        if (frame.artifactErrors?.length) job.artifactErrors = frame.artifactErrors;
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
    const answer = await askApproval({ id: req.id, from: req.from, why: req.why, command: req.command, tool: req.tool, args: req.args }, pending);
    if (!answer.approved) {
      sendDecision(req.id, "denied", answer.reason ?? "owner declined");
      return false;
    }
    sendDecision(req.id, "approved");
    return true;
  }

  async function serveShell(req: RequestFrame, command: string): Promise<void> {
    const match = matchShellOffer(command, config);
    // A compound request on a single-token offer was already downgraded to ask/never by matchShellOffer; don't let a
    // `permissions` glob re-upgrade it. Fixed offers run the owner's own line, so they are exempt from that check.
    const escalated = match.kind === "offer" && !match.fixed && isCompound(command) && match.permission !== "never";
    const permission =
      match.kind === "offer" && !escalated
        ? resolvePermission(match.offer.name, config, match.permission)
        : match.permission;
    const reason = match.kind === "offer" ? `'${match.offer.name}' is not offered (permission: never)` : "arbitrary commands are not allowed on this machine";
    if (!(await decide(req, permission, reason))) return;

    // Substitute the owner's real command path for a matched offer (requester only knows the basename from the offer text).
    const actual = match.kind === "offer" ? resolveOfferCommand(command, match.offer.command) : command;
    if (permission !== "always") say(chalk.dim(`  running for ${req.from}: ${actual}`));
    // Capture the whole output (not just the 8 KB tail) so a `MESH_FILE:` line early in a long run is still found.
    // Per stream, so a stderr chunk landing mid-line can't split a stdout `MESH_FILE:` line.
    const captured = { stdout: "", stderr: "" };
    let capturedOverflow = false;
    const result = await runShell(actual, { cwd, timeoutSeconds: config.timeoutSeconds }, (stream, chunk) => {
      if (captured[stream].length < SCAN_CAPTURE_BYTES) captured[stream] += chunk; else capturedOverflow = true;
      client.send({ type: "output", id: req.id, stream, chunk });
    });
    const { artifacts, artifactErrors } = await shipOutputFiles(req.from, `${captured.stdout}\n${captured.stderr}`, capturedOverflow);
    client.send({
      type: "result", id: req.id, ...result,
      ...(artifacts.length ? { artifacts } : {}),
      ...(artifactErrors.length ? { artifactErrors } : {}),
    });
    say(
      chalk.dim(
        `  ✔ ${req.from} › ${command.length > 60 ? command.slice(0, 59) + "…" : command}  exit ${result.exitCode ?? "null"} in ${result.durationMs} ms${result.timedOut ? " (timed out)" : ""}` +
          (artifacts.length ? `  📎 ${artifacts.map((a) => a.name).join(", ")}` : ""),
      ),
    );
  }

  /** `MESH_FILE: <path>` / `PNG: <x.png>` lines in the output → upload each existing file. Failures never fail the job. */
  async function shipOutputFiles(requester: string, output: string, overflow: boolean): Promise<{ artifacts: Artifact[]; artifactErrors: string[] }> {
    const artifacts: Artifact[] = [];
    const artifactErrors: string[] = [];
    if (overflow) artifactErrors.push(`output exceeded ${formatSize(SCAN_CAPTURE_BYTES)}; MESH_FILE lines after that were not scanned`);
    for (const file of scanOutputForFiles(output, cwd)) {
      try {
        const a = await uploadFile(config.relay, config.room, me, file, undefined, config.key);
        artifacts.push(a);
        remember(a, me);
      } catch (e) {
        const msg = (e as Error).message;
        artifactErrors.push(msg);
        say(chalk.yellow(`  ⚠ artifact for ${requester}: ${msg}`));
      }
    }
    return { artifacts, artifactErrors };
  }

  /** MCP `image` parts (base64) and `resource` parts with a blob → artifacts named `<tool>-<n>.<ext>`. */
  async function shipToolParts(tool: string, parts: McpContentPart[] | undefined): Promise<{ artifacts: Artifact[]; artifactErrors: string[] }> {
    const artifacts: Artifact[] = [];
    const artifactErrors: string[] = [];
    let n = 0;
    for (const part of parts ?? []) {
      const b64 = part.type === "image" || part.type === "audio" ? part.data : part.type === "resource" ? part.blob : undefined;
      if (!b64) continue;
      n++;
      const mime = part.mimeType ?? (part.uri ? mimeFor(part.uri) : "application/octet-stream");
      const fromUri = part.type === "resource" && part.uri ? path.basename(part.uri.replace(/^[a-z]+:\/\//i, "")) : "";
      const name = fromUri && path.extname(fromUri) ? fromUri : `${tool}-${n}.${extFor(mime)}`;
      try {
        const a = await upload(name, Buffer.from(b64, "base64"), mime);
        artifacts.push(a);
        remember(a, me);
      } catch (e) {
        const msg = (e as Error).message;
        artifactErrors.push(msg);
        say(chalk.yellow(`  ⚠ artifact from ${tool}: ${msg}`));
      }
    }
    return { artifacts, artifactErrors };
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
    let parts: McpContentPart[] | undefined;
    try {
      ({ text, isError, parts } = await mcpImport.callTool(tool, args));
    } catch (e) {
      text = `tool call failed: ${(e as Error).message}`;
      isError = true;
    }
    for (const chunk of chunkText(text)) client.send({ type: "output", id: req.id, stream: isError ? "stderr" : "stdout", chunk });
    const { artifacts, artifactErrors } = await shipToolParts(tool, parts);
    client.send({
      type: "result",
      id: req.id,
      exitCode: isError ? 1 : 0,
      durationMs: Date.now() - started,
      timedOut: false,
      tail: text.slice(-OUTPUT_TAIL_BYTES),
      ...(artifacts.length ? { artifacts } : {}),
      ...(artifactErrors.length ? { artifactErrors } : {}),
    });
    say(chalk.dim(`  ✔ ${req.from} › ${tool}  exit ${isError ? 1 : 0} in ${Date.now() - started} ms` + (artifacts.length ? `  📎 ${artifacts.map((a) => a.name).join(", ")}` : "")));
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
    if (client.replaying) { debug(`ignoring replayed request ${req.id}`); return; }
    if (client.recent().some((h) => h.frame.type === "decision" && h.frame.id === req.id)) { debug(`ignoring already-decided request ${req.id}`); return; }
    seenRequests.add(req.id);
    if (seenRequests.size > 1000) seenRequests.delete(seenRequests.values().next().value as string);
    const run = req.command ? serveShell(req, req.command) : req.tool ? serveTool(req, req.tool) : undefined;
    run?.catch((e) => {
      debug("serve failed", e);
      sendDecision(req.id, "denied", `daemon error: ${(e as Error).message}`);
    });
  }

  // ---------- messages addressed to me ----------
  const messages = new Map<string, InboxMessage>();
  function onMessage(frame: EventFrame): void {
    if ((frame.kind !== "message" && frame.kind !== "file") || frame.from === me) return;
    const to = String(frame.data?.to ?? "all");
    if (to !== me && to !== "all") return;
    let artifact: Artifact | undefined;
    if (frame.kind === "file") {
      const parsed = Artifact.safeParse(frame.data?.artifact);
      if (!parsed.success) { debug(`ignoring file event from ${frame.from}: malformed artifact`); return; }
      artifact = parsed.data;
      remember(artifact, frame.from);
    }
    const note = typeof frame.data?.note === "string" && frame.data.note.trim() ? frame.data.note.trim() : undefined;
    const text = artifact ? (note ?? `sent ${artifact.name} (${formatSize(artifact.size)})`) : String(frame.data?.text ?? frame.summary);
    const id = typeof frame.data?.id === "string" ? frame.data.id : artifact ? `${frame.from}:file:${artifact.id}` : `${frame.from}:${frame.ts}:${text.slice(0, 40)}`;
    if (messages.has(id)) return;
    messages.set(id, { id, ts: frame.ts, from: frame.from, to, text, read: false, ...(artifact ? { artifact } : {}) });
    pending.wakeAll();
    if (messages.size > 500) messages.delete(messages.keys().next().value as string);
    if (artifact) {
      say(`${chalk.cyan("📎")} ${chalk.magenta(frame.from)}${to === "all" ? chalk.dim(" (to all)") : ""} sent ${chalk.bold(artifact.name)} ${chalk.dim(`(${formatSize(artifact.size)})`)}${note ? `: ${note.length > 200 ? note.slice(0, 199) + "…" : note}` : ""}`);
    } else {
      say(`${chalk.cyan("✉")} ${chalk.magenta(frame.from)}${to === "all" ? chalk.dim(" (to all)") : ""}: ${text.length > 300 ? text.slice(0, 299) + "…" : text}`);
    }
    // OS notification only when nothing better is attached: an overlay or the Claude Code watcher already shows it live.
    if (!opts.quiet && !pending.watcherAttached() && Math.abs(Date.now() - Date.parse(frame.ts)) < 5 * 60_000) { debug("notify", frame.from); nativeNotify(artifact ? `mesh: file from ${frame.from}` : `mesh: message from ${frame.from}`, text); }
  }

  client.on("frame", (frame) => {
    if (frame.type === "request") onRequest(frame);
    else if (frame.type === "event") onMessage(frame);
    else onOwnedFrame(frame);
  });

  // ---------- DaemonCore ----------
  const core: DaemonCore & { client: RelayClient; jobs: Jobs } = {
    me,
    config,
    cwd,
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

    sendMessage(to: string, text: string): void {
      const trimmed = text.trim();
      client.send({ type: "event", kind: "message", summary: `→ ${to}: ${trimmed.slice(0, 140)}`, data: { id: randomUUID(), to, text: trimmed } });
    },

    inbox({ unreadOnly, sinceMinutes }) {
      const cutoff = Date.now() - sinceMinutes * 60_000;
      const out: InboxMessage[] = [];
      for (const m of messages.values()) {
        if (Date.parse(m.ts) < cutoff) continue;
        if (unreadOnly && m.read) continue;
        out.push({ ...m });
      }
      if (unreadOnly) for (const m of out) messages.get(m.id)!.read = true;
      return out.sort((a, b) => a.ts.localeCompare(b.ts));
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

    leave(reason?: string, delayMs = 300) {
      say(chalk.yellow(`leaving room ${config.room}${reason ? ` (${reason})` : ""}`));
      client.send({ type: "event", kind: "status", summary: `left the room${reason ? `: ${reason}` : ""}` });
      setTimeout(() => opts.onLeave?.(reason), delayMs);
    },

    async switchRoom(room: string, relay?: string, key?: string) {
      const link = parseRoomArg(room);
      const target = link.room.trim().toLowerCase();
      if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(target)) throw new Error(`bad room name '${room}' (letters, digits, dashes)`);
      const nextRelay = relay ?? link.relay ?? config.relay;
      const sameRelay = nextRelay.replace(/\/+$/, "") === config.relay.replace(/\/+$/, "");
      // A key carries over only within the same relay; across relays it is meaningless (docs/ROOM-KEYS.md).
      const nextKey = key ?? link.key ?? (sameRelay ? config.key : undefined);
      say(chalk.yellow(`switching room ${config.room} → ${target}${sameRelay ? "" : ` via ${nextRelay}`}`));
      client.send({ type: "event", kind: "status", summary: `left the room (switched to ${target})` });
      await new Promise((r) => setTimeout(r, 150));
      try {
        await client.switchRoom(target, sameRelay ? undefined : nextRelay, nextKey ?? null);
      } catch (e) {
        if (e instanceof RoomKeyError) {
          // client.switchRoom already reconnected us to the room we were in.
          throw new Error(
            `'${target}' needs its own room key (relay said: ${e.relayMessage}). Ask for the room link ` +
            `(https://<relay>/r/${target}#k=<key>) and pass it as \`room\`. Still in '${config.room}'.`,
          );
        }
        throw e;
      }
      config.room = target;
      config.relay = nextRelay;
      config.key = nextKey;
      opts.onSwitch?.(target, config.relay, nextKey);
      return { room: target, relay: config.relay };
    },

    approvalsMode() { return pending.mode; },
    setApprovalsMode(mode: string) {
      const m = mode.trim().toLowerCase();
      if (!(APPROVALS_MODES as string[]).includes(m)) throw new Error(`approvals mode must be one of ${APPROVALS_MODES.join(", ")}`);
      pending.mode = m as ApprovalsMode;
      say(chalk.dim(`approvals: ${m}`));
      return pending.mode;
    },

    relayStatus() {
      return client.status();
    },

    pendingApprovals(waitMs: number) {
      return pending.poll(waitMs);
    },

    async watchPoll(waitMs: number, opts?: { since?: string }) {
      if (opts?.since !== undefined) {
        // overlay-style consumer: cursor by timestamp, never marks read (the agent watcher may still want them)
        const newer = () => core.inbox({ unreadOnly: false, sinceMinutes: 120 }).filter((m) => m.ts > (opts.since ?? ""));
        if (newer().length > 0) return { pending: await pending.poll(0, "overlay"), messages: newer() };
        const list = await pending.poll(waitMs, "overlay");
        return { pending: list, messages: newer() };
      }
      const unreadNow = () => core.inbox({ unreadOnly: false, sinceMinutes: 120 }).filter((m) => !m.read);
      if (unreadNow().length > 0) {
        return { pending: await pending.poll(0), messages: core.inbox({ unreadOnly: true, sinceMinutes: 120 }) };
      }
      const list = await pending.poll(waitMs);
      return { pending: list, messages: core.inbox({ unreadOnly: true, sinceMinutes: 120 }) };
    },

    decide(id, decision, reason) {
      return pending.decide(id, decision, reason);
    },

    async sendFile(to, filePath, note) {
      const roots = [cwd, path.join(os.homedir(), ".mesh")];
      const abs = path.resolve(cwd, filePath);
      let real = abs;
      try { real = fs.realpathSync(abs); } catch { throw new Error(`${filePath}: no such file`); }
      const under = (root: string) => { let r = root; try { r = fs.realpathSync(root); } catch { /* keep as-is */ } return real === r || real.startsWith(r + path.sep); };
      if (!roots.some(under)) throw new Error(`${filePath} is outside the project (${cwd}) and ~/.mesh; send_file only ships files from those.`);
      const st = fs.statSync(real);
      if (!st.isFile()) throw new Error(`${filePath} is not a regular file`);
      const artifact = await uploadFile(config.relay, config.room, me, real, undefined, config.key);
      remember(artifact, me);
      const trimmed = note?.trim() || undefined;
      client.send({
        type: "event", kind: "file",
        summary: `→ ${to}: ${artifact.name} (${formatSize(artifact.size)})${trimmed ? ` — ${trimmed.slice(0, 120)}` : ""}`,
        data: { id: randomUUID(), to, artifact, ...(trimmed ? { note: trimmed } : {}) },
      });
      say(chalk.dim(`  📎 sent ${artifact.name} (${formatSize(artifact.size)}) to ${to}`));
      return artifact;
    },

    async fetchArtifact(input): Promise<FetchedArtifact> {
      let known: { artifact: Artifact; from: string } | undefined;
      let url = input.url;
      if (input.id) {
        known = knownArtifacts.get(input.id);
        if (!known && !url) {
          throw new Error(`no artifact with id '${input.id}' in recent results or inbox; pass its url instead (from ask_teammate / check_job / inbox output)`);
        }
        url ??= known?.artifact.url;
      }
      if (!url) throw new Error("fetch_artifact needs url or id");
      known ??= knownByUrl(url);
      let from = known?.from;
      let name = known?.artifact.name;
      if (!from || !name) {
        const meta = await artifactMeta(url, config.key);
        from ??= meta?.from ?? "unknown";
        name ??= meta?.name ?? decodeURIComponent(path.basename(new URL(url).pathname)) ?? "artifact";
      }
      const clean = (s: string) => path.basename(s).replace(/[\/\\\0]/g, "_") || "_";
      const root = path.resolve(cwd, "mesh-artifacts");
      const dest = path.resolve(root, clean(from), input.saveAs?.trim() ? input.saveAs.trim() : clean(name));
      if (!dest.startsWith(root + path.sep)) throw new Error(`saveAs '${input.saveAs}' would write outside mesh-artifacts/; artifacts stay under ${root}`);
      const { size, mime: servedMime } = await downloadArtifact(url, dest, config.key);
      const mime = known?.artifact.mime ?? (servedMime !== "application/octet-stream" ? servedMime : mimeFor(dest));
      say(chalk.dim(`  📥 fetched ${path.relative(cwd, dest)} (${formatSize(size)}) from ${from}`));
      return { path: dest, name: path.basename(dest), mime, size, from };
    },
  };

  // Keep hello offers on the client in sync (used on reconnect).
  client.offers = [...shellOffers, ...mcpOffers];
  return core;
}
