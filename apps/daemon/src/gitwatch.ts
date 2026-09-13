/**
 * Git watch → universal `file_touched` events.
 *
 * Claude Code hooks (hooks/emit.js) already emit precise file_touched events for Edit/Write/MultiEdit,
 * but every other agent (Codex, Cursor, a human in vim) is invisible. Polling `git status --porcelain`
 * inside the repo gives us a universal, agent-agnostic signal: anything that becomes dirty is a touch.
 *
 * Only turned on when the Claude Code hooks are NOT installed, so we never double-report.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { meshPluginInstalled } from "./register.js";

/** `git rev-parse --show-toplevel` in cwd; undefined when not a repo (or git is missing). */
export function findGitRoot(cwd: string): string | undefined {
  try {
    const r = spawnSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 5000,
    });
    if (r.status !== 0) return undefined;
    const out = (r.stdout ?? "").trim();
    return out || undefined;
  } catch {
    return undefined;
  }
}

function hasEmitHook(settingsFile: string): boolean {
  if (!existsSync(settingsFile)) return false;
  let cfg: Record<string, unknown>;
  try {
    cfg = JSON.parse(readFileSync(settingsFile, "utf8")) as Record<string, unknown>;
  } catch {
    return false;
  }
  const hooks = cfg.hooks as Record<string, unknown> | undefined;
  if (!hooks || typeof hooks !== "object") return false;
  for (const entries of Object.values(hooks)) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      const inner = (entry as { hooks?: unknown } | null)?.hooks;
      if (!Array.isArray(inner)) continue;
      for (const h of inner) {
        const cmd = (h as { command?: unknown } | null)?.command;
        if (typeof cmd === "string" && cmd.includes("emit.js")) return true;
      }
    }
  }
  return false;
}

/**
 * True when Claude Code is already emitting file events for this project — the mesh plugin is installed
 * for this machine, or `<cwd>/.claude/settings.json` (or `<root>/.claude/settings.json`) has a hook whose
 * command contains `emit.js`. When true, the git watch would duplicate those events.
 */
export function claudeHooksInstalled(cwd: string, root?: string): boolean {
  if (meshPluginInstalled()) return true;
  const dirs = root && path.resolve(root) !== path.resolve(cwd) ? [cwd, root] : [cwd];
  return dirs.some((d) => hasEmitHook(path.join(d, ".claude", "settings.json")));
}

/** Undo git's C-style quoting of odd path names (`"a\tb"` → `a<TAB>b`). */
function unquote(p: string): string {
  if (!(p.startsWith('"') && p.endsWith('"') && p.length >= 2)) return p;
  const body = p.slice(1, -1);
  let out = "";
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c !== "\\") { out += c; continue; }
    const n = body[++i];
    if (n === undefined) break;
    if (n === "n") out += "\n";
    else if (n === "t") out += "\t";
    else if (n === "r") out += "\r";
    else if (n >= "0" && n <= "7") {
      const oct = body.slice(i, i + 3);
      out += String.fromCharCode(parseInt(oct, 8));
      i += 2;
    } else out += n;
  }
  return out;
}

/**
 * Parse `git status --porcelain --untracked-files=normal` into path → XY status.
 * Lines are `XY<space>path`; renames/copies are `XY old -> new` (we keep the new path).
 */
export function parsePorcelain(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (line.length < 4) continue;
    const status = line.slice(0, 2);
    let rest = line.slice(3);
    if (/[RC]/.test(status)) {
      const arrow = rest.indexOf(" -> ");
      if (arrow >= 0) rest = rest.slice(arrow + 4);
    }
    const p = unquote(rest.trim());
    if (!p) continue;
    out.set(p, status);
  }
  return out;
}

/** Pure diff: paths present in `next` that are new, or whose status code changed. Removals are ignored. */
export function diffStatus(prev: Map<string, string>, next: Map<string, string>): string[] {
  const changed: string[] = [];
  for (const [p, status] of next) {
    const before = prev.get(p);
    if (before === undefined || before !== status) changed.push(p);
  }
  return changed;
}

/** mesh's own output is not a code change. Directory entries (untracked dirs end in `/`) are skipped too. */
function ignored(p: string): boolean {
  if (p.endsWith("/")) return true;
  if (p === ".mesh" || p.startsWith(".mesh/")) return true;
  if (p.startsWith("mesh-artifacts/")) return true;
  return false;
}

export interface GitWatchOptions {
  cwd: string;
  root: string;
  emit: (path: string) => void;
  intervalMs?: number;
  log?: (line: string) => void;
}

const DEBOUNCE_MS = 60_000;
const MAX_PER_TICK = 20;

/**
 * Poll `git status --porcelain` in `root` every intervalMs and emit one file_touched per newly dirty path.
 * The first snapshot is a baseline (files already dirty at start never emit); each path emits at most once
 * per 60 s; at most 20 paths per tick.
 */
export function startGitWatch(opts: GitWatchOptions): { stop(): void } {
  const intervalMs = opts.intervalMs ?? 5000;
  const log = opts.log ?? (() => undefined);
  let snapshot: Map<string, string> | undefined; // undefined until the baseline tick lands
  const lastEmit = new Map<string, number>();
  let child: ChildProcess | undefined;
  let stopped = false;

  const tick = (): void => {
    if (stopped || child) return; // previous run still going → skip this tick
    let killTimer: NodeJS.Timeout | undefined;
    let out = "";
    let proc: ChildProcess;
    try {
      proc = spawn("git", ["status", "--porcelain", "--untracked-files=normal"], {
        cwd: opts.root,
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      return;
    }
    child = proc;
    killTimer = setTimeout(() => { try { proc.kill("SIGKILL"); } catch { /* gone */ } }, 5000);
    proc.stdout?.on("data", (b: Buffer) => { out += b.toString(); });
    proc.on("error", () => { if (killTimer) clearTimeout(killTimer); child = undefined; });
    proc.on("close", (code) => {
      if (killTimer) clearTimeout(killTimer);
      child = undefined;
      if (stopped || code !== 0) return;
      const next = parsePorcelain(out);
      const prev = snapshot;
      snapshot = next;
      if (prev === undefined) return; // baseline only
      const now = Date.now();
      let sent = 0;
      for (const p of diffStatus(prev, next)) {
        if (sent >= MAX_PER_TICK) break;
        if (ignored(p)) continue;
        const last = lastEmit.get(p);
        if (last !== undefined && now - last < DEBOUNCE_MS) continue;
        lastEmit.set(p, now);
        sent++;
        try { opts.emit(p); } catch (e) { log(`git watch: emit failed for ${p}: ${(e as Error).message}`); }
      }
    });
  };

  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  tick(); // take the baseline immediately

  return {
    stop(): void {
      stopped = true;
      clearInterval(timer);
      if (child) { try { child.kill("SIGKILL"); } catch { /* gone */ } child = undefined; }
    },
  };
}
