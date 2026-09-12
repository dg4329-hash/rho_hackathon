/**
 * In-tool approval path: pending queue + /pending + /decide + fallback. No TTY, no dialogs, no network.
 *   pnpm -F daemon exec tsx test/pending.test.ts      (also part of `pnpm -F daemon test`)
 */
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { TeamConfig, type Offer } from "@mesh/protocol";
import { createCore } from "../src/core.js";
import { createLocalServer } from "../src/local-server.js";
import { createMcpImport } from "../src/mcp-import.js";
import { PendingApprovals, selectApprovalPath, watchLine } from "../src/pending.js";
import { APPROVE_REQUEST_TOOLS, registerApproveAskRule } from "../src/register.js";
import { RelayClient } from "../src/relay-client.js";
import { resolvePermission } from "../src/permissions.js";
import { startFakeRelay } from "./fake-relay.js";

// Never open a native dialog from a test; with no tty this makes the fallback an instant deny.
process.env.MESH_APPROVE = "tty";

let failures = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  console.log(`${ok ? "  ok  " : "  FAIL"} ${name}${ok || detail === undefined ? "" : `  → ${JSON.stringify(detail)}`}`);
  if (!ok) failures++;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise<number>((res, rej) => {
  const s = net.createServer();
  s.listen(0, () => { const p = (s.address() as net.AddressInfo).port; s.close(() => res(p)); });
  s.on("error", rej);
});

function testSelectApprovalPath(): void {
  console.log("selectApprovalPath");
  const base = { watcherAttached: false, dialogAvailable: true, tty: true };
  check("auto, no watcher, dialog → dialog", selectApprovalPath(base) === "dialog");
  check("auto, watcher → watcher", selectApprovalPath({ ...base, watcherAttached: true }) === "watcher");
  check("auto, no watcher, no dialog → tty", selectApprovalPath({ ...base, dialogAvailable: false }) === "tty");
  check("MESH_APPROVE=tty beats watcher", selectApprovalPath({ ...base, watcherAttached: true, mode: "tty" }) === "tty");
  check("MESH_APPROVE=dialog beats watcher", selectApprovalPath({ ...base, watcherAttached: true, mode: "dialog" }) === "dialog");
  check("MESH_APPROVE=dialog without a dialog → tty", selectApprovalPath({ ...base, mode: "dialog", dialogAvailable: false }) === "tty");
  check("MESH_APPROVE=watcher forces the queue", selectApprovalPath({ ...base, mode: "watcher" }) === "watcher");
  check("unknown mode = auto", selectApprovalPath({ ...base, mode: "bogus", watcherAttached: true }) === "watcher");
}

async function testQueue(): Promise<void> {
  console.log("PendingApprovals");
  let now = 1_000_000;
  const q = new PendingApprovals(() => now);
  check("no watcher initially", !q.watcherAttached());
  const first = q.poll(50);
  check("poll marks the watcher attached", q.watcherAttached());
  check("empty poll returns [] after wait", (await first).length === 0);
  now += 59_000;
  check("watcher still attached at 59 s", q.watcherAttached());
  now += 2_000;
  check("watcher gone at 61 s", !q.watcherAttached());

  const waiting = q.poll(5_000);
  const answer = q.ask({ id: "r1", from: "tarush", why: "need it", command: "date" }, 10_000);
  const list = await waiting;
  check("ask wakes the long-poll with the request", list.length === 1 && list[0]!.id === "r1" && list[0]!.command === "date", list);
  check("expiresAt = createdAt + timeout", Date.parse(list[0]!.expiresAt) - Date.parse(list[0]!.createdAt) === 10_000);
  check("decide unknown id → false", q.decide("nope", "approved") === false);
  check("decide → true", q.decide("r1", "denied", "not now") === true);
  const a = await answer;
  check("ask resolves with the decision", a?.approved === false && a?.reason === "not now", a);
  check("decide twice → false", q.decide("r1", "approved") === false);

  const t = q.ask({ id: "r2", from: "x", why: "y", command: "z" }, 30);
  check("timeout → undefined (caller falls back)", (await t) === undefined);
  check("queue empty after timeout", q.list().length === 0);

  const line = watchLine({ id: "abc", from: "tarush", why: "need the frame", command: 'figma-export.sh "Onboarding/Step 2"\nrm -rf /', createdAt: "", expiresAt: "" });
  check("watchLine is one line and names the tool + id", !line.includes("\n") && line.includes('approve_request({"id":"abc","decision":"approved"}') && line.startsWith("mesh: tarush wants to run"), line);
}

function shellOffers(config: TeamConfig): Offer[] {
  return config.offers.map((o) => ({ kind: "command", name: o.name, description: o.description, permission: resolvePermission(o.name, config, o.permission) }));
}

async function testEndToEnd(): Promise<void> {
  console.log("daemon: watcher poll + POST /decide, and the no-watcher fallback");
  const relay = await startFakeRelay(0);
  const relayUrl = `ws://127.0.0.1:${relay.port}`;
  const room = `pending-${Date.now()}`;
  const configA = TeamConfig.parse({
    user: "a", room, relay: relayUrl, timeoutSeconds: 5, allowArbitrary: "never",
    offers: [{ name: "date", command: "date", description: "the time", permission: "ask" }],
  });
  const configB = TeamConfig.parse({ user: "b", room, relay: relayUrl });
  const clientA = new RelayClient({ relay: relayUrl, room, user: "a", offers: shellOffers(configA) });
  const clientB = new RelayClient({ relay: relayUrl, room, user: "b", offers: [] });
  const a = createCore({ config: configA, cwd: process.cwd(), client: clientA, mcpImport: createMcpImport(), shellOffers: shellOffers(configA), mcpOffers: [], quiet: true });
  const b = createCore({ config: configB, cwd: process.cwd(), client: clientB, mcpImport: createMcpImport(), shellOffers: [], mcpOffers: [], quiet: true });
  const server = createLocalServer();
  const port = await freePort();
  await server.start(a, port);
  await Promise.all([clientA.connect(), clientB.connect()]);
  for (let i = 0; i < 50 && !b.members().some((m) => m.user === "a"); i++) await sleep(20);
  const base = `http://localhost:${port}`;

  // 1. No watcher: MESH_APPROVE=tty with no tty → immediate deny, nothing parked.
  process.env.MESH_APPROVE = "tty";
  const r1 = await b.ask({ who: "a", command: "date", why: "no watcher", waitSeconds: 10 });
  check("no watcher → falls back (tty, none) → denied", r1.status === "denied" && /no tty/.test(r1.reason ?? ""), r1);

  // 2. Watcher attached (a GET /pending long-poll is in flight): the request parks, the poll returns it, POST /decide completes the job.
  delete process.env.MESH_APPROVE;
  const poll = fetch(`${base}/pending?wait=10`).then((r) => r.json() as Promise<{ pending: Array<{ id: string; from: string; command?: string }> }>);
  await sleep(50);
  const r2p = b.ask({ who: "a", command: "date", why: "with watcher", waitSeconds: 10 });
  const seen = await poll;
  check("long-poll wakes with the parked request", seen.pending.length === 1 && seen.pending[0]!.from === "b" && seen.pending[0]!.command === "date", seen);
  const dec = await fetch(`${base}/decide`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: seen.pending[0]!.id, decision: "approved" }) });
  check("POST /decide → 200", dec.status === 200, await dec.text());
  const r2 = await r2p;
  check("job completed after /decide", r2.status === "completed" && r2.exitCode === 0 && (r2.output ?? "").trim().length > 0, r2);
  check("queue drained", (await (await fetch(`${base}/pending`)).json()).pending.length === 0);

  // 3. Watcher attached, decision 'denied' with a reason reaches the requester.
  const poll3 = fetch(`${base}/pending?wait=10`).then((r) => r.json() as Promise<{ pending: Array<{ id: string }> }>);
  await sleep(50);
  const r3p = b.ask({ who: "a", command: "date", why: "deny me", waitSeconds: 10 });
  const seen3 = await poll3;
  await fetch(`${base}/decide`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: seen3.pending[0]!.id, decision: "denied", reason: "busy" }) });
  const r3 = await r3p;
  check("denied via /decide → requester sees the reason", r3.status === "denied" && r3.reason === "busy", r3);

  // 4. Nothing pending: /decide on a stale id → 404.
  const stale = await fetch(`${base}/decide`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: seen3.pending[0]!.id, decision: "approved" }) });
  check("stale /decide → 404", stale.status === 404);

  process.env.MESH_APPROVE = "tty";
  clientA.close();
  clientB.close();
  await server.stop();
  await relay.close();
}

function testAskRule(): void {
  console.log("registerApproveAskRule");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-askrule-"));
  try {
    fs.mkdirSync(path.join(tmp, ".claude"));
    fs.writeFileSync(path.join(tmp, ".claude", "settings.json"), JSON.stringify({ permissions: { allow: ["Bash(ls *)"], ask: ["Bash(git push *)"] }, hooks: {} }));
    const r1 = registerApproveAskRule(tmp);
    const cfg = JSON.parse(fs.readFileSync(path.join(tmp, ".claude", "settings.json"), "utf8"));
    check("registered", r1.status === "registered", r1);
    check("both tool names in permissions.ask, existing entries kept", APPROVE_REQUEST_TOOLS.every((t) => cfg.permissions.ask.includes(t)) && cfg.permissions.ask.includes("Bash(git push *)") && cfg.permissions.allow[0] === "Bash(ls *)", cfg.permissions);
    check("idempotent", registerApproveAskRule(tmp).status === "already");
    const fresh = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-askrule-"));
    check("creates .claude/settings.json when absent", registerApproveAskRule(fresh).status === "registered" && fs.existsSync(path.join(fresh, ".claude", "settings.json")));
    fs.rmSync(fresh, { recursive: true, force: true });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

const timer = setTimeout(() => { console.log("FAIL: test timed out"); process.exit(1); }, 60_000);
try {
  testSelectApprovalPath();
  await testQueue();
  await testEndToEnd();
  testAskRule();
} catch (e) {
  failures++;
  console.log("  FAIL uncaught:", e);
}
clearTimeout(timer);
console.log(failures === 0 ? "\nPASS" : `\nFAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
