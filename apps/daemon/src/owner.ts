/**
 * Owner token (the "End session" right): parsing it out of an owner link and calling the relay's end route.
 * The relay derives it from the room name; only `POST /api/rooms` hands it out, in `ownerLink = …/r/<room>#k=<key>&o=<token>`.
 */
import { httpOrigin, keyHeader } from "./artifacts.js";

/** Tokens are base32lower, 16 chars; accept a little more so a future format change doesn't silently drop them. */
const OWNER_TOKEN_RE = /^[a-z0-9]{8,64}$/i;

function ownerFrom(qs: string): string | undefined {
  if (!qs) return undefined;
  const v = (new URLSearchParams(qs.replace(/^[?#]/, "")).get("o") ?? "").trim();
  return OWNER_TOKEN_RE.test(v) ? v : undefined;
}

/** `https://host/r/room#k=<key>&o=<owner>` → `<owner>`; also `?o=` for links whose fragment got eaten. Fragment wins. */
export function ownerFromLink(raw: string): string | undefined {
  const link = raw.trim();
  const hash = link.indexOf("#");
  const fragment = hash >= 0 ? link.slice(hash + 1) : "";
  const beforeHash = hash >= 0 ? link.slice(0, hash) : link;
  const q = beforeHash.indexOf("?");
  return ownerFrom(fragment) ?? ownerFrom(q >= 0 ? beforeHash.slice(q + 1) : "");
}

/** Never print an owner token: `o…<last4>`. */
export function maskOwner(token: string | undefined): string {
  return token ? `o…${token.slice(-4)}` : "";
}

export const NOT_OWNER_MESSAGE = "only the person who started this session can end it (this machine joined without the owner link)";

/** This machine has no (or a wrong) owner token. Local HTTP maps it to 403. */
export class NotOwnerError extends Error {
  constructor(message = NOT_OWNER_MESSAGE) {
    super(message);
    this.name = "NotOwnerError";
  }
}

export interface EndRoomInput { relay: string; room: string; key?: string; owner?: string; by?: string; reason?: string }
export interface EndRoomResult { ok: true; room: string; closed: number; alreadyEnded?: boolean }

/** POST <relay>/api/rooms/<room>/end. Throws NotOwnerError (no token / relay 403) or Error with the relay's wording. */
export async function endRoomOnRelay(input: EndRoomInput): Promise<EndRoomResult> {
  if (!input.owner) throw new NotOwnerError();
  const url = `${httpOrigin(input.relay)}/api/rooms/${encodeURIComponent(input.room)}/end`;
  const body: Record<string, string> = {};
  if (input.by) body.by = input.by;
  if (input.reason) body.reason = input.reason.slice(0, 140);
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-mesh-owner": input.owner, ...keyHeader(input.key) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (e) {
    throw new Error(`could not reach the relay to end the session: ${(e as Error).message}`);
  }
  const json = (await res.json().catch(() => undefined)) as { error?: unknown; closed?: unknown; alreadyEnded?: unknown; room?: unknown } | undefined;
  if (!res.ok) {
    const msg = typeof json?.error === "string" ? json.error : `HTTP ${res.status}`;
    if (res.status === 403) throw new NotOwnerError(msg);
    throw new Error(`the relay refused to end the session (HTTP ${res.status}): ${msg}`);
  }
  return {
    ok: true,
    room: typeof json?.room === "string" ? json.room : input.room,
    closed: typeof json?.closed === "number" ? json.closed : 0,
    ...(json?.alreadyEnded === true ? { alreadyEnded: true } : {}),
  };
}
