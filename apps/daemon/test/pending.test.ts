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
import { PendingApprovals, approvalsFile, loadApprovalsMode, saveApprovalsMode, selectApprovalPath, watchLine } from "../src/pending.js";
import { APPROVE_REQUEST_TOOLS, meshPluginInstalled, registerApproveAskRule, removeLegacyClaudeHooks } from "../src/register.js";
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
  check("overlay mode, overlay attached → watcher", selectApprovalPath({ ...base, mode: "overlay", overlayAttached: true }) === "watcher");
  check("overlay mode, only the agent attached → dialog", selectApprovalPath({ ...base, mode: "overlay", watcherAttached: true, agentAttached: true }) === "dialog");
  check("agent mode, agent attached → watcher", selectApprovalPath({ ...base, mode: "agent", watcherAttached: true, agentAttached: true }) === "watcher");
  check("agent mode, only the overlay attached → dialog", selectApprovalPath({ ...base, mode: "agent", watcherAttached: true, overlayAttached: true }) === "dialog");
  check("agent mode, nobody, no dialog → tty", selectApprovalPath({ ...base, mode: "agent", dialogAvailable: false }) === "tty");
}

async function testModesUnit(): Promise<void> {
  console.log("PendingApprovals modes");
  let now = 5_000_000;
  const q = new PendingApprovals(() => now);
  check("not chosen initially", !q.chosen && q.mode === "auto");
  await q.poll(0, "overlay");
  check("overlay poll marks the overlay, not the agent", q.overlayAttached() && !q.agentAttached() && q.watcherAttached());
  q.setMode("agent");
  check("setMode marks the choice", q.chosen && q.mode === "agent");
  check("agent mode: an overlay poll is not an answerer", !q.answererAttached());
  await q.poll(0, "agent");
  check("agent mode: agent poll is an answerer", q.answererAttached());
  const parked = q.ask({ id: "m1", from: "x", why: "y", command: "z" }, 10_000);
  check("agent mode: agent sees the request", q.visibleTo("agent").length === 1);
  check("agent mode: overlay sees nothing", q.visibleTo("overlay").length === 0 && (await q.poll(0, "overlay")).length === 0);
  check("agent mode: agent is notified of messages", q.agentNotified());
  q.setMode("overlay");
  check("overlay mode: agent sees nothing, overlay sees it", q.visibleTo("agent").length === 0 && q.visibleTo("overlay").length === 1);
  check("overlay mode: agent gets no message lines", !q.agentNotified());
  now += 61_000;
  await q.poll(0, "agent");
  check("overlay mode: an agent poll alone is not an answerer", !q.answererAttached());
  q.setMode("dialog");
  check("dialog mode: nobody sees parked requests", q.visibleTo("agent").length === 0 && q.visibleTo("overlay").length === 0);
  check("dialog mode: nobody is an answerer", !q.answererAttached());
  check("switching to dialog releases parked requests to the fallback at once", (await parked) === undefined && q.list().length === 0);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-approvals-"));
  try {
    const file = approvalsFile(tmp);
    check("approvalsFile lives under <home>/.mesh", file === path.join(tmp, ".mesh", "approvals.json"));
    check("no file → undefined", loadApprovalsMode(file) === undefined);
    saveApprovalsMode(file, "agent");
    check("save → load round-trips", loadApprovalsMode(file) === "agent");
    fs.writeFileSync(file, JSON.stringify({ mode: "bogus" }));
    check("invalid saved mode → undefined", loadApprovalsMode(file) === undefined);
    fs.writeFileSync(file, "not json");
    check("garbage file → undefined", loadApprovalsMode(file) === undefined);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
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

async function testModesEndToEnd(): Promise<void> {
  console.log("daemon: approvals modes over HTTP (agent / overlay routing, message suppression, persistence)");
  process.env.MESH_APPROVE = "tty"; // fallbacks are an instant "no tty" deny, never a dialog
  const relay = await startFakeRelay(0);
  const relayUrl = `ws://127.0.0.1:${relay.port}`;
  const room = `modes-${Date.now()}`;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-modes-"));
  const file = approvalsFile(tmp);
  const configA = TeamConfig.parse({
    user: "a", room, relay: relayUrl, timeoutSeconds: 5, allowArbitrary: "never",
    offers: [{ name: "date", command: "date", description: "the time", permission: "ask" }],
  });
  const configB = TeamConfig.parse({ user: "b", room, relay: relayUrl });
  const clientA = new RelayClient({ relay: relayUrl, room, user: "a", offers: shellOffers(configA) });
  const clientB = new RelayClient({ relay: relayUrl, room, user: "b", offers: [] });
  const a = createCore({ config: configA, cwd: process.cwd(), client: clientA, mcpImport: createMcpImport(), shellOffers: shellOffers(configA), mcpOffers: [], quiet: true, approvalsFile: file });
  const b = createCore({ config: configB, cwd: process.cwd(), client: clientB, mcpImport: createMcpImport(), shellOffers: [], mcpOffers: [], quiet: true });
  const server = createLocalServer();
  const port = await freePort();
  await server.start(a, port);
  await Promise.all([clientA.connect(), clientB.connect()]);
  for (let i = 0; i < 50 && !b.members().some((m) => m.user === "a"); i++) await sleep(20);
  const base = `http://localhost:${port}`;
  type Poll = { pending: Array<{ id: string }>; messages?: Array<{ text: string }> };
  const get = (p: string) => fetch(base + p).then((r) => r.json() as Promise<Poll>);
  const setMode = (mode: string) => fetch(`${base}/approvals`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode }) });
  const decide = (id: string) => fetch(`${base}/decide`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id, decision: "approved" }) });

  try {
    const g0 = await (await fetch(`${base}/approvals`)).json() as { mode: string; modes: string[] };
    check("GET /approvals: MESH_APPROVE shows through until the owner chooses", g0.mode === "tty", g0);
    check("GET /approvals lists auto, overlay, agent, dialog (no tty)", JSON.stringify(g0.modes) === JSON.stringify(["auto", "overlay", "agent", "dialog"]), g0);
    check("POST bogus → 400", (await setMode("bogus")).status === 400);
    const s1 = await (await setMode("agent")).json() as { ok: boolean; mode: string };
    check("POST agent → { ok, mode }", s1.ok === true && s1.mode === "agent", s1);
    check("mode saved to the approvals file", loadApprovalsMode(file) === "agent");
    check("/health reports the mode", (await (await fetch(`${base}/health`)).json() as { approvals: string }).approvals === "agent");

    // agent mode, only the overlay polling: the overlay does not count as a watcher → straight to the fallback
    const ov1 = get("/pending?wait=5&messages=1&consumer=overlay");
    await sleep(50);
    const r1 = await b.ask({ who: "a", command: "date", why: "overlay only", waitSeconds: 10 });
    check("agent mode + only an overlay → fallback (no parking)", r1.status === "denied" && /no tty/.test(r1.reason ?? ""), r1);

    // agent mode, both polling: the agent poll gets the request, the overlay gets []
    const ag2 = get("/pending?wait=5&messages=1");
    await sleep(50);
    const r2p = b.ask({ who: "a", command: "date", why: "agent mode", waitSeconds: 10 });
    const seen2 = await ag2;
    check("agent mode: agent watcher sees the request", seen2.pending.length === 1, seen2);
    check("agent mode: overlay poll returns pending: []", (await ov1).pending.length === 0 && (await get("/pending?consumer=overlay")).pending.length === 0);
    check("agent mode: plain /pending (agent consumer) still sees it", (await get("/pending")).pending.length === 1);
    await decide(seen2.pending[0]!.id);
    check("agent mode: /decide completes the job", (await r2p).status === "completed");

    // overlay mode: the overlay parks and answers; the agent watcher sees no requests and no message lines
    await setMode("overlay");
    const ov3 = get("/pending?wait=5&messages=1&consumer=overlay&since=9999");
    await sleep(50);
    const r3p = b.ask({ who: "a", command: "date", why: "overlay mode", waitSeconds: 10 });
    const seen3 = await ov3;
    check("overlay mode: overlay sees the request", seen3.pending.length === 1, seen3);
    check("overlay mode: agent /pending sees nothing", (await get("/pending")).pending.length === 0);
    await decide(seen3.pending[0]!.id);
    check("overlay mode: /decide completes the job", (await r3p).status === "completed");

    b.sendMessage("a", "hello from b");
    for (let i = 0; i < 50 && !a.inbox({ unreadOnly: false, sinceMinutes: 5 }).some((m) => m.text === "hello from b"); i++) await sleep(20);
    const ag4 = await get("/pending?wait=1&messages=1");
    check("overlay mode: agent watcher gets no message lines", (ag4.messages ?? []).length === 0, ag4);
    check("overlay mode: the message stays unread for the inbox tool", a.inbox({ unreadOnly: false, sinceMinutes: 5 }).some((m) => m.text === "hello from b" && !m.read));
    check("overlay mode: the overlay still gets the message", ((await get("/pending?messages=1&consumer=overlay")).messages ?? []).some((m) => m.text === "hello from b"));
    await setMode("auto");
    check("auto mode: the agent watcher gets the message again", ((await get("/pending?messages=1")).messages ?? []).some((m) => m.text === "hello from b"));

    const s5 = await (await setMode("tty")).json() as { ok: boolean; mode: string };
    check("POST tty still accepted (back-compat)", s5.ok === true && s5.mode === "tty", s5);

    // persistence: a restarted daemon (new core, same file) comes back in the saved mode, even over MESH_APPROVE
    await setMode("agent");
    process.env.MESH_APPROVE = "dialog";
    const clientC = new RelayClient({ relay: relayUrl, room, user: "c", offers: [] });
    const c = createCore({ config: TeamConfig.parse({ user: "c", room, relay: relayUrl }), cwd: process.cwd(), client: clientC, mcpImport: createMcpImport(), shellOffers: [], mcpOffers: [], quiet: true, approvalsFile: file });
    check("restart restores the saved mode over MESH_APPROVE", c.approvalsMode() === "agent", c.approvalsMode());
    const d = createCore({ config: TeamConfig.parse({ user: "d", room, relay: relayUrl }), cwd: process.cwd(), client: new RelayClient({ relay: relayUrl, room, user: "d", offers: [] }), mcpImport: createMcpImport(), shellOffers: [], mcpOffers: [], quiet: true });
    check("no saved choice → MESH_APPROVE", d.approvalsMode() === "dialog", d.approvalsMode());
    process.env.MESH_APPROVE = "bogus";
    check("no saved choice, invalid MESH_APPROVE → auto", d.approvalsMode() === "auto", d.approvalsMode());
  } finally {
    process.env.MESH_APPROVE = "tty";
    clientA.close();
    clientB.close();
    await server.stop();
    await relay.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
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

function testLegacyCleanup(): void {
  console.log("legacy Claude Code hooks + plugin scope");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-legacy-"));
  const prevConfigDir = process.env.CLAUDE_CONFIG_DIR;
  try {
    const settings = path.join(tmp, "proj", ".claude", "settings.json");
    fs.mkdirSync(path.dirname(settings), { recursive: true });
    const emit = (kind: string) => ({ type: "command", command: `node "/home/x/.mesh/emit.js" ${kind}`, timeout: 5 });
    fs.writeFileSync(settings, JSON.stringify({
      permissions: { ask: [...APPROVE_REQUEST_TOOLS] },
      hooks: {
        UserPromptSubmit: [{ hooks: [emit("prompt")] }],
        PostToolUse: [{ matcher: "Edit|Write|MultiEdit", hooks: [emit("file_touched"), { type: "command", command: "prettier --write" }] }, { matcher: "mcp__.*", hooks: [emit("tool_call")] }],
        Stop: [{ hooks: [emit("status")] }],
      },
      enabledPlugins: { "mesh@mesh": true },
    }));
    const n = removeLegacyClaudeHooks(path.join(tmp, "proj"));
    const cfg = JSON.parse(fs.readFileSync(settings, "utf8"));
    check("removes every emit.js hook", n === 4, n);
    check("keeps non-mesh hooks, permissions, enabledPlugins", cfg.hooks?.PostToolUse?.length === 1 && cfg.hooks.PostToolUse[0].hooks[0].command === "prettier --write" && !cfg.hooks.UserPromptSubmit && !cfg.hooks.Stop && cfg.permissions.ask.length === 2 && cfg.enabledPlugins["mesh@mesh"] === true, cfg);
    check("idempotent", removeLegacyClaudeHooks(path.join(tmp, "proj")) === 0);
    check("no settings file → 0", removeLegacyClaudeHooks(path.join(tmp, "nope")) === 0);

    process.env.CLAUDE_CONFIG_DIR = path.join(tmp, "claude");
    fs.mkdirSync(path.join(tmp, "claude", "plugins"), { recursive: true });
    const record = (entries: unknown[]) => fs.writeFileSync(path.join(tmp, "claude", "plugins", "installed_plugins.json"), JSON.stringify({ version: 2, plugins: { "mesh@mesh": entries } }));
    record([{ scope: "project", projectPath: path.join(tmp, "proj") }]);
    check("project install counts for its project", meshPluginInstalled(path.join(tmp, "proj")));
    check("project install does not count for another project", !meshPluginInstalled(path.join(tmp, "other")));
    check("no cwd → any install counts", meshPluginInstalled());
    record([{ scope: "user" }]);
    check("user install counts everywhere", meshPluginInstalled(path.join(tmp, "other")));
  } finally {
    if (prevConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = prevConfigDir;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

const timer = setTimeout(() => { console.log("FAIL: test timed out"); process.exit(1); }, 60_000);
try {
  testSelectApprovalPath();
  await testQueue();
  await testEndToEnd();
  await testModesUnit();
  await testModesEndToEnd();
  testAskRule();
  testLegacyCleanup();
} catch (e) {
  failures++;
  console.log("  FAIL uncaught:", e);
}
clearTimeout(timer);
console.log(failures === 0 ? "\nPASS" : `\nFAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
