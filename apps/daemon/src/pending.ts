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
  /** an overlay (browser panel) is long-polling; only meaningful with mode "overlay" */
  overlayAttached?: boolean;
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
  // "overlay": only the overlay answers; if none is open, fall straight to the OS dialog (no 120 s wait)
  if (mode === "overlay") return i.overlayAttached ? "watcher" : i.dialogAvailable ? "dialog" : "tty";
  if (mode === "watcher" || i.watcherAttached) return "watcher";
  if (i.dialogAvailable) return "dialog";
  return "tty";
}

export type ApprovalsMode = "auto" | "overlay" | "dialog" | "tty";
export const APPROVALS_MODES: ApprovalsMode[] = ["auto", "overlay", "dialog", "tty"];
export type PollConsumer = "agent" | "overlay";

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
  private lastOverlayPollAt = -Infinity;
  /** Runtime approvals mode (set from the overlay or `POST /approvals`); "auto" = env MESH_APPROVE or the default path. */
  mode: ApprovalsMode = "auto";
  constructor(private readonly now: () => number = () => Date.now()) {}

  /** Any watcher (agent or overlay) polled recently. */
  watcherAttached(): boolean {
    return this.now() - Math.max(this.lastPollAt, this.lastOverlayPollAt) < WATCHER_TTL_MS;
  }
  overlayAttached(): boolean {
    return this.now() - this.lastOverlayPollAt < WATCHER_TTL_MS;
  }
  /** What a given consumer is allowed to see. In "overlay" mode the coding-agent watcher is never asked. */
  visibleTo(consumer: PollConsumer): PendingRequest[] {
    if (this.mode === "overlay" && consumer === "agent") return [];
    if (this.mode === "dialog" || this.mode === "tty") return [];
    return this.list();
  }

  list(): PendingRequest[] {
    return [...this.entries.values()].map((e) => e.req);
  }

  /**
   * Long-poll for a watcher. Resolves at once with the current list when it is non-empty (or waitMs ≤ 0),
   * otherwise when a request arrives or after waitMs. Every call marks a watcher as attached.
   */
  /** Wake every long-poller now (used when a message arrives so the watcher can print it). */
  wakeAll(): void {
    for (const wake of [...this.pollers]) wake();
  }

  poll(waitMs: number, consumer: PollConsumer = "agent"): Promise<PendingRequest[]> {
    const stamp = () => { if (consumer === "overlay") this.lastOverlayPollAt = this.now(); else this.lastPollAt = this.now(); };
    stamp();
    if (this.visibleTo(consumer).length > 0 || waitMs <= 0) return Promise.resolve(this.visibleTo(consumer));
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.pollers.delete(done);
        stamp();
        resolve(this.visibleTo(consumer));
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
