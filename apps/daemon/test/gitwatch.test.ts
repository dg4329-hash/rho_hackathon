/**
 * Git watch tests: pure porcelain parsing/diffing + a live temp repo integration run.
 *   pnpm -F daemon exec tsx test/gitwatch.test.ts
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { diffStatus, findGitRoot, parsePorcelain, startGitWatch } from "../src/gitwatch.js";

let failures = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  console.log(`${ok ? "  ok  " : "  FAIL"} ${name}${ok || detail === undefined ? "" : `  → ${JSON.stringify(detail)}`}`);
  if (!ok) failures++;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function testParsePorcelain(): void {
  const text = [
    " M src/a.ts",
    "A  src/added.ts",
    "?? notes.txt",
    "R  old/name.ts -> new/name.ts",
    '?? "odd name\\twith tab.txt"',
    "?? untracked-dir/",
    "MM both.ts",
    "",
  ].join("\n");
  const m = parsePorcelain(text);
  check("parses modified", m.get("src/a.ts") === " M", [...m]);
  check("parses added", m.get("src/added.ts") === "A ", m.get("src/added.ts"));
  check("parses untracked ??", m.get("notes.txt") === "??", m.get("notes.txt"));
  check("rename keeps the new path", m.get("new/name.ts") === "R " && !m.has("old/name.ts"), [...m.keys()]);
  check("quoted path unquoted", m.get("odd name\twith tab.txt") === "??", [...m.keys()]);
  check("untracked dir kept as a dir entry (skipped at emit)", m.get("untracked-dir/") === "??", m.get("untracked-dir/"));
  check("parses staged+unstaged MM", m.get("both.ts") === "MM", m.get("both.ts"));
  check("blank lines ignored", m.size === 7, m.size);
}

function testDiffStatus(): void {
  const prev = new Map([["a.ts", " M"], ["keep.ts", "??"], ["gone.ts", " M"]]);
  const next = new Map([["a.ts", "MM"], ["keep.ts", "??"], ["new.ts", "??"]]);
  const out = diffStatus(prev, next).sort();
  check("returns a new path", out.includes("new.ts"), out);
  check("returns a changed status", out.includes("a.ts"), out);
  check("does not return an unchanged path", !out.includes("keep.ts"), out);
  check("does not return a removed path", !out.includes("gone.ts"), out);
  check("only those two", out.length === 2, out);
  check("empty prev → everything in next", diffStatus(new Map(), next).length === 3);
}

function git(cwd: string, ...args: string[]): void {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${(r.stderr || r.stdout || "").trim()}`);
}

async function testIntegration(): Promise<void> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-gitwatch-"));
  const repo = fs.realpathSync(tmp);
  let watch: { stop(): void } | undefined;
  try {
    git(repo, "init", "-q");
    git(repo, "config", "user.email", "t@example.com");
    git(repo, "config", "user.name", "Test");
    fs.writeFileSync(path.join(repo, "tracked.txt"), "one\n");
    git(repo, "add", "tracked.txt");
    git(repo, "commit", "-q", "-m", "init");

    check("findGitRoot finds the temp repo", findGitRoot(repo) === repo, { found: findGitRoot(repo), repo });
    check("findGitRoot outside a repo → undefined", findGitRoot(os.tmpdir()) === undefined || findGitRoot(os.tmpdir()) !== repo);

    const emitted: string[] = [];
    watch = startGitWatch({ cwd: repo, root: repo, emit: (p) => emitted.push(p), intervalMs: 200 });

    // let the baseline tick land; nothing is dirty yet
    await sleep(500);
    check("baseline emits nothing on a clean repo", emitted.length === 0, emitted);

    fs.writeFileSync(path.join(repo, "fresh.txt"), "new file\n");
    fs.appendFileSync(path.join(repo, "tracked.txt"), "two\n");
    await sleep(700);
    check("emits the new untracked file", emitted.filter((p) => p === "fresh.txt").length === 1, emitted);
    check("emits the modified tracked file", emitted.filter((p) => p === "tracked.txt").length === 1, emitted);
    check("nothing else emitted yet", emitted.length === 2, emitted);

    fs.mkdirSync(path.join(repo, "mesh-artifacts"), { recursive: true });
    fs.writeFileSync(path.join(repo, "mesh-artifacts", "x.txt"), "artifact\n");
    fs.mkdirSync(path.join(repo, ".mesh"), { recursive: true });
    fs.writeFileSync(path.join(repo, ".mesh", "y"), "state\n");
    await sleep(700);
    check("never emits mesh-artifacts/", !emitted.some((p) => p.startsWith("mesh-artifacts")), emitted);
    check("never emits .mesh", !emitted.some((p) => p === ".mesh" || p.startsWith(".mesh")), emitted);
    check("no directory entries emitted", !emitted.some((p) => p.endsWith("/")), emitted);

    const before = emitted.length;
    fs.appendFileSync(path.join(repo, "tracked.txt"), "three\n");
    await sleep(700);
    check("60 s debounce suppresses a second emit for the same path", emitted.length === before, emitted);

    watch.stop();
    watch = undefined;
    const afterStop = emitted.length;
    fs.writeFileSync(path.join(repo, "after-stop.txt"), "x\n");
    await sleep(600);
    check("stop() halts the watch", emitted.length === afterStop, emitted);
  } finally {
    watch?.stop();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

const timer = setTimeout(() => { console.log("FAIL: test timed out"); process.exit(1); }, 60_000);
try {
  testParsePorcelain();
  testDiffStatus();
  await testIntegration();
} catch (e) {
  failures++;
  console.log("  FAIL uncaught:", e);
}
clearTimeout(timer);
console.log(failures === 0 ? "\nPASS" : `\nFAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
