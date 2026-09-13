import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { InboxMessage } from "@mesh/protocol";
import { CodexWake, codexEvent, codexWakePrompt } from "../src/codex-wake.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-codex-wake-"));
const statePath = path.join(tmp, "seen.json");
const now = Date.parse("2026-09-13T01:00:00.000Z");
const message = (id: string, ts = new Date(now).toISOString()): InboxMessage => ({
  id, ts, from: "dev", to: "tarush", text: "Please check the Figma frame", read: false,
});
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  assert.deepEqual(codexEvent('{"type":"thread.started","thread_id":"thr_123"}'), { threadId: "thr_123" });
  assert.deepEqual(codexEvent('{"type":"item.completed","item":{"type":"agent_message","text":"Done"}}'), { summary: "Done" });
  assert.deepEqual(codexEvent("not json"), {});
  assert.match(codexWakePrompt(message("m1"), "tarush", "demo"), /same local mesh MCP tools/);
  assert.match(codexWakePrompt(message("m1"), "tarush", "demo"), /Never approve a request/);

  const prompts: string[] = [];
  const notifications: Array<{ title: string; body: string }> = [];
  let releaseFirst: (() => void) | undefined;
  const firstFinished = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const wake = new CodexWake({
    cwd: tmp, room: "demo", me: "tarush", statePath, now: () => now,
    run: async (prompt) => {
      prompts.push(prompt);
      if (prompts.length === 1) await firstFinished;
      return { ok: true, summary: `handled ${prompts.length}`, threadId: `thr_${prompts.length}` };
    },
    notify: (title, body) => notifications.push({ title, body }),
  });
  assert.equal(wake.enqueue(message("m1")), true);
  assert.equal(wake.enqueue(message("m1")), false, "same message is not run twice");
  assert.equal(wake.enqueue(message("m2")), true);
  assert.equal(wake.enqueue(message("old", new Date(now - 6 * 60_000).toISOString())), false, "old relay replay is ignored");
  await sleep(10);
  assert.equal(prompts.length, 1, "runs are serial");
  releaseFirst!();
  for (let i = 0; i < 100 && notifications.length < 2; i++) await sleep(10);
  assert.equal(prompts.length, 2);
  assert.equal(notifications.length, 2);
  assert.match(notifications[0]!.body, /handled 1/);
  assert.match(prompts[0]!, /From: dev/);
  assert.match(prompts[0]!, /Please check the Figma frame/);

  const afterRestart = new CodexWake({ cwd: tmp, room: "demo", me: "tarush", statePath, now: () => now,
    run: async () => { throw new Error("should not rerun"); }, notify: () => undefined });
  assert.equal(afterRestart.enqueue(message("m1")), false, "dedupe survives daemon restart");
  assert.equal(afterRestart.enqueue(message("m2")), false);
  const tempRoot = path.resolve(os.tmpdir()) + path.sep;
  assert.ok(path.resolve(tmp).startsWith(tempRoot), "cleanup stays inside the test temp directory");
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log("codex-wake: PASS");
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
