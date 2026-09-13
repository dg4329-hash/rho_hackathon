/**
 * Local HTTP + MCP server for the owner's IDE agent (Claude Code / Cursor).
 * Implements LocalServer (api.ts). CONTRACT §3 (tools) and §5 (routes), DEV.md step 3.
 *
 * `POST /mcp` is a stateless Streamable HTTP endpoint: a fresh McpServer + transport per request
 * (the pattern from the SDK's simpleStatelessStreamableHttp example), so no session bookkeeping.
 */
import type { Server as HttpServer } from "node:http";
import express, { type Request, type Response } from "express";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import fs from "node:fs";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  TOOL_DESCRIPTIONS, AskTeammateInput, CheckJobInput, PostEventInput, TeamActivityInput, DescribeCapabilityInput, SendMessageInput, InboxInput,
  ApproveRequestInput, EventKind, SendFileInput, FetchArtifactInput, type Offer,
} from "@mesh/protocol";
import type { DaemonCore, LocalServer } from "./api.js";
import { exampleArgs, validateAgainstSchema } from "./schema.js";

const SUMMARY_CHARS = 120;
/** fetch_artifact returns images inline up to this size, and text / JSON up to INLINE_TEXT_BYTES. */
const INLINE_IMAGE_BYTES = 5 * 1024 * 1024;
const INLINE_TEXT_BYTES = 200 * 1024;

// ---------- result helpers ----------

const ok = (obj: unknown): CallToolResult => ({ content: [{ type: "text", text: JSON.stringify(obj, null, 2) }] });
const fail = (msg: string): CallToolResult => ({ content: [{ type: "text", text: msg }], isError: true });

function summarize(description: string): string {
  const flat = description.replace(/\s+/g, " ").trim();
  return flat.length <= SUMMARY_CHARS ? flat : flat.slice(0, SUMMARY_CHARS - 1) + "…";
}

function offerNames(core: DaemonCore, who: string): string {
  const m = core.members().find((x) => x.user === who);
  if (!m) {
    const online = core.members().filter((x) => x.role !== "feed").map((x) => x.user);
    return `teammate '${who}' is not online. Online: ${online.length ? online.join(", ") : "(nobody)"}`;
  }
  const names = m.offers.map((o) => o.name);
  return `${who} offers: ${names.length ? names.join(", ") : "(nothing)"}`;
}

/** A copy-pasteable ask_teammate call for one offer. */
export function renderUsage(who: string, offer: Offer): string {
  if (offer.kind === "mcp") {
    const args = JSON.stringify(exampleArgs(offer.inputSchema));
    return `ask_teammate({ who: ${JSON.stringify(who)}, tool: ${JSON.stringify(offer.name)}, args: ${args}, why: "..." })`;
  }
  if (offer.fixed) {
    // Fixed command line: the owner runs exactly their line; the requester just names it (CONTRACT §2).
    return `ask_teammate({ who: ${JSON.stringify(who)}, command: ${JSON.stringify(offer.name)}, why: "..." })  // fixed command: ask by name, no arguments`;
  }
  const usageLine = offer.description.match(/Usage:\s*(.+)/i)?.[1]?.trim();
  const command = usageLine ?? "<command line, see description>";
  return `ask_teammate({ who: ${JSON.stringify(who)}, command: ${JSON.stringify(command)}, why: "..." })`;
}

// ---------- MCP server ----------

export function buildMcpServer(core: DaemonCore): McpServer {
  const server = new McpServer({ name: "mesh", version: "0.0.1" });
  /** Wrap a handler so thrown errors become isError results with a plain message instead of JSON-RPC faults. */
  const guard = <A,>(fn: (args: A) => Promise<CallToolResult> | CallToolResult) => async (args: A): Promise<CallToolResult> => {
    try { return await fn(args); } catch (e) { return fail(e instanceof Error ? e.message : String(e)); }
  };

  server.registerTool("list_teammates", { description: TOOL_DESCRIPTIONS.list_teammates, inputSchema: {} }, guard(async () => {
    const members = core.members()
      .filter((m) => m.role !== "feed")
      .map((m) => ({
        user: m.user,
        offers: m.offers.map((o) => ({ name: o.name, kind: o.kind, permission: o.permission, summary: summarize(o.description), ...(o.fixed ? { fixed: true, usage: `command: ${JSON.stringify(o.name)}` } : {}) })),
      }));
    return ok({ me: core.me, members });
  }));

  server.registerTool("describe_capability", {
    description: TOOL_DESCRIPTIONS.describe_capability,
    inputSchema: {
      who: z.string().describe("teammate handle, from list_teammates"),
      name: z.string().describe("offer name, e.g. 'supabase.run_sql' or 'figma.export'"),
    },
  }, guard((raw) => {
    const { who, name } = DescribeCapabilityInput.parse(raw);
    const offer = core.findOffer(who, name);
    if (!offer) return fail(`no capability '${name}' on ${who}. ${offerNames(core, who)}`);
    return ok({
      name: offer.name, kind: offer.kind, permission: offer.permission, description: offer.description,
      inputSchema: offer.inputSchema, notes: offer.notes, ...(offer.fixed ? { fixed: true } : {}), usage: renderUsage(who, offer),
    });
  }));

  server.registerTool("ask_teammate", {
    description: TOOL_DESCRIPTIONS.ask_teammate,
    inputSchema: {
      who: z.string().describe("teammate handle, from list_teammates"),
      why: z.string().describe("one line the teammate reads before approving: what you need and why"),
      waitSeconds: z.number().int().min(1).max(120).optional().describe("how long to wait for completion (default 45, max 120)"),
      command: z.string().min(1).optional().describe("shell command to run on their machine (shell form; exactly one of command/tool)"),
      tool: z.string().min(1).optional().describe("offer name '<server>.<tool>' (mcp form; exactly one of command/tool)"),
      args: z.record(z.unknown()).optional().describe("arguments for the tool, matching its inputSchema from describe_capability"),
    },
  }, guard(async (raw) => {
    const parsed = AskTeammateInput.safeParse(raw);
    if (!parsed.success) return fail(`bad request: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
    const input = parsed.data;
    if (input.tool) {
      const offer = core.findOffer(input.who, input.tool);
      if (!offer) return fail(`no capability '${input.tool}' on ${input.who}. ${offerNames(core, input.who)}`);
      if (offer.permission === "never") return fail(`${input.who} has marked '${input.tool}' as never allowed; do not retry.`);
      const err = validateAgainstSchema(offer.inputSchema, input.args ?? {});
      if (err) return fail(`${err}. Call describe_capability({ who: "${input.who}", name: "${input.tool}" }) for the schema.`);
    }
    const result = await core.ask({
      who: input.who, why: input.why, waitSeconds: input.waitSeconds,
      command: input.command, tool: input.tool, args: input.args,
    });
    return ok(result);
  }));

  server.registerTool("check_job", {
    description: TOOL_DESCRIPTIONS.check_job,
    inputSchema: {
      jobId: z.string().describe("jobId returned by ask_teammate"),
      waitSeconds: z.number().int().min(0).max(120).optional().describe("block up to this long for completion (default 0)"),
    },
  }, guard(async (raw) => {
    const { jobId, waitSeconds } = CheckJobInput.parse(raw);
    return ok(await core.checkJob(jobId, waitSeconds));
  }));

  server.registerTool("post_event", {
    description: TOOL_DESCRIPTIONS.post_event,
    inputSchema: {
      kind: EventKind.describe("prompt | tool_call | file_touched | status | note"),
      summary: z.string().describe("one short line"),
      data: z.record(z.unknown()).optional(),
    },
  }, guard((raw) => {
    const { kind, summary, data } = PostEventInput.parse(raw);
    core.postEvent(kind, summary, data);
    return ok({ ok: true });
  }));

  server.registerTool("send_message", {
    description: TOOL_DESCRIPTIONS.send_message,
    inputSchema: {
      to: z.string().describe("teammate handle from list_teammates, or 'all'"),
      text: z.string().min(1).max(2000).describe("short, concrete: what you changed / a fix idea / a question"),
    },
  }, guard((raw) => {
    const { to, text } = SendMessageInput.parse(raw);
    if (to !== "all" && !core.members().some((m) => m.user === to)) return fail(`no teammate '${to}' online. ${offerNames(core, to)}`);
    core.sendMessage(to, text);
    return ok({ ok: true, to });
  }));

  server.registerTool("wait_for_events", {
    description: "Wait for the next teammate message or request to use this machine (long-poll, up to timeoutSeconds). Returns messages and pending requests as information; approvals are decided by the user in the mesh overlay or dialog, never by you. Loop on this when the user asks you to watch mesh.",
    inputSchema: { timeoutSeconds: z.number().int().min(1).max(120).optional().describe("how long to wait (default 60)") },
  }, guard(async (raw) => {
    const t = Number((raw as { timeoutSeconds?: number }).timeoutSeconds ?? 60);
    const r = await core.watchPoll(Math.min(120, Math.max(1, t)) * 1000);
    const pendingInfo = r.pending.map((p) => ({ id: p.id, from: p.from, why: p.why, command: p.command, tool: p.tool, args: p.args, note: "waiting for the user to approve in the overlay/dialog" }));
    return ok({ messages: r.messages, pending: pendingInfo, ...(r.messages.length === 0 && pendingInfo.length === 0 ? { note: `nothing new in ${t}s; call again to keep watching` } : {}) });
  }));

  server.registerTool("inbox", {
    description: TOOL_DESCRIPTIONS.inbox,
    inputSchema: {
      unreadOnly: z.boolean().optional().describe("default true; marks returned messages read"),
      sinceMinutes: z.number().int().positive().optional().describe("look-back window (default 120)"),
    },
  }, guard((raw) => {
    const opts = InboxInput.parse(raw);
    return ok({ messages: core.inbox(opts) });
  }));

  server.registerTool("send_file", {
    description: TOOL_DESCRIPTIONS.send_file,
    inputSchema: {
      to: z.string().min(1).describe("teammate handle from list_teammates, or 'all'"),
      path: z.string().min(1).describe("file to send; absolute or relative to the project directory (must be inside the project or ~/.mesh)"),
      note: z.string().max(500).optional().describe("one line for the recipient: what this is / what to do with it"),
    },
  }, guard(async (raw) => {
    const { to, path: filePath, note } = SendFileInput.parse(raw);
    if (to !== "all" && !core.members().some((m) => m.user === to)) return fail(`no teammate '${to}' online. ${offerNames(core, to)}`);
    const artifact = await core.sendFile(to, filePath, note);
    return ok({ ok: true, to, artifact });
  }));

  server.registerTool("fetch_artifact", {
    description: TOOL_DESCRIPTIONS.fetch_artifact,
    inputSchema: {
      url: z.string().url().optional().describe("artifact url from ask_teammate / check_job / inbox output"),
      id: z.string().optional().describe("artifact id (from the same places) if you'd rather not paste the url"),
      saveAs: z.string().optional().describe("file name to save under mesh-artifacts/<from>/ (default: the artifact's own name)"),
    },
  }, guard(async (raw) => {
    const input = FetchArtifactInput.parse(raw);
    if (!input.url && !input.id) return fail("pass url or id (both come from ask_teammate / check_job results, inbox messages, or team_activity)");
    const fetched = await core.fetchArtifact(input);
    const content: CallToolResult["content"] = [{ type: "text", text: JSON.stringify({ path: fetched.path, name: fetched.name, mime: fetched.mime, size: fetched.size }, null, 2) }];
    const mime = fetched.mime.toLowerCase();
    if (mime.startsWith("image/") && mime !== "image/svg+xml" && fetched.size <= INLINE_IMAGE_BYTES) {
      content.push({ type: "image", data: fs.readFileSync(fetched.path).toString("base64"), mimeType: mime });
    } else if ((mime.startsWith("text/") || mime === "application/json" || mime === "image/svg+xml") && fetched.size <= INLINE_TEXT_BYTES) {
      content.push({ type: "text", text: fs.readFileSync(fetched.path, "utf8") });
    }
    return { content };
  }));

  server.registerTool("team_activity", {
    description: TOOL_DESCRIPTIONS.team_activity,
    inputSchema: { sinceMinutes: z.number().int().positive().optional().describe("look-back window (default 10)") },
  }, guard((raw) => {
    const { sinceMinutes } = TeamActivityInput.parse(raw);
    return ok({ events: core.activity(sinceMinutes) });
  }));

  // Deliberately never allowlisted: Claude Code's permission prompt for this call *is* the owner's yes/no.
  // `anthropic/requiresUserInteraction` makes Claude Code prompt on every call, in auto and bypass modes too,
  // with no "don't ask again" (Claude Code ≥ 2.1.199). The project's permissions.ask rule is the belt to this brace.
  server.registerTool("approve_request", {
    description: TOOL_DESCRIPTIONS.approve_request,
    inputSchema: {
      id: z.string().min(1).describe("request id from the mesh notification line"),
      decision: z.enum(["approved", "denied"]).describe("'approved' runs it on this machine; 'denied' tells the teammate no"),
      reason: z.string().max(300).optional().describe("optional one-line reason, shown to the teammate when denied"),
    },
    _meta: { "anthropic/requiresUserInteraction": true },
  }, guard((raw) => {
    const { id, decision, reason } = ApproveRequestInput.parse(raw);
    if (!core.decide(id, decision, reason)) {
      const waiting = core.pendingApprovals(0);
      return waiting.then((list) => fail(
        `no pending request '${id}' (it expired, was already decided, or never existed). ` +
        (list.length ? `Still pending: ${list.map((p) => `${p.id} (${p.from}: ${p.command ?? p.tool})`).join(", ")}` : "Nothing is pending."),
      ));
    }
    return ok({ ok: true, id, decision });
  }));

  return server;
}

// ---------- HTTP app ----------

const methodNotAllowed = (_req: Request, res: Response) => {
  res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null });
};

export function buildApp(core: DaemonCore): express.Express {
  const app = express();
  // CORS: only the relay's web origin (the room page / overlay) may call this daemon from a browser.
  // Anything else (random websites) is refused, so a page can't approve requests on your behalf.
  const relayOrigin = core.config.relay.replace(/^wss:/, "https:").replace(/^ws:/, "http:").replace(/\/+$/, "");
  app.use((req: Request, res: Response, next) => {
    const origin = req.headers.origin;
    const allowed = new Set([relayOrigin, relayOrigin.replace("://localhost", "://127.0.0.1"), relayOrigin.replace("://127.0.0.1", "://localhost")]);
    if (origin && allowed.has(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "content-type");
      res.setHeader("Access-Control-Allow-Private-Network", "true");
      res.setHeader("Access-Control-Max-Age", "600");
    }
    if (req.method === "OPTIONS") { res.status(204).end(); return; }
    next();
  });
  app.use(express.json({ limit: "4mb" }));

  app.post("/mcp", async (req, res) => {
    const server = buildMcpServer(core);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => { void transport.close(); void server.close(); });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      if (process.env.MESH_DEBUG) console.error("[local-server] /mcp error:", err);
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
      }
    }
  });
  app.get("/mcp", methodNotAllowed);
  app.delete("/mcp", methodNotAllowed);

  app.post("/event", (req, res) => {
    const parsed = PostEventInput.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ ok: false, error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") }); return; }
    core.postEvent(parsed.data.kind, parsed.data.summary, parsed.data.data);
    res.json({ ok: true });
  });

  app.post("/message", (req: Request, res: Response) => {
    const parsed = SendMessageInput.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ ok: false, error: parsed.error.issues.map((i) => i.message).join("; ") }); return; }
    core.sendMessage(parsed.data.to, parsed.data.text);
    res.json({ ok: true });
  });

  app.get("/inbox", (req: Request, res: Response) => {
    const unread = req.query.unread !== "0";
    res.json({ messages: core.inbox({ unreadOnly: unread, sinceMinutes: 120 }) });
  });

  app.get("/activity", (req, res) => {
    const n = Number(req.query.sinceMinutes);
    const sinceMinutes = Number.isFinite(n) && n > 0 ? Math.floor(n) : 10;
    res.json({ events: core.activity(sinceMinutes) });
  });

  // Who else touched this file recently? Backs the Claude Code pre_edit hook's conflict warning (CONTRACT §4/§5).
  // file_touched events from OTHER users whose path equals ?path (or matches it as a suffix: hooks and the git watch
  // may root paths differently). One entry per user, latest first.
  app.get("/touched", (req, res) => {
    const p = String(req.query.path ?? "").replace(/\\/g, "/").replace(/^\.\//, "").trim();
    const n = Number(req.query.minutes);
    const minutes = Number.isFinite(n) && n > 0 ? Math.min(600, Math.floor(n)) : 10;
    if (!p) { res.status(400).json({ ok: false, error: "path required" }); return; }
    const same = (s: string) => s === p || s.endsWith("/" + p) || p.endsWith("/" + s);
    const latest = new Map<string, string>();
    for (const e of core.activity(minutes)) if (e.type === "file_touched" && e.from !== core.me && same(e.summary)) latest.set(e.from, e.ts);
    const touched = [...latest].map(([user, ts]) => ({ user, ts })).sort((a, b) => b.ts.localeCompare(a.ts));
    res.json({ touched });
  });

  app.get("/health", (_req, res) => {
    res.json({ user: core.me, room: core.config.room, relay: core.relayStatus(), members: core.members().length });
  });

  // In-tool approvals (`mesh watch` + the plugin monitor). GET long-polls up to ?wait= seconds (max 60);
  // any poll marks a watcher as attached for the next 60 s, which routes approvals into the pending queue.
  app.get("/pending", async (req, res) => {
    const n = Number(req.query.wait);
    const waitSeconds = Number.isFinite(n) && n > 0 ? Math.min(60, n) : 0;
    if (req.query.messages === "1") {
      const since = req.query.consumer === "overlay" ? String(req.query.since ?? "") : undefined;
      res.json(await core.watchPoll(waitSeconds * 1000, since !== undefined ? { since } : undefined));
      return;
    }
    res.json({ pending: await core.pendingApprovals(waitSeconds * 1000) });
  });

  app.post("/decide", (req, res) => {
    const parsed = ApproveRequestInput.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ ok: false, error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") }); return; }
    const { id, decision, reason } = parsed.data;
    if (!core.decide(id, decision, reason)) { res.status(404).json({ ok: false, error: `no pending request ${id}` }); return; }
    res.json({ ok: true, id, decision });
  });

  return app;
}

export function createLocalServer(): LocalServer {
  let http: HttpServer | null = null;
  return {
    start(core, port) {
      return new Promise<void>((resolve, reject) => {
        const app = buildApp(core);
        const srv = app.listen(port, "127.0.0.1"); // loopback only: this server can act under the owner's identity
        srv.once("listening", () => { http = srv; resolve(); });
        srv.once("error", reject);
      });
    },
    stop() {
      return new Promise<void>((resolve) => {
        const srv = http;
        http = null;
        if (!srv) return resolve();
        srv.closeAllConnections?.();
        srv.close(() => resolve());
      });
    },
  };
}
