/**
 * Step 2 acceptance test, fully automated (no TTY): fake relay + two in-process cores.
 *   pnpm -F daemon test
 */
import { TeamConfig, type Offer } from "@mesh/protocol";
import { createCore } from "../src/core.js";
import { createMcpImport } from "../src/mcp-import.js";
import { RelayClient } from "../src/relay-client.js";
import { resolvePermission } from "../src/permissions.js";
import { isFixedOffer } from "../src/shell.js";
import { startFakeRelay } from "./fake-relay.js";

let failures = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  console.log(`${ok ? "  ok  " : "  FAIL"} ${name}${ok || detail === undefined ? "" : `  → ${JSON.stringify(detail)}`}`);
  if (!ok) failures++;
}

function shellOffers(config: TeamConfig): Offer[] {
  return config.offers.map((o) => ({
    kind: "command",
    name: o.name,
    description: o.description,
    permission: resolvePermission(o.name, config, o.permission),
    ...(isFixedOffer(o) ? { fixed: true } : {}),
  }));
}

async function main(): Promise<void> {
  const relay = await startFakeRelay(0);
  const relayUrl = `ws://127.0.0.1:${relay.port}`;
  const room = `test-${Date.now()}`;

  const configA = TeamConfig.parse({
    user: "a",
    room,
    relay: relayUrl,
    timeoutSeconds: 5,
    allowArbitrary: "never",
    offers: [
      { name: "echo", command: "echo", description: "echo", permission: "always" },
      { name: "rm", command: "rm", description: "rm", permission: "never" },
      { name: "sleep", command: "sleep", description: "sleep", permission: "always" },
      { name: "hello.script", command: "./test/fixtures/hello.sh", description: "Usage: hello.sh <name>", permission: "always" },
      { name: "fail.script", command: "./test/fixtures/fail.sh", description: "exits 3 with stderr", permission: "always" },
      { name: "slow.script", command: "./test/fixtures/slow-tree.sh", description: "spawns a grandchild sleep", permission: "always" },
      // fixed command lines (whitespace in `command`): matched by exact line or by name, never a prefix
      { name: "git.diff", command: "git diff HEAD", description: "diff against HEAD", permission: "always" },
      { name: "fixed.pipe", command: "echo a | tr a b", description: "pipe inside a fixed line", permission: "always" },
    ],
  });
  const configB = TeamConfig.parse({ user: "b", room, relay: relayUrl });

  const clientA = new RelayClient({ relay: relayUrl, room, user: "a", offers: shellOffers(configA) });
  const clientB = new RelayClient({ relay: relayUrl, room, user: "b", offers: [] });
  const a = createCore({ config: configA, cwd: process.cwd(), client: clientA, mcpImport: createMcpImport(), shellOffers: shellOffers(configA), mcpOffers: [], quiet: true });
  const b = createCore({ config: configB, cwd: process.cwd(), client: clientB, mcpImport: createMcpImport(), shellOffers: [], mcpOffers: [], quiet: true });

  await Promise.all([clientA.connect(), clientB.connect()]);
  // wait for b to see a in presence
  for (let i = 0; i < 50 && !b.members().some((m) => m.user === "a"); i++) await new Promise((r) => setTimeout(r, 20));

  check("b sees a in members()", b.members().some((m) => m.user === "a"), b.members());
  check("b sees a's echo offer", b.findOffer("a", "echo")?.permission === "always", b.findOffer("a", "echo"));
  check("relay status connected", a.relayStatus() === "connected" && b.relayStatus() === "connected");

  // 1. always-permission shell offer runs and streams output
  const r1 = await b.ask({ who: "a", command: "echo hi", why: "test", waitSeconds: 10 });
  check("echo hi → completed", r1.status === "completed", r1);
  check("echo hi → exitCode 0", r1.exitCode === 0, r1);
  check("echo hi → output contains 'hi'", (r1.output ?? "").includes("hi"), r1);

  // 2. never-permission offer is denied without running
  const r2 = await b.ask({ who: "a", command: "rm -rf x", why: "test", waitSeconds: 10 });
  check("rm -rf x → denied", r2.status === "denied", r2);
  check("rm -rf x → reason mentions not offered", /not offered/.test(r2.reason ?? ""), r2);

  // 3. arbitrary command with allowArbitrary=never is denied
  const r3 = await b.ask({ who: "a", command: "ls /", why: "test", waitSeconds: 10 });
  check("ls / (arbitrary, never) → denied", r3.status === "denied", r3);

  // 4. non-zero exit and stderr propagate
  const r4 = await b.ask({ who: "a", command: "fail.sh", why: "test", waitSeconds: 10 });
  check("exit 3 → completed with exitCode 3", r4.status === "completed" && r4.exitCode === 3, r4);
  check("stderr captured", (r4.output ?? "").includes("oops"), r4);

  // 5. request to someone offline stays running past the wait, then check_job still says running
  const r5 = await b.ask({ who: "nobody", command: "echo x", why: "test", waitSeconds: 1 });
  check("ask offline user → running after wait", r5.status === "running", r5);
  const r5b = await b.checkJob(r5.jobId, 0);
  check("check_job on pending job → running", r5b.status === "running", r5b);

  // 6. events + activity
  b.postEvent("note", "hello from b");
  await new Promise((r) => setTimeout(r, 100));
  const act = a.activity(5);
  check("a.activity(5) has entries", act.length > 0, act.length);
  check("activity includes the request line", act.some((e) => e.type === "request" && e.summary.includes("b → a: echo hi")), act.map((e) => e.summary));
  check("activity includes b's note", act.some((e) => e.type === "note" && e.summary === "hello from b"));
  check("activity ≤ 100 and newest last", act.length <= 100 && act[act.length - 1]!.type === "note");
  const actB = b.activity(5);
  check("b.activity has decision + result from a", actB.some((e) => e.type === "decision") && actB.some((e) => e.type === "result"), actB.map((e) => e.summary));

  // 7. security: a third party in the room forges decision/result for a job b owns (addressed to 'nobody')
  const mallory = new RelayClient({ relay: relayUrl, room, user: "mallory", offers: [] });
  await mallory.connect();
  mallory.send({ type: "decision", id: r5.jobId, decision: "approved" });
  mallory.send({ type: "result", id: r5.jobId, exitCode: 0, durationMs: 1, timedOut: false, tail: "pwned" });
  await new Promise((r) => setTimeout(r, 150));
  const r7 = await b.checkJob(r5.jobId, 0);
  check("forged frames from a non-addressee are ignored", r7.status === "running" && !(r7.output ?? "").includes("pwned"), r7);
  mallory.close();

  // 8. timeout kills the whole process group (no orphaned grandchildren)
  const r8 = await b.ask({ who: "a", command: "slow-tree.sh", why: "test", waitSeconds: 10 });
  check("timed-out job → completed with exitCode null", r8.status === "completed" && r8.exitCode === null, r8);

  // 8a. security: chaining after an `always` offer must not inherit `always`
  const r8a = await b.ask({ who: "a", command: "echo hi; echo pwned", why: "test", waitSeconds: 5 });
  check("compound command after always-offer is NOT auto-approved", r8a.status === "denied", r8a);
  const r8a2 = await b.ask({ who: "a", command: "echo hi && echo pwned", why: "test", waitSeconds: 5 });
  check("&& chain after always-offer is NOT auto-approved", r8a2.status === "denied", r8a2);
  const r8a3 = await b.ask({ who: "a", command: "echo $(id)", why: "test", waitSeconds: 5 });
  check("command substitution after always-offer is NOT auto-approved", r8a3.status === "denied", r8a3);

  // 8b. offer command substitution: requester says `hello.sh bob`, owner runs ./test/fixtures/hello.sh bob
  const r8b = await b.ask({ who: "a", command: "hello.sh bob", why: "test", waitSeconds: 10 });
  check("offer basename → owner's real script path", r8b.status === "completed" && r8b.exitCode === 0 && (r8b.output ?? "").includes("hello bob"), r8b);

  // 8c. fixed offers (CONTRACT §2): `command` with whitespace is the owner's exact line
  check("b sees git.diff as a fixed offer", b.findOffer("a", "git.diff")?.fixed === true, b.findOffer("a", "git.diff"));
  const r8c = await b.ask({ who: "a", command: "git.diff", why: "test", waitSeconds: 10 });
  check("fixed offer asked by name → runs (always)", r8c.status === "completed" && r8c.exitCode === 0, r8c);
  const r8c2 = await b.ask({ who: "a", command: "  git   diff HEAD ", why: "test", waitSeconds: 10 });
  check("fixed offer asked by exact line (whitespace-normalized) → runs", r8c2.status === "completed" && r8c2.exitCode === 0, r8c2);
  const r8c3 = await b.ask({ who: "a", command: "git push --force", why: "test", waitSeconds: 5 });
  check("other git command with only a fixed git offer → arbitrary (denied)", r8c3.status === "denied" && /arbitrary/.test(r8c3.reason ?? ""), r8c3);
  const r8c4 = await b.ask({ who: "a", command: "git diff HEAD --stat", why: "test", waitSeconds: 5 });
  check("prefix of a fixed line + extra flag → arbitrary (denied)", r8c4.status === "denied" && /arbitrary/.test(r8c4.reason ?? ""), r8c4);
  // the fixed line itself may contain a pipe: it is the owner's own line, so no compound escalation, by name or by line
  const r8c5 = await b.ask({ who: "a", command: "fixed.pipe", why: "test", waitSeconds: 10 });
  check("fixed line with a pipe, by name → runs the owner's line", r8c5.status === "completed" && (r8c5.output ?? "").trim() === "b", r8c5);
  const r8c6 = await b.ask({ who: "a", command: "echo a | tr a b", why: "test", waitSeconds: 10 });
  check("fixed line with a pipe, by exact line → runs (not escalated via the single-token echo offer)", r8c6.status === "completed" && (r8c6.output ?? "").trim() === "b", r8c6);

  // 9. messages: b → a (direct) and b → all; a's inbox sees both, marks read; b's own inbox is empty
  b.sendMessage("a", "fix idea: guard the null case in auth.ts");
  b.sendMessage("all", "heads up: I'm editing billing.ts");
  await new Promise((r) => setTimeout(r, 150));
  const in1 = a.inbox({ unreadOnly: true, sinceMinutes: 5 });
  check("a.inbox has 2 unread from b", in1.length === 2 && in1.every((m) => m.from === "b"), in1);
  check("a.inbox second call is empty (marked read)", a.inbox({ unreadOnly: true, sinceMinutes: 5 }).length === 0);
  check("b.inbox does not contain b's own messages", b.inbox({ unreadOnly: false, sinceMinutes: 5 }).length === 0);
  check("activity shows the message", a.activity(5).some((e) => e.type === "message"));

  clientA.close();
  clientB.close();
  await relay.close();

  console.log(failures === 0 ? "\nPASS" : `\nFAIL (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("FAIL", e);
  process.exit(1);
});
