/**
 * Awareness: GET /touched + the Claude Code pre_edit hook (CONTRACT §4/§5). No TTY, no network beyond loopback.
 *   pnpm -F daemon exec tsx test/touched.test.ts
 */
import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TeamConfig } from "@mesh/protocol";
import { createCore } from "../src/core.js";
import { createLocalServer } from "../src/local-server.js";
import { createMcpImport } from "../src/mcp-import.js";
import { RelayClient } from "../src/relay-client.js";
import { startFakeRelay } from "./fake-relay.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const emitJs = path.resolve(here, "../../../hooks/emit.js");
let failures = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  console.log(`${ok ? "  ok  " : "  FAIL"} ${name}${ok || detail === undefined ? "" : `  → ${JSON.stringify(detail)}`}`);
  if (!ok) failures++;
}
const freePort = () => new Promise<number>((res, rej) => {
  const s = net.createServer();
  s.listen(0, "127.0.0.1", () => { const p = (s.address() as net.AddressInfo).port; s.close(() => res(p)); });
  s.on("error", rej);
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Run `node hooks/emit.js pre_edit --daemon <base>` with a hook payload on stdin. */
function runHook(base: string, payload: unknown): Promise<{ code: number | null; stdout: string; ms: number }> {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [emitJs, "pre_edit", "--daemon", base], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString("utf8")));
    child.on("close", (code) => resolve({ code, stdout, ms: Date.now() - started }));
    child.stdin.end(JSON.stringify(payload));
  });
}

async function main(): Promise<void> {
  const relay = await startFakeRelay(0);
  const relayUrl = `ws://127.0.0.1:${relay.port}`;
  const room = `touched-${Date.now()}`;
  const configA = TeamConfig.parse({ user: "a", room, relay: relayUrl });
  const configB = TeamConfig.parse({ user: "b", room, relay: relayUrl });
  const clientA = new RelayClient({ relay: relayUrl, room, user: "a", offers: [] });
  const clientB = new RelayClient({ relay: relayUrl, room, user: "b", offers: [] });
  const a = createCore({ config: configA, cwd: process.cwd(), client: clientA, mcpImport: createMcpImport(), shellOffers: [], mcpOffers: [], quiet: true });
  const b = createCore({ config: configB, cwd: process.cwd(), client: clientB, mcpImport: createMcpImport(), shellOffers: [], mcpOffers: [], quiet: true });
  await Promise.all([clientA.connect(), clientB.connect()]);
  const port = await freePort();
  const server = createLocalServer();
  await server.start(a, port);
  const base = `http://127.0.0.1:${port}`;

  // b's agent edited src/billing.ts (hook-style relative path); a edited src/own.ts (must never warn a about itself)
  b.postEvent("file_touched", "src/billing.ts", { tool: "Edit" });
  a.postEvent("file_touched", "src/own.ts", { tool: "Edit" });
  await sleep(150);

  const t1 = await (await fetch(`${base}/touched?path=src/billing.ts&minutes=10`)).json() as { touched: Array<{ user: string; ts: string }> };
  check("/touched lists b for src/billing.ts", t1.touched.length === 1 && t1.touched[0]!.user === "b" && !!Date.parse(t1.touched[0]!.ts), t1);
  const t2 = await (await fetch(`${base}/touched?path=src/own.ts`)).json() as { touched: unknown[] };
  check("/touched excludes my own events", t2.touched.length === 0, t2);
  const t3 = await (await fetch(`${base}/touched?path=src/other.ts`)).json() as { touched: unknown[] };
  check("/touched empty for an untouched path", t3.touched.length === 0, t3);
  const t4 = await (await fetch(`${base}/touched?path=apps/web/src/billing.ts`)).json() as { touched: unknown[] };
  check("/touched matches when one path is a suffix of the other (different roots)", t4.touched.length === 1, t4);
  const t5 = await fetch(`${base}/touched`);
  check("/touched without path → 400", t5.status === 400);

  // the hook: Edit on the touched file → one warning line, exit 0
  const h1 = await runHook(base, { tool_name: "Edit", tool_input: { file_path: "/tmp/proj/src/billing.ts" }, cwd: "/tmp/proj" });
  check("pre_edit exits 0", h1.code === 0, h1);
  let parsed: { hookSpecificOutput?: { hookEventName?: string; additionalContext?: string }; systemMessage?: string } = {};
  try { parsed = JSON.parse(h1.stdout); } catch { /* not json */ }
  check("pre_edit prints PreToolUse JSON with additionalContext", parsed.hookSpecificOutput?.hookEventName === "PreToolUse" && !!parsed.hookSpecificOutput?.additionalContext, h1.stdout);
  check("warning names the teammate, the file, and how to coordinate", /^mesh: b edited src\/billing\.ts (just now|\d+ min ago) — coordinate before changing it \(send_message b\)$/m.test(parsed.hookSpecificOutput?.additionalContext ?? ""), parsed);
  check("systemMessage mirrors the warning", parsed.systemMessage === parsed.hookSpecificOutput?.additionalContext, parsed);
  check("no permissionDecision (never blocks)", !("permissionDecision" in (parsed.hookSpecificOutput ?? {})), parsed);

  const h2 = await runHook(base, { tool_name: "Write", tool_input: { file_path: "/tmp/proj/src/other.ts" }, cwd: "/tmp/proj" });
  check("pre_edit on an untouched file prints nothing, exit 0", h2.code === 0 && h2.stdout === "", h2);

  const h3 = await runHook(`http://127.0.0.1:${await freePort()}`, { tool_name: "Edit", tool_input: { file_path: "/tmp/proj/src/billing.ts" }, cwd: "/tmp/proj" });
  check("pre_edit with no daemon: silent, exit 0, fast", h3.code === 0 && h3.stdout === "" && h3.ms < 3000, h3);

  await server.stop();
  clientA.close();
  clientB.close();
  await relay.close();
  console.log(failures === 0 ? "\nPASS" : `\nFAIL (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error("FAIL", e); process.exit(1); });
