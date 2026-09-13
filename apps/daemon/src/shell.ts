/** Shell offer matching (CONTRACT §2) and streaming command execution. */
import { trackChild } from "./children.js";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { parse as shellParse } from "shell-quote";
import { OUTPUT_TAIL_BYTES, type Permission, type ShellOfferConfig, type TeamConfig } from "@mesh/protocol";

export const CHUNK_CHARS = 4096;
const FLUSH_MS = 50;

export type ShellMatch =
  | { kind: "offer"; offer: ShellOfferConfig; permission: Permission; fixed: boolean }
  | { kind: "arbitrary"; permission: Permission };

/** Trim + collapse whitespace: the only normalization applied before comparing a request to a fixed offer. */
export function normalizeCommand(command: string): string {
  return command.trim().replace(/\s+/g, " ");
}

/**
 * A FIXED offer is one whose `command` contains whitespace (`git diff HEAD`, `echo a | tr a b`): it is the owner's
 * own complete command line, not a program. Single-token offers (`git`, `./scripts/x.sh`) are programs and match by basename.
 */
export function isFixedOffer(offer: Pick<ShellOfferConfig, "command">): boolean {
  return /\s/.test(offer.command.trim());
}

/** First token of the command, as the shell would see it (undefined if empty / unparsable). */
export function firstToken(command: string): string | undefined {
  try {
    const parts = shellParse(command, process.env as Record<string, string>);
    const first = parts[0];
    return typeof first === "string" ? first : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Match the command's first token basename against each shell offer's command basename.
 * No match → config.allowArbitrary.
 */
/** True if the command line contains shell control operators (; && || | > < backticks, $( ), newlines): it is more than one command. */
export function isCompound(command: string): boolean {
  if (/[\r\n`]|\$\(/.test(command)) return true;
  try {
    const parts = shellParse(command, process.env as Record<string, string>);
    return parts.some((p) => typeof p === "object" && p !== null && ("op" in p || "comment" in p));
  } catch {
    return true; // unparseable → treat as compound (safest)
  }
}

export function matchShellOffer(command: string, config: TeamConfig): ShellMatch {
  // 1. Fixed offers: the request must equal the offer's line (after whitespace normalization) or the offer's name
  //    (`git.diff`). Nothing else matches — not a prefix, not extra flags — so `git push --force` can never ride on
  //    a `git diff HEAD` offer. The daemon runs the OFFER's line, and it is never compound-escalated: it is the
  //    owner's own command, pipes and all.
  const norm = normalizeCommand(command);
  for (const offer of config.offers) {
    if (!isFixedOffer(offer)) continue;
    if (norm === normalizeCommand(offer.command) || norm === offer.name) {
      return { kind: "offer", offer, permission: offer.permission, fixed: true };
    }
  }
  // 2. Single-token offers: first token's basename vs the offer's basename (a bare `git` offer covers any git command;
  //    the owner chose that).
  const tok = firstToken(command);
  if (tok) {
    const base = path.basename(tok);
    for (const offer of config.offers) {
      if (isFixedOffer(offer)) continue;
      if (path.basename(offer.command) === base) {
        // An offer's `always` covers exactly that program. Anything chained after it (`; rm -rf`, `&& curl … | sh`)
        // is a different command and must be approved like an arbitrary one. `never` stays `never`.
        if (isCompound(command) && offer.permission === "always") {
          return { kind: "offer", offer, permission: config.allowArbitrary === "never" ? "never" : "ask", fixed: false };
        }
        return { kind: "offer", offer, permission: offer.permission, fixed: false };
      }
    }
  }
  return { kind: "arbitrary", permission: config.allowArbitrary };
}

/**
 * When a request matches an offer, run the OWNER's configured command (e.g. ./scripts/figma-export.sh),
 * not whatever spelling the requester used for the first token (e.g. figma-export.sh).
 * Single-token offer: everything after the first token is passed through untouched.
 * Fixed offer (command line with whitespace): the offer's line is run verbatim; the request only selected it.
 */
export function resolveOfferCommand(command: string, offerCommand: string): string {
  if (isFixedOffer({ command: offerCommand })) return offerCommand;
  const m = command.match(/^\s*(\S+)([\s\S]*)$/);
  if (!m) return command;
  const first = m[1]!;
  const rest = m[2] ?? "";
  if (first === offerCommand) return command;
  return `${offerCommand}${rest}`;
}

export interface RunOptions {
  cwd: string;
  timeoutSeconds: number;
}

export interface RunResult {
  exitCode: number | null;
  durationMs: number;
  timedOut: boolean;
  tail: string;
}

export type ChunkHandler = (stream: "stdout" | "stderr", chunk: string) => void;

/**
 * spawn('/bin/sh', ['-c', command]) in cwd, stream stdout/stderr through onChunk
 * (coalesced with a 50 ms flush, each chunk ≤ 4096 chars), SIGKILL on timeout.
 */
/** On Windows, find a POSIX-ish shell so offers written for `sh` still work; fall back to cmd.exe. */
function windowsShell(): { cmd: string; args: string[] } {
  const candidates = [
    process.env.MESH_SHELL,
    "C:\\Program Files\\Git\\bin\\bash.exe",
    "C:\\Program Files\\Git\\usr\\bin\\bash.exe",
    "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
  ].filter((x): x is string => !!x);
  for (const c of candidates) if (existsSync(c)) return { cmd: c, args: ["-c"] };
  return { cmd: process.env.ComSpec ?? "cmd.exe", args: ["/d", "/s", "/c"] };
}

export function runShell(command: string, opts: RunOptions, onChunk: ChunkHandler): Promise<RunResult> {
  return new Promise((resolve) => {
    const started = Date.now();
    let timedOut = false;
    let tail = "";
    const pending: Record<"stdout" | "stderr", string> = { stdout: "", stderr: "" };
    let flushTimer: NodeJS.Timeout | undefined;

    const flush = () => {
      flushTimer = undefined;
      for (const stream of ["stdout", "stderr"] as const) {
        let buf = pending[stream];
        pending[stream] = "";
        while (buf.length > 0) {
          onChunk(stream, buf.slice(0, CHUNK_CHARS));
          buf = buf.slice(CHUNK_CHARS);
        }
      }
    };
    const push = (stream: "stdout" | "stderr", text: string) => {
      pending[stream] += text;
      tail = (tail + text).slice(-OUTPUT_TAIL_BYTES);
      if (pending[stream].length >= CHUNK_CHARS) flush();
      else if (!flushTimer) flushTimer = setTimeout(flush, FLUSH_MS);
    };

    const win = process.platform === "win32";
    // POSIX: /bin/sh in its own process group so a timeout kills grandchildren too.
    // Windows: prefer Git's bash.exe (so offers written for sh work), else cmd.exe via shell:true.
    const child = win
      ? spawn(windowsShell().cmd, [...windowsShell().args, command], { cwd: opts.cwd, env: process.env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true })
      : spawn("/bin/sh", ["-c", command], { cwd: opts.cwd, env: process.env, stdio: ["ignore", "pipe", "pipe"], detached: true });

    trackChild(child, !win);
    const killTree = () => {
      if (win) {
        try { if (child.pid) spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }); } catch { /* ignore */ }
      } else {
        try { if (child.pid) process.kill(-child.pid, "SIGKILL"); } catch { /* already gone */ }
      }
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
    };
    const killTimer = setTimeout(() => {
      timedOut = true;
      killTree();
    }, Math.max(1, opts.timeoutSeconds) * 1000);

    child.stdout.on("data", (d: Buffer) => push("stdout", d.toString("utf8")));
    child.stderr.on("data", (d: Buffer) => push("stderr", d.toString("utf8")));
    child.on("error", (err) => push("stderr", `spawn error: ${err.message}\n`));
    child.on("close", (code) => {
      clearTimeout(killTimer);
      if (flushTimer) clearTimeout(flushTimer);
      flush();
      resolve({ exitCode: timedOut ? null : code, durationMs: Date.now() - started, timedOut, tail });
    });
  });
}
