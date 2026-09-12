/**
 * Pending-approval queue: the in-tool approval path.
 *
 * A *watcher* (`mesh watch`, run as the Claude Code plugin's background monitor) long-polls
 * `GET /pending`. While one has polled within WATCHER_TTL_MS, incoming requests that need the
 * owner's yes/no are parked here instead of opening a native dialog; the watcher prints one line
 * per request into the owner's Claude Code session, Claude calls the `approve_request` MCP tool
 * (or something POSTs `/decide`), and the parked request resolves. If nobody answers within
 * DECISION_TIMEOUT_MS, or the watcher goes away, the caller falls back to the dialog / tty prompt.
 */
import type { PendingRequest } from "@mesh/protocol";
import type { ApprovalAnswer } from "./approval.js";

export type ApprovalPath = "watcher" | "dialog" | "tty";

export interface ApprovalPathInputs {
  /** A `GET /pending` long-poll was seen within WATCHER_TTL_MS. */
  watcherAttached: boolean;
  /** `MESH_APPROVE`: "dialog" | "tty" force that path; "watcher" forces the queue; anything else = auto. */
  mode?: string;
  dialogAvailable: boolean;
  tty: boolean;
}

/** Pure: which approval surface to use. Precedence: forced mode → watcher → dialog → tty. */
export function selectApprovalPath(i: ApprovalPathInputs): ApprovalPath {
  const mode = (i.mode ?? "").trim().toLowerCase();
  if (mode === "tty") return "tty";
  if (mode === "dialog") return i.dialogAvailable ? "dialog" : "tty";
  if (mode === "watcher" || i.watcherAttached) return "watcher";
  if (i.dialogAvailable) return "dialog";
  return "tty";
}

export const WATCHER_TTL_MS = 60_000;
export const DECISION_TIMEOUT_MS = 120_000;
const WATCHER_CHECK_MS = 5_000;

interface Entry {
  req: PendingRequest;
  resolve: (a: ApprovalAnswer | undefined) => void;
  timers: Array<NodeJS.Timeout>;
}

export class PendingApprovals {
  private readonly entries = new Map<string, Entry>();
  private readonly pollers = new Set<() => void>();
  private lastPollAt = -Infinity;
  constructor(private readonly now: () => number = () => Date.now()) {}

  watcherAttached(): boolean {
    return this.now() - this.lastPollAt < WATCHER_TTL_MS;
  }

  list(): PendingRequest[] {
    return [...this.entries.values()].map((e) => e.req);
  }

  /**
   * Long-poll for a watcher. Resolves at once with the current list when it is non-empty (or waitMs ≤ 0),
   * otherwise when a request arrives or after waitMs. Every call marks a watcher as attached.
   */
  poll(waitMs: number): Promise<PendingRequest[]> {
    this.lastPollAt = this.now();
    if (this.entries.size > 0 || waitMs <= 0) return Promise.resolve(this.list());
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.pollers.delete(done);
        this.lastPollAt = this.now();
        resolve(this.list());
      };
      const timer = setTimeout(done, waitMs);
      this.pollers.add(done);
    });
  }

  /**
   * Park a request until decide() answers it. Resolves `undefined` when nobody answered within
   * timeoutMs, or when the watcher stopped polling (checked every few seconds); the caller then
   * falls back to the dialog / tty prompt.
   */
  ask(req: Omit<PendingRequest, "createdAt" | "expiresAt">, timeoutMs = DECISION_TIMEOUT_MS): Promise<ApprovalAnswer | undefined> {
    const createdAt = this.now();
    const full: PendingRequest = { ...req, createdAt: new Date(createdAt).toISOString(), expiresAt: new Date(createdAt + timeoutMs).toISOString() };
    return new Promise((resolve) => {
      const giveUp = () => {
        const e = this.entries.get(req.id);
        if (!e) return;
        this.entries.delete(req.id);
        for (const t of e.timers) clearTimeout(t);
        resolve(undefined);
      };
      const timeout = setTimeout(giveUp, timeoutMs);
      const watcherCheck = setInterval(() => { if (!this.watcherAttached()) giveUp(); }, WATCHER_CHECK_MS);
      this.entries.set(req.id, { req: full, resolve, timers: [timeout, watcherCheck] });
      for (const wake of [...this.pollers]) wake();
    });
  }

  /** Answer a parked request. False when the id is unknown (expired, already decided, never parked). */
  decide(id: string, decision: "approved" | "denied", reason?: string): boolean {
    const e = this.entries.get(id);
    if (!e) return false;
    this.entries.delete(id);
    for (const t of e.timers) clearTimeout(t);
    e.resolve(decision === "approved" ? { approved: true } : { approved: false, reason: reason?.trim() || "owner declined" });
    return true;
  }
}

/** The one line `mesh watch` prints per pending request; imperative on purpose (the model must act on it). */
export function watchLine(p: PendingRequest): string {
  const what = p.command ? `run \`${oneLine(p.command, 300)}\`` : `call ${p.tool} ${oneLine(JSON.stringify(p.args ?? {}), 300)}`;
  return (
    `mesh: ${p.from} wants to ${what} on this machine (why: ${oneLine(p.why, 200)}). ` +
    `Call approve_request({"id":"${p.id}","decision":"approved"}) now so the user gets the permission prompt; ` +
    `if they reject it, call it again with "decision":"denied".`
  );
}

function oneLine(text: string, max: number): string {
  // eslint-disable-next-line no-control-regex
  const flat = text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/[\x00-\x1f\x7f]+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max - 1) + "…" : flat;
}
