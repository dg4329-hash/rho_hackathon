/**
 * Import the owner's MCP servers (Claude Code / Cursor configs) as `mcp` offers,
 * and act as the MCP *client* that runs them when a teammate's request is approved.
 * Implements McpImport (api.ts). CONTRACT §2 "Import rule" / "Call rule", DEV.md step 3b.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { minimatch } from "minimatch";
import { trackMcpPid } from "./children.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { Offer, Permission, TeamConfig } from "@mesh/protocol";
import type { McpContentPart, McpImport } from "./api.js";
import { validateAgainstSchema } from "./schema.js";

const CONNECT_TIMEOUT_MS = 10_000;
const TEXT_CAP_BYTES = 64 * 1024;
const AUTH_REASON = "auth required (OAuth?) — add a shell offer instead";

const debug = (...a: unknown[]) => { if (process.env.MESH_DEBUG) console.error("[mcp-import]", ...a); };

// ---------- config discovery ----------

export interface ServerEntry {
  name: string;
  kind: "stdio" | "http" | "sse";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

type RawServer = Record<string, unknown>;

function readJson(file: string): Record<string, unknown> | undefined {
  try {
    const txt = fs.readFileSync(file, "utf8");
    const obj = JSON.parse(txt);
    return obj && typeof obj === "object" ? (obj as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function serversOf(obj: Record<string, unknown> | undefined): Record<string, RawServer> {
  const s = obj?.mcpServers;
  return s && typeof s === "object" ? (s as Record<string, RawServer>) : {};
}

function expandVars(s: string): string {
  return s.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, v: string) => process.env[v] ?? "");
}

function expandRecord(r: unknown): Record<string, string> | undefined {
  if (!r || typeof r !== "object") return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(r as Record<string, unknown>)) out[k] = expandVars(String(v));
  return out;
}

function toEntry(name: string, raw: RawServer): ServerEntry | undefined {
  const type = typeof raw.type === "string" ? raw.type.toLowerCase() : undefined;
  if (typeof raw.command === "string" && raw.command) {
    return {
      name, kind: "stdio",
      command: expandVars(raw.command),
      args: Array.isArray(raw.args) ? raw.args.map((a) => expandVars(String(a))) : [],
      env: expandRecord(raw.env),
    };
  }
  if (typeof raw.url === "string" && raw.url) {
    const url = expandVars(raw.url);
    const kind: ServerEntry["kind"] =
      type === "sse" ? "sse"
      : type === "http" || type === "streamable-http" || type === "streamablehttp" ? "http"
      : /\/sse\/?$/.test(url) ? "sse" : "http";
    return { name, kind, url, headers: expandRecord(raw.headers) };
  }
  return undefined;
}

/** All configured servers, merged by name; later (project-level) sources override earlier (global) ones. */
export function discoverServers(config: TeamConfig, cwd: string): ServerEntry[] {
  const home = os.homedir();
  const merged: Record<string, RawServer> = {};
  const add = (src: Record<string, RawServer>) => Object.assign(merged, src);

  if (config.import.fromClaudeCode) {
    const claude = readJson(path.join(home, ".claude.json"));
    add(serversOf(claude));
    const projects = (claude?.projects ?? {}) as Record<string, Record<string, unknown>>;
    const noSlash = cwd.replace(/\/+$/, "");
    for (const key of [noSlash, noSlash + "/", cwd]) if (projects[key]) add(serversOf(projects[key]));
    add(serversOf(readJson(path.join(cwd, ".mcp.json"))));
  }
  if (config.import.fromCursor) {
    add(serversOf(readJson(path.join(home, ".cursor", "mcp.json"))));
    add(serversOf(readJson(path.join(cwd, ".cursor", "mcp.json"))));
  }

  const wanted = config.import.servers;
  const all = wanted.includes("*");
  const entries: ServerEntry[] = [];
  for (const [name, raw] of Object.entries(merged)) {
    if (!all && !wanted.includes(name)) continue;
    const e = toEntry(name, raw);
    // Never re-import our own local MCP server (would loop: mesh → mesh.ask_teammate → …).
    if (e && (name === "mesh" || (e.kind !== "stdio" && /^https?:\/\/(localhost|127\.0\.0\.1):\d+\/mcp\/?$/.test(String((e as { url?: string }).url ?? ""))))) {
      debug(`skipping ${name}: that's mesh itself`);
      continue;
    }
    if (e) entries.push(e);
    else debug(`ignoring server ${name}: no command or url`);
  }
  return entries;
}

// ---------- connection ----------

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${what} timed out after ${ms / 1000}s`)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

function makeTransport(e: ServerEntry): Transport {
  if (e.kind === "stdio") {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
    Object.assign(env, e.env ?? {});
    const t = new StdioClientTransport({ command: e.command!, args: e.args ?? [], env, stderr: "pipe" });
    t.stderr?.on("data", (d: Buffer) => debug(`${e.name} stderr:`, d.toString().trimEnd()));
    return t;
  }
  const url = new URL(e.url!);
  const requestInit = e.headers ? { headers: e.headers } : undefined;
  return e.kind === "sse" ? new SSEClientTransport(url, { requestInit }) : new StreamableHTTPClientTransport(url, { requestInit });
}

async function connect(e: ServerEntry): Promise<Client> {
  const client = new Client({ name: "mesh-daemon", version: "0.0.1" });
  const transport = makeTransport(e);
  try {
    await withTimeout(client.connect(transport), CONNECT_TIMEOUT_MS, `connect ${e.name}`);
    if (transport instanceof StdioClientTransport) {
      const untrack = trackMcpPid(transport.pid);
      const onclose = transport.onclose;
      transport.onclose = () => { untrack(); onclose?.(); };
    }
  } catch (err) {
    await transport.close().catch(() => {});
    throw err;
  }
  return client;
}

function failureReason(err: unknown): string {
  if (err instanceof UnauthorizedError) return AUTH_REASON;
  const msg = err instanceof Error ? err.message : String(err);
  if (/\b401\b|unauthorized|oauth/i.test(msg)) return AUTH_REASON;
  const code = (err as { code?: unknown })?.code;
  if (code === "ENOENT") return `command not found (${msg})`;
  return msg;
}

function isTransportFailure(err: unknown): boolean {
  if (err instanceof McpError) return err.code === ErrorCode.ConnectionClosed || err.code === ErrorCode.RequestTimeout;
  return true; // anything that is not a well-formed MCP error is a transport-level problem
}

function permissionFor(name: string, config: TeamConfig): Permission {
  for (const [glob, p] of Object.entries(config.permissions)) if (minimatch(name, glob)) return p;
  return config.import.defaultPermission;
}

function notesFor(name: string, config: TeamConfig): string | undefined {
  for (const [glob, n] of Object.entries(config.notes)) if (minimatch(name, glob)) return n;
  return undefined;
}

// ---------- result flattening ----------

type ContentPart = { type: string; [k: string]: unknown };

export function flattenContent(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const raw of content as ContentPart[]) {
    switch (raw.type) {
      case "text": parts.push(String(raw.text ?? "")); break;
      case "image": parts.push(`[image ${raw.mimeType ?? "unknown"}]`); break;
      case "audio": parts.push("[audio]"); break;
      case "resource": {
        const r = (raw.resource ?? {}) as { uri?: string; text?: string };
        parts.push(typeof r.text === "string" ? r.text : String(r.uri ?? "[resource]"));
        break;
      }
      case "resource_link": parts.push(String(raw.uri ?? "[resource]")); break;
      default: parts.push(`[${raw.type}]`);
    }
  }
  let text = parts.join("\n");
  if (Buffer.byteLength(text) > TEXT_CAP_BYTES) {
    text = Buffer.from(text).subarray(0, TEXT_CAP_BYTES).toString("utf8") + "\n…[truncated at 64 KB]";
  }
  return text;
}

/** Non-text parts, verbatim enough for core to upload them (image data / resource blob). */
export function rawParts(content: unknown): McpContentPart[] {
  if (!Array.isArray(content)) return [];
  const out: McpContentPart[] = [];
  for (const raw of content as ContentPart[]) {
    if (raw.type === "text") continue;
    if (raw.type === "resource") {
      const r = (raw.resource ?? {}) as { uri?: string; mimeType?: string; blob?: string };
      out.push({ type: "resource", uri: r.uri, mimeType: r.mimeType, blob: typeof r.blob === "string" ? r.blob : undefined });
      continue;
    }
    out.push({
      type: raw.type,
      mimeType: typeof raw.mimeType === "string" ? raw.mimeType : undefined,
      data: typeof raw.data === "string" ? raw.data : undefined,
      uri: typeof raw.uri === "string" ? raw.uri : undefined,
    });
  }
  return out;
}

// ---------- McpImport ----------

interface Imported { entry: ServerEntry; client: Client | null; tools: Map<string, object | undefined> }

export function createMcpImport(): McpImport {
  const servers = new Map<string, Imported>();
  const offerToServer = new Map<string, { server: string; tool: string; schema?: object }>();
  let timeoutMs = 120_000;

  async function getClient(name: string): Promise<Client> {
    const s = servers.get(name);
    if (!s) throw new Error(`unknown server ${name}`);
    if (!s.client) s.client = await connect(s.entry);
    return s.client;
  }

  return {
    async start(config, cwd) {
      timeoutMs = config.timeoutSeconds * 1000;
      const offers: Offer[] = [];
      const skipped: Array<{ server: string; reason: string }> = [];
      const entries = discoverServers(config, cwd);
      await Promise.all(entries.map(async (entry) => {
        try {
          const client = await connect(entry);
          const { tools } = await withTimeout(client.listTools(), CONNECT_TIMEOUT_MS, `tools/list ${entry.name}`);
          const imported: Imported = { entry, client, tools: new Map() };
          servers.set(entry.name, imported);
          for (const tool of tools) {
            const name = `${entry.name}.${tool.name}`;
            const schema = tool.inputSchema as Record<string, unknown> | undefined;
            imported.tools.set(tool.name, schema);
            offerToServer.set(name, { server: entry.name, tool: tool.name, schema });
            const offer: Offer = {
              kind: "mcp", name, server: entry.name,
              description: tool.description ?? "",
              permission: permissionFor(name, config),
            };
            if (schema) offer.inputSchema = schema;
            const notes = notesFor(name, config);
            if (notes) offer.notes = notes;
            offers.push(offer);
          }
          debug(`imported ${entry.name}: ${tools.length} tools`);
        } catch (err) {
          const reason = failureReason(err);
          debug(`skipped ${entry.name}: ${reason}`);
          skipped.push({ server: entry.name, reason });
        }
      }));
      offers.sort((a, b) => a.name.localeCompare(b.name));
      return { offers, skipped };
    },

    validateArgs(offerName, args) {
      const target = offerToServer.get(offerName);
      if (!target) return `unknown capability ${offerName}`;
      return validateAgainstSchema(target.schema, args ?? {});
    },

    async callTool(offerName, args) {
      const target = offerToServer.get(offerName);
      if (!target) throw new Error(`unknown capability ${offerName}`);
      const run = async () => {
        const client = await getClient(target.server);
        return client.callTool({ name: target.tool, arguments: args ?? {} }, undefined, { timeout: timeoutMs });
      };
      let result: Awaited<ReturnType<typeof run>>;
      try {
        result = await run();
      } catch (err) {
        if (!isTransportFailure(err)) throw err;
        debug(`callTool ${offerName} failed (${(err as Error).message}); reconnecting once`);
        const s = servers.get(target.server)!;
        await s.client?.close().catch(() => {});
        s.client = null;
        result = await run(); // second failure propagates
      }
      const parts = rawParts(result.content);
      return { text: flattenContent(result.content), isError: !!result.isError, ...(parts.length ? { parts } : {}) };
    },

    async stop() {
      await Promise.all([...servers.values()].map(async (s) => {
        await s.client?.close().catch(() => {});
        s.client = null;
      }));
    },
  };
}
