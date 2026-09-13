/**
 * Serialized terminal approval prompt. One prompt at a time; a single keypress decides.
 * Without a TTY every prompt is auto-denied with reason "no tty".
 */
import chalk from "chalk";
import { nativeApprove, nativeDialogAvailable } from "./native.js";
import { selectApprovalPath, type PendingApprovals } from "./pending.js";

export interface ApprovalRequest {
  /** Request id (the relay frame id); doubles as the key in the pending queue. */
  id: string;
  from: string;
  why: string;
  command?: string;
  tool?: string;
  args?: Record<string, unknown>;
}

export interface ApprovalAnswer {
  approved: boolean;
  reason?: string;
}

const MAX_ARG_LINES = 20;
const CTRL_C = "\u0003";

export function prettyArgs(args: Record<string, unknown> | undefined): string {
  if (!args || Object.keys(args).length === 0) return "{}";
  const lines = JSON.stringify(args, null, 2).split("\n");
  if (lines.length <= MAX_ARG_LINES) return lines.join("\n");
  return [...lines.slice(0, MAX_ARG_LINES), `   … (${lines.length - MAX_ARG_LINES} more lines)`].join("\n");
}

function hasTty(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

let rawDepth = 0;
function enterRaw(): void {
  if (rawDepth++ === 0 && process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.resume();
}
function leaveRaw(): void {
  if (--rawDepth <= 0) {
    rawDepth = 0;
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdin.pause();
  }
}

/** Make sure the terminal is sane if we die mid-prompt. */
export function restoreTerminal(): void {
  rawDepth = 0;
  try {
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
  } catch {
    /* ignore */
  }
}
process.once("exit", restoreTerminal);

function readKey(): Promise<string> {
  return new Promise((resolve) => {
    enterRaw();
    const onData = (buf: Buffer) => {
      process.stdin.off("data", onData);
      leaveRaw();
      resolve(buf.toString("utf8"));
    };
    process.stdin.on("data", onData);
  });
}

/** Strip ANSI/control characters and cap length so a request can't disguise itself on the owner's terminal. */
function safeText(text: string, max: number): string {
  // eslint-disable-next-line no-control-regex
  const stripped = text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/[\x00-\x1f\x7f]/g, (c) => (c === "\n" ? "⏎" : c === "\t" ? "  " : ""));
  return stripped.length > max ? stripped.slice(0, max - 1) + "…" : stripped;
}

let queue: Promise<unknown> = Promise.resolve();

/**
 * Ask the owner. Path (see pending.ts selectApprovalPath): a `mesh watch` watcher inside the
 * owner's coding agent → native OS dialog → terminal y/n. Dialog/tty prompts are serialized so two
 * never overlap; the watcher path is not (many requests can wait in the queue at once).
 */
export function askApproval(req: ApprovalRequest, pending?: PendingApprovals): Promise<ApprovalAnswer> {
  // Precedence: the owner's choice (overlay / POST /approvals / approvals.json) > MESH_APPROVE > auto.
  const path = selectApprovalPath({
    watcherAttached: pending?.watcherAttached() ?? false,
    overlayAttached: pending?.overlayAttached() ?? false,
    agentAttached: pending?.agentAttached() ?? false,
    mode: pending?.chosen ? pending.mode : process.env.MESH_APPROVE,
    dialogAvailable: nativeDialogAvailable(),
    tty: hasTty(),
  });
  if (path === "watcher" && pending) return viaWatcher(req, pending);
  return viaLocalPrompt(req, path === "tty");
}

async function viaWatcher(req: ApprovalRequest, pending: PendingApprovals): Promise<ApprovalAnswer> {
  process.stdout.write(`\n${chalk.yellow("⚡")} ${chalk.magenta(safeText(req.from, 32))} ${chalk.bold(req.command ? "wants to run:" : "wants to call")} ${chalk.cyan(safeText(req.command ?? req.tool ?? "?", 200))}  ${chalk.dim("(waiting for your coding agent)")}\n`);
  const answer = await pending.ask({ id: req.id, from: req.from, why: req.why, command: req.command, tool: req.tool, args: req.args });
  if (answer) {
    process.stdout.write((answer.approved ? chalk.green("  approved") : chalk.red(`  denied${answer.reason ? ` (${safeText(answer.reason, 120)})` : ""}`)) + " " + chalk.dim("via agent") + "\n");
    return answer;
  }
  process.stdout.write(chalk.dim("  no answer from the agent; falling back\n"));
  return viaLocalPrompt(req, !nativeDialogAvailable());
}

function viaLocalPrompt(req: ApprovalRequest, ttyOnly: boolean): Promise<ApprovalAnswer> {
  const run = async (): Promise<ApprovalAnswer> => {
    // 1. Native OS dialog (works with any coding tool, and when the daemon runs in the background).
    if (!ttyOnly && nativeDialogAvailable()) {
      const what = req.command ? `run:  ${safeText(req.command, 400)}` : `call: ${safeText(req.tool ?? "?", 100)} ${safeText(prettyArgs(req.args), 600)}`;
      const body = `${what}\n\nwhy: ${safeText(req.why, 300)}`;
      process.stdout.write(`\n${chalk.yellow("⚡")} ${chalk.magenta(safeText(req.from, 32))} ${chalk.bold(req.command ? "wants to run:" : "wants to call")} ${chalk.cyan(safeText(req.command ?? req.tool ?? "?", 200))}  ${chalk.dim("(dialog)")}\n`);
      const r = await nativeApprove({ title: `mesh: ${safeText(req.from, 32)} is asking`, body, timeoutSeconds: 90 });
      if (r === "approved") { process.stdout.write(chalk.green("  approved") + "\n"); return { approved: true }; }
      if (r === "denied") { process.stdout.write(chalk.red("  denied") + "\n"); return { approved: false, reason: "owner declined" }; }
      if (r === "timeout") { process.stdout.write(chalk.red("  no answer in 90 s") + "\n"); return { approved: false, reason: "owner did not answer in 90 s" }; }
      // null → no dialog possible here; fall through to the TTY prompt
    }
    // 2. Terminal y/n prompt.
    if (!hasTty()) return { approved: false, reason: "no tty and no dialog available" };
    const what = req.command
      ? `${chalk.bold("wants to run:")} ${chalk.cyan(safeText(req.command, 600))}`
      : `${chalk.bold("wants to call")} ${chalk.cyan(safeText(req.tool ?? "?", 120))} ${chalk.dim(safeText(prettyArgs(req.args), 2000))}`;
    process.stdout.write(`\n${chalk.yellow("⚡")} ${chalk.magenta(safeText(req.from, 32))} ${what}\n`);
    process.stdout.write(`   ${chalk.dim("why:")} ${safeText(req.why, 300)}\n`);
    process.stdout.write(`   ${chalk.bold("[y/n]")} `);
    const key = await readKey();
    if (key === CTRL_C) {
      // ctrl-c inside the raw-mode prompt: deny, restore the terminal, then exit like a normal SIGINT.
      process.stdout.write(chalk.red("^C") + "\n");
      restoreTerminal();
      process.kill(process.pid, "SIGINT");
      return { approved: false, reason: "owner interrupted" };
    }
    const approved = key === "y" || key === "Y";
    process.stdout.write((approved ? chalk.green("y  approved") : chalk.red("n  denied")) + "\n");
    return approved ? { approved: true } : { approved: false, reason: "owner declined" };
  };
  const next = queue.then(run, run);
  queue = next.catch(() => undefined);
  return next;
}
