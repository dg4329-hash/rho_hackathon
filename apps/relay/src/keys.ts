/**
 * Room keys (docs/ROOM-KEYS.md). The link is the only password:
 *
 *   key = base32lower(HMAC-SHA256(ROOM_SECRET, room))[:16]        (RFC 4648 alphabet, lowercase, no padding)
 *   link = <origin>/r/<room>#k=<key>                              (fragment: never reaches server logs or proxies)
 *
 * Keys are never stored — the relay recomputes and compares (timing-safe). ROOM_SECRET comes from the env;
 * without it a random secret is generated per process (keys then reset on restart, which we warn about).
 * MESH_REQUIRE_KEY=0 turns enforcement off for local development; everything else keeps working.
 */
import type { IncomingMessage } from "node:http";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const B32 = "abcdefghijklmnopqrstuvwxyz234567"; // RFC 4648 base32, lowercased
export const KEY_LEN = 16;
export const KEY_RE = /^[a-z2-7]{16}$/;

/** RFC 4648 base32 of the whole buffer, lowercase, no padding. */
export function base32lower(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

let secret: Buffer | undefined;

/** The HMAC secret: env ROOM_SECRET, else a random one for this process (warned about, once). */
export function roomSecret(env: NodeJS.ProcessEnv = process.env): Buffer {
  if (!secret) {
    const raw = env.ROOM_SECRET;
    if (raw && raw.length > 0) {
      secret = Buffer.from(raw, "utf8");
    } else {
      secret = randomBytes(32);
      console.warn("! ROOM_SECRET not set: room keys reset on restart");
    }
  }
  return secret;
}

/** Test seam: forget the cached secret so the next call re-reads the env. */
export function resetRoomSecret(): void {
  secret = undefined;
}

/** The key for a room name. Deterministic for a given ROOM_SECRET. */
export function roomKey(room: string): string {
  return base32lower(createHmac("sha256", roomSecret()).update(room, "utf8").digest()).slice(0, KEY_LEN);
}

/** Timing-safe compare against the expected key for this room. */
export function verifyKey(room: string, key: string | null | undefined): boolean {
  const expected = Buffer.from(roomKey(room), "utf8");
  const got = Buffer.from(String(key ?? ""), "utf8");
  if (got.length !== expected.length) {
    timingSafeEqual(expected, expected); // keep the work constant-ish for a wrong-length guess
    return false;
  }
  return timingSafeEqual(expected, got);
}

/** Enforcement is on unless MESH_REQUIRE_KEY=0 (dev only). Read live so tests can flip it per process. */
export function requireKey(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.MESH_REQUIRE_KEY !== "0";
}

/** The key a request carries: `?key=` first, then the `x-mesh-key` header. "" when absent. */
export function keyFromRequest(req: { headers: IncomingMessage["headers"] }, url: URL): string {
  const q = url.searchParams.get("key");
  if (q) return q.trim();
  const h = req.headers["x-mesh-key"];
  return ((Array.isArray(h) ? h[0] : h) ?? "").trim();
}

export type KeyCheck = { ok: true } | { ok: false; error: "room key required" | "wrong room key" };

/** The gate used by every keyed entry point. Always { ok: true } when enforcement is off. */
export function checkKey(room: string, key: string | null | undefined, env: NodeJS.ProcessEnv = process.env): KeyCheck {
  if (!requireKey(env)) return { ok: true };
  if (!key) return { ok: false, error: "room key required" };
  return verifyKey(room, key) ? { ok: true } : { ok: false, error: "wrong room key" };
}

/** The shareable link for a room: the key lives in the fragment. */
export function roomLink(origin: string, room: string, key: string): string {
  return `${origin.replace(/\/+$/, "")}/r/${encodeURIComponent(room)}#k=${key}`;
}
