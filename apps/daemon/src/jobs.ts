/** In-memory job table shared by outgoing asks (core) and the local MCP server. */
import { OUTPUT_TAIL_BYTES, type JobResult } from "@mesh/protocol";
import type { Job } from "./api.js";

type Waiter = { resolve: (job: Job) => void; timer: NodeJS.Timeout };

export class Jobs {
  private readonly map = new Map<string, Job>();
  private readonly waiters = new Map<string, Set<Waiter>>();

  get(id: string): Job | undefined {
    return this.map.get(id);
  }

  has(id: string): boolean {
    return this.map.has(id);
  }

  add(job: Job): Job {
    this.map.set(job.id, job);
    return job;
  }

  /** Call after mutating a job; wakes waiters if the job reached a terminal state. */
  notify(id: string): void {
    const job = this.map.get(id);
    if (!job) return;
    if (job.status !== "completed" && job.status !== "denied") return;
    const set = this.waiters.get(id);
    if (!set) return;
    this.waiters.delete(id);
    for (const w of set) {
      clearTimeout(w.timer);
      w.resolve(job);
    }
  }

  /**
   * Resolve when the job becomes completed/denied, or after `ms` with the job as-is.
   * Unknown id → rejects.
   */
  waitFor(id: string, ms: number): Promise<Job> {
    const job = this.map.get(id);
    if (!job) return Promise.reject(new Error(`unknown job ${id}`));
    if (job.status === "completed" || job.status === "denied" || ms <= 0) return Promise.resolve(job);
    return new Promise<Job>((resolve) => {
      const waiter: Waiter = {
        resolve,
        timer: setTimeout(() => {
          this.waiters.get(id)?.delete(waiter);
          resolve(job);
        }, ms),
      };
      let set = this.waiters.get(id);
      if (!set) this.waiters.set(id, (set = new Set()));
      set.add(waiter);
    });
  }
}

/** Last `bytes` characters of the job's output. */
export function jobTail(job: Job, bytes = OUTPUT_TAIL_BYTES): string {
  const joined = job.chunks.join("");
  return joined.length > bytes ? joined.slice(-bytes) : joined;
}

export function toJobResult(job: Job): JobResult {
  switch (job.status) {
    case "denied":
      return { jobId: job.id, status: "denied", reason: job.reason ?? "denied" };
    case "completed":
      return {
        jobId: job.id,
        status: "completed",
        exitCode: job.exitCode ?? null,
        output: jobTail(job),
        durationMs: job.durationMs ?? 0,
      };
    default:
      return { jobId: job.id, status: job.status };
  }
}
