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
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  TOOL_DESCRIPTIONS, AskTeammateInput, CheckJobInput, PostEventInput, TeamActivityInput, DescribeCapabilityInput,
  EventKind, type Offer,
} from "@mesh/protocol";
import type { DaemonCore, LocalServer } from "./api.js";
import { exampleArgs, validateAgainstSchema } from "./schema.js";

const SUMMARY_CHARS = 120;

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
        offers: m.offers.map((o) => ({ name: o.name, kind: o.kind, permission: o.permission, summary: summarize(o.description) })),
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
      inputSchema: offer.inputSchema, notes: offer.notes, usage: renderUsage(who, offer),
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

  server.registerTool("team_activity", {
    description: TOOL_DESCRIPTIONS.team_activity,
    inputSchema: { sinceMinutes: z.number().int().positive().optional().describe("look-back window (default 10)") },
  }, guard((raw) => {
    const { sinceMinutes } = TeamActivityInput.parse(raw);
    return ok({ events: core.activity(sinceMinutes) });
  }));

  return server;
}

// ---------- HTTP app ----------

const methodNotAllowed = (_req: Request, res: Response) => {
  res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null });
};

export function buildApp(core: DaemonCore): express.Express {
  const app = express();
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

  app.get("/activity", (req, res) => {
    const n = Number(req.query.sinceMinutes);
    const sinceMinutes = Number.isFinite(n) && n > 0 ? Math.floor(n) : 10;
    res.json({ events: core.activity(sinceMinutes) });
  });

  app.get("/health", (_req, res) => {
    res.json({ user: core.me, room: core.config.room, relay: core.relayStatus(), members: core.members().length });
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
