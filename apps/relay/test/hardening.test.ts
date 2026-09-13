/**
 * Relay hardening tests — spawns the real relay (src/index.ts) once per scenario group, each with its own env.
 *   pnpm exec tsx test/hardening.test.ts
 *
 * 1. duplicate daemon name → 4409 (ghosts that stop answering pings are replaced; clean reconnects are not refused)
 * 2. rate limits on POST /api/rooms (429 + retry-after) and ws connects (error frame + 1013); MESH_RATE_LIMIT=0 disables
 * 3. room cap (MESH_MAX_ROOMS) → 503 / ws 1013 "full"
 * 4. idle sweep of rooms without connections (MESH_ROOM_IDLE_MS)
 * 5. max frame size (MESH_MAX_FRAME_BYTES) → 1009
 * 6. history byte cap (MESH_HISTORY_MAX_BYTES)
 * 7. room names are <word>-<8 hex>
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

let failures = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  console.log(`${ok ? "  ok  " : "  FAIL"} ${name}${ok || detail === undefined ? "" : `  → ${JSON.stringify(detail)}`}`);
  if (!ok) failures++;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
    srv.once("error", reject);
  });
}

const children: ChildProcess[] = [];
process.on("exit", () => {
  for (const c of children) try { c.kill("SIGTERM"); } catch { /* ignore */ }
});

interface Relay { child: ChildProcess; ws: string; http: string }

async function startRelay(env: Record<string, string>): Promise<Relay> {
  const port = await freePort();
  const here = path.dirname(fileURLToPath(import.meta.url));
  const child = spawn(process.execPath, ["--import", "tsx", path.join(here, "..", "src", "index.ts")], {
    env: { ...process.env, PORT: String(port), MESH_REQUIRE_KEY: "0", ...env },
    stdio: ["ignore", "pipe", "inherit"],
  });
  children.push(child);
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("relay did not start within 15 s")), 15_000);
    child.stdout!.on("data", (d: Buffer) => { if (d.toString().includes("listening")) { clearTimeout(t); resolve(); } });
    child.once("exit", (code) => { clearTimeout(t); reject(new Error(`relay exited early (${code})`)); });
  });
  return { child, ws: `ws://127.0.0.1:${port}`, http: `http://127.0.0.1:${port}` };
}

interface Client {
  ws: WebSocket;
  msgs: Record<string, unknown>[];
  closed: Promise<{ code: number; reason: string }>;
  isClosed: () => { code: number; reason: string } | null;
}

/** Open a socket; resolves on open (or on close/error if it never opens). Collects every frame. */
function connect(url: string, room: string, user: string, role = "daemon", opts: WebSocket.ClientOptions = {}): Promise<Client> {
  return new Promise((resolve) => {
    const q = `room=${encodeURIComponent(room)}&user=${encodeURIComponent(user)}&role=${role}`;
    const ws = new WebSocket(`${url}/?${q}`, opts);
    const msgs: Record<string, unknown>[] = [];
    let closedWith: { code: number; reason: string } | null = null;
    const closed = new Promise<{ code: number; reason: string }>((res) => {
      ws.on("close", (code, reason) => { closedWith = { code, reason: reason.toString() }; res(closedWith); });
    });
    const client: Client = { ws, msgs, closed, isClosed: () => closedWith };
    ws.on("message", (d) => {
      try { msgs.push(JSON.parse(d.toString())); } catch { msgs.push({ type: "__raw__", raw: d.toString() }); }
    });
    ws.on("open", () => resolve(client));
    ws.on("error", () => { /* close follows */ });
    ws.on("close", () => resolve(client));
  });
}

/** Wait for close up to ms; returns the close info or null on timeout. */
async function closedWithin(c: Client, ms: number): Promise<{ code: number; reason: string } | null> {
  return Promise.race([c.closed, sleep(ms).then(() => null)]);
}

const hello = (from: string, offers: unknown[] = []) =>
  JSON.stringify({ type: "hello", from, ts: new Date().toISOString(), role: "daemon", offers });
const event = (from: string, summary: string) =>
  JSON.stringify({ type: "event", from, ts: new Date().toISOString(), kind: "note", summary });
const byType = (c: Client, t: string) => c.msgs.filter((m) => m.type === t);
const errText = (c: Client) => byType(c, "error").map((m) => String(m.message ?? "")).join(" | ");
const lastPresence = (c: Client) => byType(c, "presence").at(-1) as { members: { user: string }[] } | undefined;

async function roomExists(http: string, room: string): Promise<unknown> {
  const r = await fetch(`${http}/api/rooms/${room}`);
  const body = (await r.json()) as { exists?: boolean };
  return body.exists;
}

// ---------------------------------------------------------------------------

async function duplicates(r: Relay): Promise<void> {
  console.log("1. duplicate daemon names (checked at the first hello, only between daemons that offer something)");
  const offers = [{ kind: "command", name: "echo", description: "echo", permission: "ask" }];
  const room = "dup-room";
  const a = await connect(r.ws, room, "dup");
  a.ws.send(hello("dup", offers));
  await sleep(150);
  const b = await connect(r.ws, room, "dup");
  b.ws.send(hello("dup", offers));
  const bClose = await closedWithin(b, 1500);
  check("second offering daemon with the same name gets error 'already connected'", errText(b).includes("already connected"), b.msgs);
  check("second daemon closed with 4409", bClose?.code === 4409, bClose);
  await sleep(100);
  check("first daemon stays open", a.isClosed() === null && a.ws.readyState === WebSocket.OPEN, a.isClosed());
  const watcher = await connect(r.ws, room, "watch", "feed");
  watcher.ws.send(hello("watch"));
  await sleep(150);
  const dups = lastPresence(watcher)?.members.filter((m) => m.user === "dup").length;
  check("first daemon still in presence, exactly once", dups === 1, lastPresence(watcher));

  // `mesh ask` connects as role=daemon under the owner's own name with no offers, next to the running daemon.
  const ask = await connect(r.ws, room, "dup");
  ask.ws.send(hello("dup"));
  const askClose = await closedWithin(ask, 700);
  check("no-offer daemon with the same name (mesh ask) is allowed", askClose === null && !errText(ask).includes("already connected"), { askClose, msgs: ask.msgs });
  ask.ws.send(event("dup", "from mesh ask"));
  await sleep(150);
  check("mesh ask conn can still send frames", a.msgs.some((m) => m.summary === "from mesh ask"), byType(a, "event"));

  const feed = await connect(r.ws, room, "dup", "feed");
  feed.ws.send(hello("dup", offers));
  const feedClose = await closedWithin(feed, 700);
  check("role=feed with the same user name is allowed", feedClose === null && !errText(feed).includes("already connected"), { feedClose, msgs: feed.msgs });

  const other = await connect(r.ws, "dup-room-2", "dup");
  other.ws.send(hello("dup", offers));
  const otherClose = await closedWithin(other, 500);
  check("same user name in a different room is allowed", otherClose === null && byType(other, "error").length === 0, { otherClose, msgs: other.msgs });
  for (const c of [a, watcher, ask, feed, other]) c.ws.close();

  // --- ghost: old socket stops answering pings → replaced; frames sent during the probe are delivered afterwards
  const room2 = "ghost-room";
  const a2 = await connect(r.ws, room2, "ghost", "daemon", { autoPong: false });
  a2.ws.send(hello("ghost", offers));
  const w2 = await connect(r.ws, room2, "w2", "feed");
  w2.ws.send(hello("w2"));
  await sleep(150);
  const t0 = Date.now();
  const b2 = await connect(r.ws, room2, "ghost");
  b2.ws.send(hello("ghost", offers));
  b2.ws.send(event("ghost", "sent during probe"));
  const b2Close = await closedWithin(b2, 1000);
  check("ghost: new daemon is not refused (no 4409)", b2Close === null && !errText(b2).includes("already connected"), { b2Close, msgs: b2.msgs });
  const a2Close = await closedWithin(a2, 1500);
  check("ghost: old unresponsive socket is terminated", a2Close !== null, { a2Close, ms: Date.now() - t0 });
  await sleep(200);
  const ghosts = lastPresence(b2)?.members.filter((m) => m.user === "ghost").length;
  check("ghost: new daemon got presence listing 'ghost' exactly once", ghosts === 1, lastPresence(b2));
  check("ghost: frame sent during the probe delivered after it", w2.msgs.some((m) => m.summary === "sent during probe"), byType(w2, "event"));
  check("ghost: new daemon still open", b2.isClosed() === null, b2.isClosed());
  b2.ws.close();
  w2.ws.close();

  // --- clean reconnect: close and reconnect in the same tick
  const room3 = "re-room";
  const c = await connect(r.ws, room3, "re");
  c.ws.send(hello("re", offers));
  await sleep(150);
  c.ws.close();
  const d = await connect(r.ws, room3, "re");
  d.ws.send(hello("re", offers));
  const dClose = await closedWithin(d, 1200);
  check("clean reconnect in the same tick is accepted (no 4409)", dClose === null && !errText(d).includes("already connected") && byType(d, "presence").length > 0, { dClose, msgs: d.msgs });
  d.ws.close();
}

async function rateLimits(r: Relay): Promise<void> {
  console.log("2. rate limits");
  const statuses: number[] = [];
  const names: string[] = [];
  for (let i = 0; i < 3; i++) {
    const res = await fetch(`${r.http}/api/rooms`, { method: "POST" });
    statuses.push(res.status);
    if (res.status === 201) names.push(((await res.json()) as { room: string }).room);
  }
  check("POST /api/rooms ×3 → 201", statuses.every((s) => s === 201), statuses);
  const fourth = await fetch(`${r.http}/api/rooms`, { method: "POST" });
  let body: { error?: string } = {};
  try { body = (await fourth.json()) as { error?: string }; } catch { /* not json */ }
  check("4th POST /api/rooms → 429", fourth.status === 429, fourth.status);
  check("429 body { error: 'rate limited…' }", typeof body.error === "string" && body.error.includes("rate limited"), body);
  check("429 carries retry-after", Number(fourth.headers.get("retry-after")) >= 1, fourth.headers.get("retry-after"));
  check("GET /health unaffected", (await fetch(`${r.http}/health`)).status === 200);

  const name = /^[a-z]+-[0-9a-f]{8}$/;
  check("7. room names match <word>-<8 hex>", names.length > 0 && names.every((n) => name.test(n)), names);

  const opened: Client[] = [];
  for (let i = 0; i < 4; i++) opened.push(await connect(r.ws, "rate-room", `u${i}`));
  await sleep(200);
  check("4 ws connects accepted", opened.every((c) => c.isClosed() === null && c.ws.readyState === WebSocket.OPEN), opened.map((c) => c.isClosed()));
  const fifth = await connect(r.ws, "rate-room", "u4");
  const fifthClose = await closedWithin(fifth, 1500);
  check("5th ws connect → error frame 'rate limited'", errText(fifth).includes("rate limited"), fifth.msgs);
  check("5th ws connect → close 1013", fifthClose?.code === 1013, fifthClose);
  for (const c of opened) c.ws.close();
}

async function rateLimitsOff(r: Relay): Promise<void> {
  console.log("2b. MESH_RATE_LIMIT=0");
  const statuses: number[] = [];
  for (let i = 0; i < 10; i++) statuses.push((await fetch(`${r.http}/api/rooms`, { method: "POST" })).status);
  check("10 POST /api/rooms all 201", statuses.every((s) => s === 201), statuses);
  const socks: Client[] = [];
  for (let i = 0; i < 8; i++) socks.push(await connect(r.ws, "free-room", `u${i}`));
  await sleep(200);
  check("8 ws connects all accepted", socks.every((c) => c.isClosed() === null), socks.map((c) => c.isClosed()));
  for (const c of socks) c.ws.close();
}

async function roomCap(r: Relay): Promise<void> {
  console.log("3. room cap");
  const made: string[] = [];
  const statuses: number[] = [];
  for (let i = 0; i < 2; i++) {
    const res = await fetch(`${r.http}/api/rooms`, { method: "POST" });
    statuses.push(res.status);
    if (res.status === 201) made.push(((await res.json()) as { room: string }).room);
  }
  check("POST /api/rooms ×2 → 201", statuses.every((s) => s === 201), statuses);
  const third = await fetch(`${r.http}/api/rooms`, { method: "POST" });
  let body: { error?: string } = {};
  try { body = (await third.json()) as { error?: string }; } catch { /* not json */ }
  check("3rd POST /api/rooms → 503", third.status === 503, third.status);
  check("503 body { error: '…full…' }", typeof body.error === "string" && body.error.includes("full"), body);

  const nu = await connect(r.ws, "brand-new-room", "x");
  const nuClose = await closedWithin(nu, 1500);
  check("ws to a new room when full → error 'full'", errText(nu).includes("full"), nu.msgs);
  check("ws to a new room when full → close 1013", nuClose?.code === 1013, nuClose);

  if (made[0]) {
    const ok = await connect(r.ws, made[0], "x");
    ok.ws.send(hello("x"));
    const okClose = await closedWithin(ok, 400);
    check("ws to an existing room still works", okClose === null && lastPresence(ok)?.members.some((m) => m.user === "x") === true, { okClose, msgs: ok.msgs });
    ok.ws.close();
  } else {
    check("ws to an existing room still works", false, "no room was created");
  }
}

async function idleSweep(r: Relay): Promise<void> {
  console.log("4. idle sweep");
  const res = await fetch(`${r.http}/api/rooms`, { method: "POST" });
  const x = ((await res.json()) as { room: string }).room;
  check("new room exists right after creation", (await roomExists(r.http, x)) === true);

  const y = "idle-y";
  const c = await connect(r.ws, y, "keeper");
  c.ws.send(hello("keeper"));
  await sleep(50);
  c.ws.send(event("keeper", "hi"));
  await sleep(1150);
  check("empty room swept after idle (exists:false)", (await roomExists(r.http, x)) === false);
  check("room with a connection is never swept", (await roomExists(r.http, y)) === true);
  c.ws.close();
  await sleep(1200);
  check("room swept after its last connection left + idle", (await roomExists(r.http, y)) === false);
}

async function frameSize(r: Relay): Promise<void> {
  console.log("5. frame size");
  const room = "frame-room";
  const a = await connect(r.ws, room, "a");
  const b = await connect(r.ws, room, "b");
  a.ws.send(hello("a"));
  b.ws.send(hello("b"));
  await sleep(150);
  const mid = event("a", "m".repeat(30_000));
  a.ws.send(mid);
  await sleep(300);
  check("30 KB event forwarded to another member", byType(b, "event").some((m) => (m.summary as string).length === 30_000), byType(b, "event").length);
  check("sender still open after 30 KB", a.isClosed() === null, a.isClosed());
  a.ws.send(event("a", "x".repeat(100_000)));
  const aClose = await closedWithin(a, 1500);
  check("100 KB frame → close 1009", aClose?.code === 1009, aClose);
  await sleep(100);
  check("100 KB frame not forwarded", byType(b, "event").length === 1, byType(b, "event").length);
  b.ws.close();
}

async function historyBytes(r: Relay): Promise<void> {
  console.log("6. history byte cap");
  const room = "hist-room";
  const a = await connect(r.ws, room, "a");
  a.ws.send(hello("a"));
  await sleep(100);
  const sizes: number[] = [];
  for (let i = 1; i <= 10; i++) {
    const f = event("a", `n${i}:` + "p".repeat(10_000));
    sizes.push(Buffer.byteLength(f));
    a.ws.send(f);
  }
  await sleep(300);
  const late = await connect(r.ws, room, "late");
  late.ws.send(hello("late"));
  await sleep(400);
  const evs = byType(late, "event") as { summary: string }[];
  const nums = evs.map((e) => Number(e.summary.split(":")[0]!.slice(1)));
  const total = evs.reduce((s, e) => s + Buffer.byteLength(JSON.stringify(e)), 0);
  // byte-for-byte, the relay stores raw frames; re-serialised JSON.stringify of the parsed frame is identical here.
  const maxFit = (() => { let s = 0, n = 0; for (const sz of [...sizes].reverse()) { if (s + sz > 50_000) break; s += sz; n++; } return n; })();
  check(`late joiner replays ${maxFit} newest frames (≤ 50000 bytes)`, evs.length >= 1 && evs.length <= 5 && total <= 50_000, { count: evs.length, total, expected: maxFit });
  check("replayed frames fit exactly the byte budget (none dropped unnecessarily)", evs.length === maxFit, { count: evs.length, expected: maxFit });
  const inOrder = nums.every((n, i) => i === 0 || n === nums[i - 1]! + 1);
  check("replayed frames are the newest, in order, last one is #10", inOrder && nums.at(-1) === 10, nums);
  a.ws.close();
  late.ws.close();
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const started = Date.now();
  const [dup, rate, rateOff, cap, idle, frame, hist] = await Promise.all([
    startRelay({ MESH_DUP_PROBE_MS: "500", MESH_RATE_LIMIT: "0" }),
    startRelay({ MESH_RATE_ROOMS_BURST: "3", MESH_RATE_ROOMS_PER_MIN: "1", MESH_RATE_WS_BURST: "4", MESH_RATE_WS_PER_MIN: "1" }),
    startRelay({ MESH_RATE_LIMIT: "0", MESH_RATE_ROOMS_BURST: "3", MESH_RATE_ROOMS_PER_MIN: "1", MESH_RATE_WS_BURST: "4", MESH_RATE_WS_PER_MIN: "1" }),
    startRelay({ MESH_MAX_ROOMS: "2", MESH_RATE_LIMIT: "0" }),
    startRelay({ MESH_ROOM_IDLE_MS: "300", MESH_RATE_LIMIT: "0" }),
    startRelay({ MESH_MAX_FRAME_BYTES: "65536", MESH_RATE_LIMIT: "0" }),
    startRelay({ MESH_HISTORY_MAX_BYTES: "50000", MESH_RATE_LIMIT: "0" }),
  ]);
  const groups: [Relay, (r: Relay) => Promise<void>][] = [
    [dup, duplicates], [rate, rateLimits], [rateOff, rateLimitsOff], [cap, roomCap], [idle, idleSweep], [frame, frameSize], [hist, historyBytes],
  ];
  for (const [relay, fn] of groups) {
    try {
      await fn(relay);
    } catch (e) {
      check(`${fn.name} threw`, false, String(e));
    } finally {
      relay.child.kill("SIGTERM");
    }
  }
  console.log(`\n(${((Date.now() - started) / 1000).toFixed(1)} s)`);
  console.log(failures === 0 ? "PASS" : `FAIL (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("FAIL", e);
  process.exit(1);
});
