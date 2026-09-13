/**
 * Basic abuse protection for a public relay: per-key (usually per-client-IP) token buckets.
 * State is per-process memory only (a restart resets it; multiple replicas don't share it).
 * The client IP comes from x-forwarded-for, which a client can spoof when not behind a proxy that
 * rewrites it; that is acceptable here — this stops accidental floods and lazy abuse, not a determined attacker.
 */
import type { IncomingMessage } from "node:http";

export type Take = { ok: true } | { ok: false; retryAfterSec: number };
export interface RateLimiter { take(key: string): Take; size(): number }

interface Bucket { tokens: number; at: number }

const OK: Take = { ok: true };

/** Token bucket per key: starts full at `burst`, refills `perMinute` tokens per minute (continuous). Keys idle long enough to be full again are forgotten (on take, amortised sweep) and at most maxKeys (default 50_000) buckets are kept (drop oldest-inserted when over). perMinute<=0 or burst<=0 → never limits. */
export function createRateLimiter(opts: { burst: number; perMinute: number; maxKeys?: number; now?: () => number }): RateLimiter {
  const { burst, perMinute } = opts;
  const maxKeys = Math.max(1, opts.maxKeys ?? 50_000);
  const now = opts.now ?? Date.now;
  if (!(burst > 0) || !(perMinute > 0)) return { take: () => OK, size: () => 0 };

  const perMs = perMinute / 60_000;
  const fullAfterMs = burst / perMs; // an empty bucket is full again after this long
  const buckets = new Map<string, Bucket>();
  let lastSweep = now();

  const refill = (b: Bucket, t: number): number => Math.min(burst, b.tokens + Math.max(0, t - b.at) * perMs);

  function sweep(t: number): void {
    lastSweep = t;
    for (const [k, b] of buckets) if (refill(b, t) >= burst) buckets.delete(k);
  }

  return {
    take(key: string): Take {
      const t = now();
      if (t - lastSweep >= fullAfterMs) sweep(t); // amortised: at most one full pass per refill window
      let b = buckets.get(key);
      if (!b) {
        b = { tokens: burst, at: t };
        buckets.set(key, b);
        while (buckets.size > maxKeys) {
          const oldest = buckets.keys().next().value as string;
          buckets.delete(oldest);
        }
      } else {
        b.tokens = refill(b, t);
        b.at = t;
      }
      if (b.tokens >= 1) {
        b.tokens -= 1;
        return OK;
      }
      return { ok: false, retryAfterSec: Math.max(1, Math.ceil((1 - b.tokens) / perMs / 1000)) };
    },
    size: () => buckets.size,
  };
}

function num(v: string | undefined, dflt: number): number {
  if (v === undefined || v.trim() === "") return dflt;
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
}

/** Limiters from env. MESH_RATE_LIMIT=0 disables both (take always ok). Defaults: rooms (POST /api/rooms) burst MESH_RATE_ROOMS_BURST=20, MESH_RATE_ROOMS_PER_MIN=20; ws connects burst MESH_RATE_WS_BURST=60, MESH_RATE_WS_PER_MIN=120. Non-numeric env → default. */
export function rateLimitsFromEnv(env: NodeJS.ProcessEnv = process.env): { rooms: RateLimiter; ws: RateLimiter } {
  const off = (env.MESH_RATE_LIMIT ?? "").trim() === "0";
  const mk = (burst: number, perMinute: number) => createRateLimiter(off ? { burst: 0, perMinute: 0 } : { burst, perMinute });
  return {
    rooms: mk(num(env.MESH_RATE_ROOMS_BURST, 20), num(env.MESH_RATE_ROOMS_PER_MIN, 20)),
    ws: mk(num(env.MESH_RATE_WS_BURST, 60), num(env.MESH_RATE_WS_PER_MIN, 120)),
  };
}

function firstHeader(v: string | string[] | undefined): string {
  return (Array.isArray(v) ? v[0] : v) ?? "";
}

/** Client IP for rate limiting: leftmost entry of x-forwarded-for (Railway/ngrok set it), else x-real-ip, else req.socket.remoteAddress, else "unknown". Trim whitespace; strip an IPv4-mapped IPv6 "::ffff:" prefix. */
export function clientIp(req: Pick<IncomingMessage, "headers" | "socket">): string {
  const xff = firstHeader(req.headers["x-forwarded-for"]).split(",")[0]?.trim() ?? "";
  const ip = xff || firstHeader(req.headers["x-real-ip"]).trim() || (req.socket?.remoteAddress ?? "").trim() || "unknown";
  return ip.toLowerCase().startsWith("::ffff:") ? ip.slice(7) : ip;
}
