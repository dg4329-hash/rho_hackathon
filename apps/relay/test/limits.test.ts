/**
 * Rate-limit tests (src/limits.ts).
 *   pnpm exec tsx test/limits.test.ts
 *
 * Token buckets over a fake clock: burst, refill, key independence, disabled modes, env defaults, maxKeys cap,
 * idle sweep, and clientIp header/socket resolution.
 */
import type { IncomingMessage } from "node:http";
import { clientIp, createRateLimiter, rateLimitsFromEnv } from "../src/limits.js";

let failures = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  console.log(`${ok ? "  ok  " : "  FAIL"} ${name}${ok || detail === undefined ? "" : `  → ${JSON.stringify(detail)}`}`);
  if (!ok) failures++;
}

function drain(take: () => { ok: boolean }, max = 10_000): number {
  let n = 0;
  while (n < max && take().ok) n++;
  return n;
}

// burst allows exactly N, then denies with retryAfterSec >= 1; refill over fake time
{
  let t = 1_000_000;
  const rl = createRateLimiter({ burst: 5, perMinute: 60, now: () => t });
  const allowed = drain(() => rl.take("a"));
  check("burst allows exactly 5", allowed === 5, allowed);
  const denied = rl.take("a");
  check("6th denied with retryAfterSec >= 1", !denied.ok && denied.retryAfterSec >= 1, denied);

  // 60/min = 1 token/sec
  t += 999;
  check("still denied just under 1s", !rl.take("a").ok);
  t += 1;
  check("1 token after ~1s", rl.take("a").ok);
  check("then denied again", !rl.take("a").ok);
  t += 3_000;
  const three = drain(() => rl.take("a"));
  check("3 tokens after 3s", three === 3, three);
  t += 60_000;
  const capped = drain(() => rl.take("a"));
  check("refill caps at burst", capped === 5, capped);

  // separate keys independent
  const other = drain(() => rl.take("b"));
  check("other key unaffected", other === 5, other);
}

// retryAfterSec reflects the refill rate
{
  const t = 0;
  const rl = createRateLimiter({ burst: 1, perMinute: 2, now: () => t });
  rl.take("x");
  const r = rl.take("x");
  check("retryAfterSec 30 at 2/min", !r.ok && r.retryAfterSec === 30, r);
}

// disabled
{
  const a = createRateLimiter({ burst: 5, perMinute: 0 });
  const b = createRateLimiter({ burst: 0, perMinute: 60 });
  check("perMinute 0 never limits", drain(() => a.take("k"), 1000) === 1000);
  check("burst 0 never limits", drain(() => b.take("k"), 1000) === 1000);
  check("disabled keeps no buckets", a.size() === 0 && b.size() === 0);
}

// env
{
  const off = rateLimitsFromEnv({ MESH_RATE_LIMIT: "0", MESH_RATE_ROOMS_BURST: "1", MESH_RATE_WS_BURST: "1" });
  check("MESH_RATE_LIMIT=0 rooms never limits", drain(() => off.rooms.take("ip"), 500) === 500);
  check("MESH_RATE_LIMIT=0 ws never limits", drain(() => off.ws.take("ip"), 500) === 500);

  const def = rateLimitsFromEnv({});
  const rooms = drain(() => def.rooms.take("ip"));
  const ws = drain(() => def.ws.take("ip"));
  check("default rooms burst 20", rooms === 20, rooms);
  check("default ws burst 60", ws === 60, ws);

  const bad = rateLimitsFromEnv({ MESH_RATE_ROOMS_BURST: "lots", MESH_RATE_WS_BURST: "3" });
  check("non-numeric env → default", drain(() => bad.rooms.take("ip")) === 20);
  check("numeric env override", drain(() => bad.ws.take("ip")) === 3);
}

// maxKeys cap + idle sweep
{
  let t = 0;
  const rl = createRateLimiter({ burst: 2, perMinute: 60, maxKeys: 3, now: () => t });
  for (const k of ["k1", "k2", "k3", "k4"]) { rl.take(k); rl.take(k); }
  check("size capped at maxKeys", rl.size() === 3, rl.size());
  check("oldest-inserted dropped (k1 full again)", drain(() => rl.take("k1")) === 2);
  check("recent key still limited", !rl.take("k4").ok);

  const sw = createRateLimiter({ burst: 2, perMinute: 60, now: () => t });
  for (let i = 0; i < 100; i++) sw.take(`ip${i}`);
  check("100 buckets tracked", sw.size() === 100, sw.size());
  t += 5_000; // well past full-again (2s)
  sw.take("fresh");
  check("idle full buckets swept", sw.size() === 1, sw.size());
}

// clientIp
{
  const req = (headers: Record<string, string | string[]>, remoteAddress?: string) =>
    ({ headers, socket: { remoteAddress } }) as unknown as Pick<IncomingMessage, "headers" | "socket">;
  check("XFF leftmost", clientIp(req({ "x-forwarded-for": "1.2.3.4, 10.0.0.1" }, "9.9.9.9")) === "1.2.3.4");
  check("XFF trimmed", clientIp(req({ "x-forwarded-for": "  5.6.7.8 ,10.0.0.1" })) === "5.6.7.8");
  check("x-real-ip", clientIp(req({ "x-real-ip": " 4.4.4.4 " }, "9.9.9.9")) === "4.4.4.4");
  check("socket ::ffff: stripped", clientIp(req({}, "::ffff:127.0.0.1")) === "127.0.0.1");
  check("plain IPv6 kept", clientIp(req({}, "::1")) === "::1");
  check("unknown", clientIp(req({})) === "unknown");
}

if (failures) {
  console.log(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nPASS");
