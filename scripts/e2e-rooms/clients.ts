/**
 * HTTP clients for the rooms end-to-end test (scripts/e2e-rooms.ts).
 * Global fetch only. Daemon MCP endpoint is stateless Streamable HTTP: tools/call works without `initialize`,
 * and the SDK answers with either JSON or a one-shot SSE stream depending on the transport; both are handled.
 */

export interface ToolResult { isError: boolean; text: string; json?: any }
export interface HttpResult { status: number; body: any }

let rpcId = 0;

async function withTimeout<T>(ms: number, what: string, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fn(ctrl.signal);
  } catch (e) {
    if (ctrl.signal.aborted) throw new Error(`${what}: timed out after ${ms} ms`);
    throw new Error(`${what}: ${(e as Error).message}${(e as { cause?: Error }).cause ? ` (${(e as { cause: Error }).cause.message})` : ""}`);
  } finally {
    clearTimeout(timer);
  }
}

function parseBody(text: string): any {
  try { return JSON.parse(text); } catch { return text; }
}

/** Pull the JSON-RPC message out of a JSON or SSE (`data: {...}`) response body. */
function parseRpcResponse(raw: string, contentType: string): any {
  if (contentType.includes("text/event-stream") || /^\s*(event|data|id):/m.test(raw) && !raw.trim().startsWith("{")) {
    const msgs: any[] = [];
    for (const block of raw.split(/\r?\n\r?\n/)) {
      const data = block.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).replace(/^ /, "")).join("\n");
      if (!data) continue;
      try { msgs.push(JSON.parse(data)); } catch { /* ignore non-JSON frames */ }
    }
    return msgs.find((m) => m && ("result" in m || "error" in m)) ?? msgs[msgs.length - 1];
  }
  return JSON.parse(raw);
}

async function rpc(port: number, method: string, params: Record<string, unknown>, timeoutMs: number): Promise<any> {
  const id = ++rpcId;
  const what = `mcp ${method}${params.name ? ` ${String(params.name)}` : ""} @${port}`;
  return withTimeout(timeoutMs, what, async (signal) => {
    const res = await fetch(daemonUrl(port, "/mcp"), {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      signal,
    });
    const raw = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${raw.slice(0, 500)}`);
    let msg: any;
    try { msg = parseRpcResponse(raw, res.headers.get("content-type") ?? ""); }
    catch { throw new Error(`unparseable response: ${raw.slice(0, 500)}`); }
    if (!msg) throw new Error(`empty response: ${raw.slice(0, 500)}`);
    if (msg.error) throw new Error(`JSON-RPC error ${msg.error.code}: ${msg.error.message}`);
    return msg.result;
  });
}

export async function mcpCall(port: number, tool: string, args: Record<string, unknown> = {}, timeoutMs = 70_000): Promise<ToolResult> {
  const result = await rpc(port, "tools/call", { name: tool, arguments: args }, timeoutMs);
  const text = Array.isArray(result?.content)
    ? result.content.filter((c: any) => c?.type === "text").map((c: any) => String(c.text)).join("\n")
    : "";
  const out: ToolResult = { isError: result?.isError === true, text };
  try { out.json = JSON.parse(text); } catch { /* not JSON */ }
  return out;
}

export async function mcpListTools(port: number): Promise<string[]> {
  const result = await rpc(port, "tools/list", {}, 10_000);
  return (result?.tools ?? []).map((t: { name: string }) => t.name);
}

export async function httpGet(url: string, timeoutMs = 10_000, headers: Record<string, string> = {}): Promise<HttpResult> {
  return withTimeout(timeoutMs, `GET ${url}`, async (signal) => {
    const res = await fetch(url, { headers, signal });
    return { status: res.status, body: parseBody(await res.text()) };
  });
}

export async function httpPost(url: string, body?: unknown, timeoutMs = 10_000): Promise<HttpResult> {
  return withTimeout(timeoutMs, `POST ${url}`, async (signal) => {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body ?? {}),
      signal,
    });
    return { status: res.status, body: parseBody(await res.text()) };
  });
}

export const daemonUrl = (port: number, path: string): string => `http://127.0.0.1:${port}${path}`;

export async function daemonHealth(port: number): Promise<{ user: string; room: string; relay: string; members: number; approvals?: string } | undefined> {
  try {
    const r = await httpGet(daemonUrl(port, "/health"), 3_000);
    if (r.status !== 200 || typeof r.body !== "object" || r.body === null) return undefined;
    return r.body;
  } catch {
    return undefined;
  }
}

export function httpBase(relayUrl: string): string {
  const u = new URL(relayUrl.trim().replace(/^ws(s?):\/\//i, "http$1://"));
  return u.origin;
}

export async function createRoom(base: string): Promise<{ room: string; key: string; link: string }> {
  const r = await httpPost(`${base}/api/rooms`);
  if (r.status < 200 || r.status >= 300 || typeof r.body !== "object" || !r.body?.room) {
    throw new Error(`createRoom ${base}: HTTP ${r.status} ${typeof r.body === "string" ? r.body.slice(0, 300) : JSON.stringify(r.body)}`);
  }
  return { room: r.body.room, key: r.body.key, link: r.body.link };
}

export async function getRoom(base: string, room: string, key?: string): Promise<HttpResult> {
  const q = key ? `?key=${encodeURIComponent(key)}` : "";
  return httpGet(`${base}/api/rooms/${encodeURIComponent(room)}${q}`);
}

export async function roomMembers(base: string, room: string, key: string): Promise<string[] | undefined> {
  const r = await getRoom(base, room, key);
  if (r.status !== 200 || !Array.isArray(r.body?.members)) return undefined;
  // GET /api/rooms/:room currently omits `role` (it already drops feed conns and reports them as `watchers`),
  // so members without a role count as daemons.
  return r.body.members
    .filter((m: { role?: string }) => m.role === undefined || m.role === "daemon")
    .map((m: { user: string }) => m.user);
}

export function linkWithKey(link: string, key: string | null): string {
  const bare = link.replace(/#.*$/, "");
  return key === null ? bare : `${bare}#k=${key}`;
}
