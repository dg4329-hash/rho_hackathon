/**
 * Automated test for the MCP half of the daemon. No TTY, no network.
 *   pnpm -F daemon exec tsx test/mcp.test.ts
 */
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { TeamConfig, type JobResult, type Offer } from "@mesh/protocol";
import type { DaemonCore, Member } from "../src/api.js";
import { createLocalServer } from "../src/local-server.js";
import { createMcpImport } from "../src/mcp-import.js";

const here = path.dirname(fileURLToPath(import.meta.url));
let failures = 0;
function check(cond: unknown, label: string, extra?: unknown) {
  if (cond) console.log(`  ok   ${label}`);
  else { failures++; console.log(`  FAIL ${label}${extra !== undefined ? ` :: ${JSON.stringify(extra)}` : ""}`); }
}
const freePort = () => new Promise<number>((res, rej) => {
  const s = net.createServer();
  s.listen(0, () => { const p = (s.address() as net.AddressInfo).port; s.close(() => res(p)); });
  s.on("error", rej);
});
const textOf = (r: { content: unknown }) =>
  (r.content as Array<{ type: string; text?: string }>).filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n");

// ---------- (a) local-server against a fake core ----------

async function testLocalServer() {
  console.log("local-server");
  const offer: Offer = {
    kind: "mcp", name: "supabase.run_sql", server: "supabase", permission: "ask",
    description: "Run a SQL query against the project database. " + "x".repeat(200),
    inputSchema: { type: "object", properties: { query: { type: "string" }, limit: { type: "integer", default: 100 } }, required: ["query"] },
    notes: "read-only please",
  };
  const shell: Offer = { kind: "command", name: "figma.export", permission: "ask", description: "Export a frame. Usage: figma-export.sh <fileKey> <nodeId>" };
  const members: Member[] = [
    { user: "tarush", role: "daemon", offers: [offer, shell] },
    { user: "abhi-feed", role: "feed", offers: [] },
  ];
  const asks: unknown[] = [];
  const core: DaemonCore = {
    me: "dev",
    config: TeamConfig.parse({ user: "dev", room: "rho", relay: "wss://relay.example" }),
    members: () => members,
    findOffer: (who, name) => members.find((m) => m.user === who)?.offers.find((o) => o.name === name),
    async ask(input) {
      asks.push(input);
      const r: JobResult = { jobId: "job-1", status: "completed", exitCode: 0, output: "rows: 3", durationMs: 12 };
      return r;
    },
    async checkJob(jobId) { return { jobId, status: "completed", exitCode: 0, output: "rows: 3", durationMs: 12 }; },
    postEvent() {},
    activity: () => [
      { ts: "2026-09-12T10:00:00Z", from: "tarush", type: "event", summary: "prompt: fix login" },
      { ts: "2026-09-12T10:01:00Z", from: "dev", type: "request", summary: "asked tarush: echo hi" },
    ],
    relayStatus: () => "connected",
    approvalsMode: () => "auto",
    setApprovalsMode: (m: string) => m,
    async pendingApprovals() { return []; },
    async watchPoll() { return { pending: [], messages: [] }; },
    decide: (id) => id === "req-1",
    cwd: os.tmpdir(),
    async sendFile(_to, filePath) {
      return { id: "art-1", name: path.basename(filePath), mime: "text/plain", size: 3, url: "https://relay.example/api/files/rho/art-1" };
    },
    async fetchArtifact() { throw new Error("no artifact with id 'x'"); },
    isOwner: () => false,
    async endSession() { throw new Error("endSession must not be called without an owner token"); },
  } as DaemonCore;

  const port = await freePort();
  const server = createLocalServer();
  await server.start(core, port);
  const client = new Client({ name: "test-client", version: "0" });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://localhost:${port}/mcp`)));

    const { tools } = await client.listTools();
    check(tools.length === 15, "listTools returns 15 tools", tools.map((t) => t.name));
    check(tools.some((t) => t.name === "end_session"), "end_session registered");
    check(tools.some((t) => t.name === "send_file") && tools.some((t) => t.name === "fetch_artifact"), "send_file + fetch_artifact registered");
    check(tools.every((t) => (t.description ?? "").length > 0), "every tool has a description");
    const approve = tools.find((t) => t.name === "approve_request");
    check((approve?._meta as Record<string, unknown> | undefined)?.["anthropic/requiresUserInteraction"] === true, "approve_request carries anthropic/requiresUserInteraction", approve?._meta);
    const ap = JSON.parse(textOf(await client.callTool({ name: "approve_request", arguments: { id: "req-1", decision: "approved" } })));
    check(ap.ok === true && ap.decision === "approved", "approve_request resolves a pending id", ap);
    const apMiss = await client.callTool({ name: "approve_request", arguments: { id: "nope", decision: "denied" } });
    check(apMiss.isError === true && textOf(apMiss).includes("no pending request"), "approve_request unknown id → isError", textOf(apMiss));
    const dec = await fetch(`http://localhost:${port}/decide`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: "nope", decision: "approved" }) });
    check(dec.status === 404, "POST /decide unknown id → 404");
    const pend = await (await fetch(`http://localhost:${port}/pending`)).json();
    check(Array.isArray(pend.pending), "GET /pending returns a list", pend);

    const lt = await client.callTool({ name: "list_teammates", arguments: {} });
    const ltObj = JSON.parse(textOf(lt));
    check(ltObj.me === "dev" && ltObj.members.length === 1 && ltObj.members[0].user === "tarush", "list_teammates excludes feed, includes tarush", ltObj);
    check(ltObj.members[0].offers[0].summary.length <= 120 && !("inputSchema" in ltObj.members[0].offers[0]), "summary ≤120 chars, no schema");

    const dc = await client.callTool({ name: "describe_capability", arguments: { who: "tarush", name: "supabase.run_sql" } });
    const dcObj = JSON.parse(textOf(dc));
    check(dcObj.usage.includes("supabase.run_sql") && dcObj.usage.includes('"query"'), "describe_capability usage contains tool + example args", dcObj.usage);
    check(dcObj.notes === "read-only please" && dcObj.inputSchema.required[0] === "query", "describe_capability returns notes + schema");
    const dcCmd = JSON.parse(textOf(await client.callTool({ name: "describe_capability", arguments: { who: "tarush", name: "figma.export" } })));
    check(dcCmd.usage.includes("figma-export.sh <fileKey> <nodeId>"), "describe_capability command usage from Usage: line", dcCmd.usage);
    const dcMissing = await client.callTool({ name: "describe_capability", arguments: { who: "tarush", name: "nope" } });
    check(dcMissing.isError === true && textOf(dcMissing).includes("supabase.run_sql"), "describe_capability unknown → isError listing offers", textOf(dcMissing));

    const bad = await client.callTool({ name: "ask_teammate", arguments: { who: "tarush", tool: "supabase.run_sql", args: { limit: 5 }, why: "test" } });
    check(bad.isError === true && textOf(bad).includes("query"), "ask_teammate bad args → isError mentioning 'query'", textOf(bad));
    check(asks.length === 0, "bad args never reached core.ask");

    const good = await client.callTool({ name: "ask_teammate", arguments: { who: "tarush", tool: "supabase.run_sql", args: { query: "select 1" }, why: "test" } });
    const goodObj = JSON.parse(textOf(good));
    check(!good.isError && goodObj.status === "completed" && goodObj.output === "rows: 3", "ask_teammate good args → completed", goodObj);
    check((asks[0] as { waitSeconds: number }).waitSeconds === 45, "waitSeconds defaults to 45");

    const both = await client.callTool({ name: "ask_teammate", arguments: { who: "tarush", tool: "x", command: "ls", why: "t" } });
    check(both.isError === true, "ask_teammate with both tool and command → isError");

    const cj = JSON.parse(textOf(await client.callTool({ name: "check_job", arguments: { jobId: "job-1" } })));
    check(cj.status === "completed", "check_job returns job");
    const pe = JSON.parse(textOf(await client.callTool({ name: "post_event", arguments: { kind: "note", summary: "hi" } })));
    check(pe.ok === true, "post_event ok");
    const ta = JSON.parse(textOf(await client.callTool({ name: "team_activity", arguments: {} })));
    check(ta.events.length === 2, "team_activity returns 2 entries", ta);

    const sf = JSON.parse(textOf(await client.callTool({ name: "send_file", arguments: { to: "tarush", path: "a.txt" } })));
    check(sf.ok === true && sf.artifact.name === "a.txt", "send_file returns the artifact", sf);
    const sfOff = await client.callTool({ name: "send_file", arguments: { to: "ghost", path: "a.txt" } });
    check(sfOff.isError === true && textOf(sfOff).includes("not online"), "send_file to offline teammate → isError");
    const fa = await client.callTool({ name: "fetch_artifact", arguments: { id: "x" } });
    check(fa.isError === true && textOf(fa).includes("no artifact"), "fetch_artifact core error → isError", textOf(fa));

    const health = await (await fetch(`http://localhost:${port}/health`)).json();
    check(health.user === "dev" && health.room === "rho" && health.relay === "connected" && health.members === 2 && health.owner === false, "/health (owner: false)", health);
    const es = await client.callTool({ name: "end_session", arguments: {} });
    check(es.isError === true && textOf(es).includes("only the person who started this session"), "end_session without owner token → isError", textOf(es));
    const endRes = await fetch(`http://localhost:${port}/end`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    check(endRes.status === 403, "POST /end without owner token → 403", endRes.status);
    const ev = await (await fetch(`http://localhost:${port}/event`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "status", summary: "idle" }) })).json();
    check(ev.ok === true, "POST /event ok");
    const act = await (await fetch(`http://localhost:${port}/activity?sinceMinutes=5`)).json();
    check(act.events.length === 2, "GET /activity");
  } finally {
    await client.close().catch(() => {});
    await server.stop();
  }
}

// ---------- (b) mcp-import against the stdio fixture server ----------

async function testMcpImport() {
  console.log("mcp-import");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-mcp-test-"));
  const tsxBin = path.resolve(here, "../../../node_modules/.bin/tsx");
  const fixture = path.join(here, "fixture-server.ts");
  const stdio = fs.existsSync(tsxBin)
    ? { command: tsxBin, args: [fixture] }
    : { command: "npx", args: ["tsx", fixture] };
  fs.writeFileSync(path.join(tmp, ".mcp.json"), JSON.stringify({
    mcpServers: {
      fixture: { ...stdio, env: { FIXTURE_FLAG: "${HOME}" } },
      bogus: { command: "/nonexistent/mesh-bogus-binary", args: [] },
      ignored: { command: "/also/nonexistent" },
    },
  }));
  const config = TeamConfig.parse({
    user: "dev", room: "rho", relay: "wss://relay.example", timeoutSeconds: 20,
    import: { fromClaudeCode: true, fromCursor: false, servers: ["fixture", "bogus"], defaultPermission: "ask" },
    permissions: { "fixture.add": "always" },
    notes: { "fixture.*": "numbers only" },
  });

  // Point HOME at the temp dir so the real ~/.claude.json is not read (no side effects on this machine).
  const realHome = process.env.HOME;
  process.env.HOME = tmp;
  const imp = createMcpImport();
  try {
    const { offers, skipped } = await imp.start(config, tmp);
    process.env.HOME = realHome;
    const add = offers.find((o) => o.name === "fixture.add");
    check(!!add && add.kind === "mcp" && add.server === "fixture", "offers include fixture.add", offers.map((o) => o.name));
    check(!!add?.inputSchema && Array.isArray((add.inputSchema as { required?: string[] }).required), "fixture.add has inputSchema", add?.inputSchema);
    check(add?.permission === "always" && add?.notes === "numbers only", "permission + notes resolved by glob", add);
    check(offers.some((o) => o.name === "fixture.fail" && o.permission === "ask"), "fixture.fail defaults to 'ask'");
    check(!offers.some((o) => o.name.startsWith("ignored.")), "servers filter excludes 'ignored'");
    check(skipped.length === 1 && skipped[0].server === "bogus", "bogus server lands in skipped", skipped);

    check(imp.validateArgs("fixture.add", { a: "x", b: 1 }) !== null, "validateArgs rejects {a:'x'}", imp.validateArgs("fixture.add", { a: "x", b: 1 }));
    check(imp.validateArgs("fixture.add", { a: 2, b: 3 }) === null, "validateArgs accepts {a:2,b:3}");
    check(imp.validateArgs("nope.tool", {}) === "unknown capability nope.tool", "validateArgs unknown offer");

    const sum = await imp.callTool("fixture.add", { a: 2, b: 3 });
    check(sum.text.includes("5") && !sum.isError, "callTool add → 5", sum);
    const bad = await imp.callTool("fixture.fail", {});
    check(bad.isError === true && bad.text.includes("boom"), "callTool fail → isError", bad);
  } finally {
    process.env.HOME = realHome;
    await imp.stop();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

const timer = setTimeout(() => { console.log("FAIL: test timed out"); process.exit(1); }, 60_000);
try {
  await testLocalServer();
  await testMcpImport();
} catch (e) {
  failures++;
  console.log("  FAIL uncaught:", e);
}
clearTimeout(timer);
console.log(failures === 0 ? "\nPASS" : `\nFAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
