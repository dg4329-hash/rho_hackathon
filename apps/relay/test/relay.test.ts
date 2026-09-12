/**
 * Relay acceptance test against CONTRACT §1 — spawns the real relay (src/index.ts) on a free port.
 *   pnpm -F relay test
 * Set RELAY_URL=ws://host:port to test an already-running relay (e.g. through ngrok) instead.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { HISTORY_LIMIT } from "@mesh/protocol";

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

interface Client {
  ws: WebSocket;
  msgs: Record<string, unknown>[];
  closed: Promise<{ code: number; reason: string }>;
}

function connect(url: string, room: string, user: string, role = "daemon", rawQuery?: string): Promise<Client> {
  return new Promise((resolve, reject) => {
    const q = rawQuery ?? `room=${encodeURIComponent(room)}&user=${encodeURIComponent(user)}&role=${role}`;
    const ws = new WebSocket(`${url}/?${q}`);
    const msgs: Record<string, unknown>[] = [];
    const closed = new Promise<{ code: number; reason: string }>((res) => {
      ws.on("close", (code, reason) => res({ code, reason: reason.toString() }));
    });
    ws.on("message", (d) => {
      try {
        msgs.push(JSON.parse(d.toString()));
      } catch {
        msgs.push({ type: "__raw__", raw: d.toString() });
      }
    });
    ws.on("open", () => resolve({ ws, msgs, closed }));
    ws.on("error", reject);
  });
}

const hello = (from: string, offers: unknown[] = []) =>
  JSON.stringify({ type: "hello", from, ts: new Date().toISOString(), role: "daemon", offers });
const event = (from: string, summary: string) =>
  JSON.stringify({ type: "event", from, ts: new Date().toISOString(), kind: "note", summary });
const byType = (c: Client, t: string) => c.msgs.filter((m) => m.type === t);
const lastPresence = (c: Client) => byType(c, "presence").at(-1) as { members: { user: string; offers: unknown[] }[] } | undefined;

async function main(): Promise<void> {
  let child: ChildProcess | undefined;
  let url = process.env.RELAY_URL;
  let httpUrl: string;
  if (!url) {
    const port = await freePort();
    const here = path.dirname(fileURLToPath(import.meta.url));
    child = spawn(process.execPath, ["--import", "tsx", path.join(here, "..", "src", "index.ts")], {
      env: { ...process.env, PORT: String(port) },
      stdio: ["ignore", "pipe", "inherit"],
    });
    await new Promise<void>((resolve, reject) => {
      child!.stdout!.on("data", (d: Buffer) => {
        if (d.toString().includes("listening")) resolve();
      });
      child!.once("exit", (code) => reject(new Error(`relay exited early (${code})`)));
    });
    url = `ws://127.0.0.1:${port}`;
  }
  httpUrl = url.replace(/^ws/, "http");
  console.log(`relay under test: ${url}`);
  const room = `t-${Date.now()}`;

  // --- bad query params → error frame + close
  const bad = await connect(url, room, "x", "daemon", "room=only");
  const badClose = await bad.closed;
  check("bad params: error frame received", byType(bad, "error").length === 1, bad.msgs);
  check("bad params: socket closed by relay", badClose.code === 1008 || badClose.code === 1005 || badClose.code === 1000, badClose);
  const badRole = await connect(url, room, "x", "wizard");
  await badRole.closed;
  check("bad role: error frame received", byType(badRole, "error").length === 1, badRole.msgs);

  // --- A joins with offers; presence lists A with offers
  const offersA = [{ kind: "command", name: "echo", description: "echo", permission: "always" }];
  const a = await connect(url, room, "a");
  await sleep(50);
  // Before hello, A is connected but must be invisible to presence — B joining now should not list A.
  const b = await connect(url, room, "b");
  b.ws.send(hello("b"));
  await sleep(100);
  check("presence hides conns that have not sent hello", lastPresence(b)?.members.every((m) => m.user !== "a") === true, lastPresence(b));

  a.ws.send(hello("a", offersA));
  await sleep(100);
  const pa = lastPresence(a);
  check("A receives presence after its own hello", Boolean(pa), a.msgs);
  check("presence lists A with its offers", pa?.members.some((m) => m.user === "a" && m.offers.length === 1) === true, pa);
  check("presence also delivered to B", lastPresence(b)?.members.some((m) => m.user === "a") === true, lastPresence(b));
  check("hello was not forwarded to B", byType(b, "hello").length === 0, byType(b, "hello"));

  // --- fan-out: verbatim to every OTHER conn, not the sender
  const raw = event("a", "hi from a");
  a.ws.send(raw);
  await sleep(100);
  check("B received A's event verbatim", b.msgs.some((m) => JSON.stringify(m) === JSON.stringify(JSON.parse(raw))), byType(b, "event"));
  check("A did not get its own frame echoed back", byType(a, "event").length === 0, byType(a, "event"));

  // --- late joiner gets history (event but not hello), then presence
  const c = await connect(url, room, "c");
  c.ws.send(hello("c"));
  await sleep(150);
  check("late joiner got the replayed event", byType(c, "event").length === 1, c.msgs);
  check("late joiner got no hello frames in replay", byType(c, "hello").length === 0);
  const idxEvent = c.msgs.findIndex((m) => m.type === "event");
  const idxPresence = c.msgs.findIndex((m) => m.type === "presence");
  check("replay arrives before the presence frame", idxEvent >= 0 && idxPresence > idxEvent, c.msgs.map((m) => m.type));
  check("late joiner presence lists a, b, c", lastPresence(c)?.members.map((m) => m.user).sort().join(",") === "a,b,c", lastPresence(c));

  // --- second hello from same conn does not replay again
  c.ws.send(hello("c"));
  await sleep(100);
  check("second hello does not replay history", byType(c, "event").length === 1, byType(c, "event").length);

  // --- ring buffer caps at HISTORY_LIMIT, in order
  for (let i = 0; i < HISTORY_LIMIT + 20; i++) a.ws.send(event("a", `n${i}`));
  await sleep(300);
  const d = await connect(url, room, "d");
  d.ws.send(hello("d"));
  await sleep(300);
  const dEvents = byType(d, "event") as { summary: string }[];
  check(`late joiner receives exactly ${HISTORY_LIMIT} frames`, dEvents.length === HISTORY_LIMIT, dEvents.length);
  check("replayed frames are the newest, in order", dEvents[0]?.summary === "n20" && dEvents.at(-1)?.summary === `n${HISTORY_LIMIT + 19}`, [dEvents[0]?.summary, dEvents.at(-1)?.summary]);
  const bEvents = byType(b, "event");
  check("B got every fan-out frame in order", bEvents.length === HISTORY_LIMIT + 21 && (bEvents[1] as { summary: string }).summary === "n0", bEvents.length);

  // --- rooms are isolated
  const other = await connect(url, `${room}-other`, "z");
  other.ws.send(hello("z"));
  await sleep(100);
  check("other room sees no history", byType(other, "event").length === 0, other.msgs.length);
  check("other room presence lists only z", lastPresence(other)?.members.map((m) => m.user).join(",") === "z", lastPresence(other));
  other.ws.send(event("z", "cross-room leak?"));
  await sleep(100);
  check("frame from other room did not leak", !b.msgs.some((m) => (m as { summary?: string }).summary === "cross-room leak?"));

  // --- health
  const health = (await (await fetch(`${httpUrl}/health`)).json()) as { rooms: number; connections: number };
  check("GET /health shape", typeof health.rooms === "number" && typeof health.connections === "number", health);
  check("GET /health counts", health.rooms === 2 && health.connections === 5, health);
  check("GET /nope → 404", (await fetch(`${httpUrl}/nope`)).status === 404);

  // --- leave → presence without the leaver
  const presenceCountBefore = byType(b, "presence").length;
  a.ws.close();
  await sleep(150);
  check("presence broadcast on leave", byType(b, "presence").length === presenceCountBefore + 1);
  check("leaver dropped from presence", lastPresence(b)?.members.every((m) => m.user !== "a") === true, lastPresence(b));

  // --- malformed JSON is dropped with an error frame, not fan-out
  b.ws.send("this is not json");
  await sleep(100);
  check("malformed frame → error to sender", byType(b, "error").length === 1, byType(b, "error"));
  check("malformed frame not forwarded", !c.msgs.some((m) => m.type === "__raw__"));

  for (const cl of [b, c, d, other]) cl.ws.close();
  await sleep(100);
  child?.kill("SIGTERM");
  console.log(failures === 0 ? "\nPASS" : `\nFAIL (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("FAIL", e);
  process.exit(1);
});
