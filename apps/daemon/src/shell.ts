/** Shell offer matching (CONTRACT §2) and streaming command execution. */
import { spawn } from "node:child_process";
import path from "node:path";
import { parse as shellParse } from "shell-quote";
import { OUTPUT_TAIL_BYTES, type Permission, type ShellOfferConfig, type TeamConfig } from "@mesh/protocol";

export const CHUNK_CHARS = 4096;
const FLUSH_MS = 50;

export type ShellMatch =
  | { kind: "offer"; offer: ShellOfferConfig; permission: Permission }
  | { kind: "arbitrary"; permission: Permission };

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
export function matchShellOffer(command: string, config: TeamConfig): ShellMatch {
  const tok = firstToken(command);
  if (tok) {
    const base = path.basename(tok);
    for (const offer of config.offers) {
      if (path.basename(offer.command) === base) return { kind: "offer", offer, permission: offer.permission };
    }
  }
  return { kind: "arbitrary", permission: config.allowArbitrary };
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

    const child = spawn("/bin/sh", ["-c", command], {
      cwd: opts.cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true, // own process group, so a timeout kills grandchildren too
    });

    const killTree = () => {
      try { if (child.pid) process.kill(-child.pid, "SIGKILL"); } catch { /* already gone */ }
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
