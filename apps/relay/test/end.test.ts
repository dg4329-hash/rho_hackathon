/**
 * End session tests (docs/ROOM-KEYS.md "Owner token").
 *   pnpm -F relay exec tsx test/end.test.ts
 *
 * Part 1: owner token derivation (deterministic, != key), verifyOwner, room-name allocation skips taken/ended names,
 *         by/reason sanitising, per-room artifact purge.
 * Part 2: the real relay (ROOM_SECRET=test-secret, keys enforced): only POST /api/rooms returns the owner token;
 *         POST /api/rooms/:room/end 400/401/403/200; every socket gets room_ended then close 4410; reconnect → 4410;
 *         GET /api/rooms/:room → 410; files → 410; second end → alreadyEnded; other rooms unaffected; /join.cmd bakes --owner;
 *         served page scripts still parse.
 * Part 3: MESH_REQUIRE_KEY=0 still requires the owner token; MESH_ENDED_TTL_MS expires the tombstone.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

process.env.ROOM_SECRET = "test-secret";
process.env.MESH_REQUIRE_KEY = "1";
const { roomKey, ownerToken, verifyOwner, ownerLink, OWNER_RE } = await import("../src/keys.js");
const { allocateRoomName, cleanBy, cleanReason } = await import("../src/web.js");
const { createFileStore } = await import("../src/files.js");

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

async function startRelay(env: Record<string, string>): Promise<{ child: ChildProcess; http: string; ws: string }> {
  const port = await freePort();
  const here = path.dirname(fileURLToPath(import.meta.url));
  const child = spawn(process.execPath, ["--import", "tsx", path.join(here, "..", "src", "index.ts")], {
    env: { ...process.env, PORT: String(port), MESH_RATE_LIMIT: "0", ...env },
    stdio: ["ignore", "pipe", "inherit"],
  });
  children.push(child);
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("relay did not start within 15 s")), 15_000);
    child.stdout!.on("data", (d: Buffer) => { if (d.toString().includes("listening")) { clearTimeout(t); resolve(); } });
    child.once("exit", (code) => { clearTimeout(t); reject(new Error(`relay exited early (${code})`)); });
  });
  return { child, http: `http://127.0.0.1:${port}`, ws: `ws://127.0.0.1:${port}` };
}

interface Client { ws: WebSocket; frames: Record<string, unknown>[]; closed: Promise<{ code: number; reason: string }>; isOpen: () => boolean }

/** Open a daemon connection, send hello, resolve once open. */
async function connect(ws: string, room: string, user: string, key: string): Promise<Client> {
  const sock = new WebSocket(`${ws}/?room=${room}&user=${user}&role=daemon&key=${key}`);
  const frames: Record<string, unknown>[] = [];
  let open = false;
  const closed = new Promise<{ code: number; reason: string }>((resolve) => sock.on("close", (code, reason) => { open = false; resolve({ code, reason: reason.toString() }); }));
  sock.on("message", (d) => { try { frames.push(JSON.parse(d.toString())); } catch { /* ignore */ } });
  sock.on("error", () => { /* close follows */ });
  await new Promise<void>((resolve, reject) => { sock.on("open", () => { open = true; resolve(); }); sock.on("close", () => reject(new Error(`closed before open (${user})`))); });
  sock.send(JSON.stringify({ type: "hello", from: user, ts: new Date().toISOString(), role: "daemon", offers: [] }));
  return { ws: sock, frames, closed, isOpen: () => open && sock.readyState === WebSocket.OPEN };
}

/** Connect and collect until close (or 1.5 s). */
function wsTry(ws: string, query: string): Promise<{ frames: Record<string, unknown>[]; code: number; reason: string }> {
  return new Promise((resolve) => {
    const sock = new WebSocket(`${ws}/?${query}`);
    const frames: Record<string, unknown>[] = [];
    const timer = setTimeout(() => { try { sock.close(); } catch { /* ignore */ } resolve({ frames, code: 0, reason: "timeout" }); }, 1500);
    sock.on("message", (d) => { try { frames.push(JSON.parse(d.toString())); } catch { /* ignore */ } });
    sock.on("close", (code, reason) => { clearTimeout(timer); resolve({ frames, code, reason: reason.toString() }); });
    sock.on("error", () => { /* close follows */ });
  });
}

const withTimeout = <T>(p: Promise<T>, ms: number, fallback: T): Promise<T> => Promise.race([p, sleep(ms).then(() => fallback)]);

function unit(): void {
  console.log("owner token + helpers");
  const room = "otter-1234";
  const t = ownerToken(room);
  check("owner token is 16 chars of [a-z2-7]", OWNER_RE.test(t), t);
  check("owner token is deterministic under a fixed ROOM_SECRET", ownerToken(room) === t);
  check("owner token differs from the room key", t !== roomKey(room), { t, key: roomKey(room) });
  check("different rooms get different owner tokens", ownerToken("otter-1235") !== t);
  check("verifyOwner accepts the right token", verifyOwner(room, t));
  check("verifyOwner rejects the room key, a wrong token, empty and null", !verifyOwner(room, roomKey(room)) && !verifyOwner(room, "a".repeat(16)) && !verifyOwner(room, "") && !verifyOwner(room, null));
  check("ownerLink = share link + &o=", ownerLink("https://r.example", room, roomKey(room), t) === `https://r.example/r/${room}#k=${roomKey(room)}&o=${t}`);

  const seq = (names: string[]) => { let i = 0; return () => names[i++ % names.length]!; };
  const taken = new Set(["maple-00000001", "maple-00000002"]);
  check("allocateRoomName skips taken (live or ended) names", allocateRoomName((n) => taken.has(n), seq(["maple-00000001", "maple-00000002", "maple-00000003"])) === "maple-00000003");
  check("allocateRoomName gives up with '' when every candidate is taken", allocateRoomName(() => true, seq(["maple-00000001"]), 5) === "");

  check("cleanBy keeps a handle, drops anything else", cleanBy("dev") === "dev" && cleanBy("Dev Gadde") === undefined && cleanBy("x".repeat(33)) === undefined && cleanBy(42) === undefined && cleanBy("") === undefined);
  const r = cleanReason("done\nfor today " + "y".repeat(200));
  check("cleanReason flattens control chars and caps at 140", r !== undefined && r.length <= 140 && !r.includes("\n") && r.startsWith("done for today"), r);
  check("cleanReason drops empty / non-strings", cleanReason("   ") === undefined && cleanReason(null) === undefined);

  const store = createFileStore();
  store.put("a-room", { name: "x", mime: "text/plain", from: "u", bytes: Buffer.from("x") });
  store.put("a-room", { name: "y", mime: "text/plain", from: "u", bytes: Buffer.from("yy") });
  const keep = store.put("b-room", { name: "z", mime: "text/plain", from: "u", bytes: Buffer.from("zzz") });
  check("files.purgeRoom drops only that room's artifacts", store.purgeRoom("a-room") === 2 && store.stats().count === 1 && store.stats().totalBytes === 3 && !!store.get("b-room", keep.id));
}

async function enforced(): Promise<void> {
  console.log("relay: end a session");
  const { child, http, ws } = await startRelay({ ROOM_SECRET: "test-secret", MESH_REQUIRE_KEY: "1" });
  try {
    // --- create: the owner token is returned only here
    const created = await fetch(`${http}/api/rooms`, { method: "POST" });
    const body = (await created.json()) as { room: string; key: string; link: string; ownerToken: string; ownerLink: string };
    const room = body.room, key = body.key, owner = body.ownerToken;
    check("POST /api/rooms → 201 { room, key, link, ownerToken, ownerLink }", created.status === 201 && OWNER_RE.test(owner) && body.link === `${http}/r/${room}#k=${key}` && body.ownerLink === `${http}/r/${room}#k=${key}&o=${owner}`, body);
    check("the returned owner token is the room's (and not its key)", owner === ownerToken(room) && owner !== key);
    const stateRaw = await (await fetch(`${http}/api/rooms/${room}?key=${key}`)).text();
    check("GET /api/rooms/:room never includes the owner token", !stateRaw.includes(owner) && !stateRaw.includes("ownerToken"), stateRaw);

    // --- a second room that must be unaffected
    const other = "other-room";
    const otherKey = roomKey(other);

    const a = await connect(ws, room, "alice", key);
    const b = await connect(ws, room, "bob", key);
    const c = await connect(ws, room, "carol", key);
    const o = await connect(ws, other, "olga", otherKey);
    await sleep(200);
    const up = await fetch(`${http}/api/files/${room}`, { method: "POST", body: "hello", headers: { "x-mesh-name": "a.txt", "x-mesh-key": key } });
    const upBody = (await up.json()) as { url: string };
    const upOther = (await (await fetch(`${http}/api/files/${other}`, { method: "POST", body: "keep", headers: { "x-mesh-name": "k.txt", "x-mesh-key": otherKey } })).json()) as { url: string };

    // --- refusals
    const end = (r: string, init: { key?: string; owner?: string; body?: unknown; ownerInBody?: boolean } = {}) =>
      fetch(`${http}/api/rooms/${r}/end${init.key !== undefined ? `?key=${init.key}` : ""}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(init.owner !== undefined && !init.ownerInBody ? { "x-mesh-owner": init.owner } : {}) },
        body: JSON.stringify({ ...(init.body as object ?? {}), ...(init.ownerInBody ? { owner: init.owner } : {}) }),
      });
    const bad = await end("Bad_Room", { key, owner });
    check("end: bad room name → 400", bad.status === 400, bad.status);
    const noKey = await end(room, { owner });
    check("end: no key → 401", noKey.status === 401, noKey.status);
    const wrongKey = await end(room, { key: "a".repeat(16), owner });
    check("end: wrong key → 401", wrongKey.status === 401 && (await wrongKey.json()).error === "wrong room key", wrongKey.status);
    const noOwner = await end(room, { key });
    const noOwnerBody = (await noOwner.json()) as { error: string };
    check("end: no owner token → 403 with the message", noOwner.status === 403 && noOwnerBody.error === "only the person who started this session can end it", { s: noOwner.status, noOwnerBody });
    const wrongOwner = await end(room, { key, owner: "b".repeat(16) });
    check("end: wrong owner token → 403", wrongOwner.status === 403, wrongOwner.status);
    const keyAsOwner = await end(room, { key, owner: key });
    check("end: the room key is not an owner token → 403", keyAsOwner.status === 403, keyAsOwner.status);
    await sleep(100);
    check("refused ends leave every socket open", a.isOpen() && b.isOpen() && c.isOpen());

    // --- the real end
    const ok = await end(room, { key, owner, body: { by: "dev", reason: "demo over" } });
    const okBody = (await ok.json()) as Record<string, unknown>;
    check("end: owner token in x-mesh-owner → 200 { ok, room, ended, closed: 3 }", ok.status === 200 && okBody.ok === true && okBody.room === room && okBody.ended === true && okBody.closed === 3 && !("alreadyEnded" in okBody), okBody);
    for (const cl of [a, b, c]) {
      const res = await withTimeout(cl.closed, 3000, { code: 0, reason: "timeout" });
      const frame = cl.frames.find((f) => f.type === "room_ended");
      check(`${cl === a ? "alice" : cl === b ? "bob" : "carol"} got room_ended { room, by, message, ts } then close 4410`,
        !!frame && frame.room === room && frame.by === "dev" && frame.message === "dev ended the session: demo over" && typeof frame.ts === "string" && res.code === 4410 && res.reason === "dev ended the session: demo over",
        { frame, res });
    }

    // --- tombstone
    const re = await wsTry(ws, `room=${room}&user=alice&role=daemon&key=${key}`);
    check("reconnect to an ended room → error frame + close 4410", re.code === 4410 && re.frames.some((f) => f.type === "error" && f.message === "this session was ended by its owner"), re);
    const reWrong = await wsTry(ws, `room=${room}&user=alice&role=daemon&key=${"a".repeat(16)}`);
    check("a wrong key on an ended room is still 4401 first", reWrong.code === 4401, reWrong.code);
    const gone = await fetch(`${http}/api/rooms/${room}?key=${key}`);
    const goneBody = (await gone.json()) as Record<string, unknown>;
    check("GET /api/rooms/:room → 410 { error, ended: true }", gone.status === 410 && goneBody.ended === true && goneBody.error === "this session was ended by its owner", { s: gone.status, goneBody });
    check("GET /api/rooms/:room on an ended room without a key → 401 (key first)", (await fetch(`${http}/api/rooms/${room}`)).status === 401);
    check("the ended room's artifact → 410", (await fetch(`${upBody.url}?key=${key}`)).status === 410);
    check("uploading to the ended room → 410", (await fetch(`${http}/api/files/${room}`, { method: "POST", body: "x", headers: { "x-mesh-key": key } })).status === 410);
    const again = await end(room, { key, owner, ownerInBody: true });
    const againBody = (await again.json()) as Record<string, unknown>;
    check("second end (owner token in the JSON body) → 200 { alreadyEnded: true, closed: 0 }", again.status === 200 && againBody.alreadyEnded === true && againBody.closed === 0 && againBody.ended === true, againBody);
    const health = (await (await fetch(`${http}/health`)).json()) as { endedRooms?: number };
    check("/health reports endedRooms", health.endedRooms === 1, health);

    // --- other rooms unaffected
    await sleep(100);
    check("a socket in another room stays open and got no room_ended", o.isOpen() && !o.frames.some((f) => f.type === "room_ended"));
    check("GET the other room → 200", (await fetch(`${http}/api/rooms/${other}?key=${otherKey}`)).status === 200);
    check("the other room's artifact survives", (await fetch(`${upOther.url}?key=${otherKey}`)).status === 200);
    o.ws.close();

    // --- by-less end on a fresh room (nobody connected)
    const r2 = (await (await fetch(`${http}/api/rooms`, { method: "POST" })).json()) as { room: string; key: string; ownerToken: string };
    const d = await connect(ws, r2.room, "dora", r2.key);
    const ok2 = await fetch(`${http}/api/rooms/${r2.room}/end`, { method: "POST", headers: { "x-mesh-key": r2.key, "x-mesh-owner": r2.ownerToken } });
    const ok2Body = (await ok2.json()) as { closed: number };
    const d2 = await withTimeout(d.closed, 3000, { code: 0, reason: "timeout" });
    const f2 = d.frames.find((f) => f.type === "room_ended");
    check("end with no body → 'the host ended the session', no by", ok2.status === 200 && ok2Body.closed === 1 && !!f2 && f2.message === "the host ended the session" && !("by" in f2) && d2.code === 4410, { ok2Body, f2, d2 });
    const junk = (await (await fetch(`${http}/api/rooms`, { method: "POST" })).json()) as { room: string; key: string; ownerToken: string };
    const junkRes = await fetch(`${http}/api/rooms/${junk.room}/end?key=${junk.key}`, { method: "POST", headers: { "x-mesh-owner": junk.ownerToken }, body: "not json" });
    check("a non-JSON body with the owner header still ends (200)", junkRes.status === 200, junkRes.status);

    // --- join.cmd / join.command bake --owner
    const cmd = await (await fetch(`${http}/join.cmd?room=${other}&key=${otherKey}&owner=${ownerToken(other)}&as=dev`)).text();
    check("/join.cmd bakes --owner", cmd.includes(`--owner ${ownerToken(other)}`) && cmd.includes(`--key ${otherKey}`) && cmd.includes("--as dev"), cmd);
    const command = await (await fetch(`${http}/join.command?room=${other}&key=${otherKey}&owner=${ownerToken(other)}`)).text();
    check("/join.command bakes --owner", command.includes(`--owner ${ownerToken(other)}`), command);
    const junkOwner = await (await fetch(`${http}/join.cmd?room=${other}&key=${otherKey}&owner=nope`)).text();
    check("/join.cmd ignores a malformed owner token", !junkOwner.includes("--owner"), junkOwner);
    const sh = await (await fetch(`${http}/install.sh`)).text();
    check("install.sh forwards extra args (so --owner reaches mesh join)", (sh.match(/join "\$ROOM" --relay "\$RELAY"[^\n]*"\$@"/g) ?? []).length >= 3);
    const ps1 = await (await fetch(`${http}/install.ps1`)).text();
    check("install.ps1 forwards extra args (@Rest)", ps1.includes("--background @Rest"));

    // --- pages still parse
    for (const [what, url] of [["landing", `${http}/`], ["room page", `${http}/r/${other}`]] as const) {
      const res = await fetch(url);
      const html = await res.text();
      const script = html.split("<script>").pop()!.split("</script>")[0]!;
      let parsed = false;
      try { new Function(script); parsed = true; } catch (e) { console.log(`      ${what} parse error: ${(e as Error).message}`); }
      check(`${what} → 200 and its script parses`, res.status === 200 && parsed);
    }
    const roomHtml = await (await fetch(`${http}/r/${other}`)).text();
    check("room page: owner token from #o=, stored as mesh.owner.<room>, scrubbed with replaceState", roomHtml.includes("ownerFromHash(location.hash)") && roomHtml.includes('"mesh.owner." + ROOM') && roomHtml.includes("history.replaceState"));
    check("room page: owner-only two-step End session button + creator line", roomHtml.includes("End session for everyone") && roomHtml.includes("Click again to end it for everyone") && roomHtml.includes("You started this session, so only you can end it."));
    check("room page: --owner in the creator's commands and downloads", roomHtml.includes('" --owner " + OWNER') && roomHtml.includes('"&owner=" + encodeURIComponent(OWNER)'));
    check("room page: 410 stops polling and shows 'This session has ended'", roomHtml.includes("res.status === 410") && roomHtml.includes("This session has ended") && roomHtml.includes("Start a new session"));
    check("landing redirects the creator to the owner link", roomHtml.includes('"&o=" + r.ownerToken'));
    const js = await (await fetch(`${http}/overlay.js`)).text();
    let parsed = false;
    try { new Function(js); parsed = true; } catch (e) { console.log(`      overlay.js parse error: ${(e as Error).message}`); }
    check("/overlay.js parses", parsed);
    check("overlay: end button driven by /health owner, POST /end, stops on 410", js.includes("h.owner === true") && js.includes('"/end"') && js.includes("e.status === 410"));
    const ovHtml = await (await fetch(`${http}/overlay?room=${other}`)).text();
    const ovScripts = ovHtml.split("<script>").slice(1).map((s) => s.split("</script>")[0]!);
    let ovParsed = ovScripts.length === 2;
    for (const s of ovScripts) { try { new Function(s); } catch (e) { ovParsed = false; console.log(`      overlay page parse error: ${(e as Error).message}`); } }
    check("/overlay page → scripts parse", ovParsed);
  } finally {
    child.kill("SIGTERM");
  }
}

async function openRelay(): Promise<void> {
  console.log("relay: MESH_REQUIRE_KEY=0 + tombstone TTL");
  const { child, http, ws } = await startRelay({ ROOM_SECRET: "test-secret", MESH_REQUIRE_KEY: "0", MESH_ENDED_TTL_MS: "600" });
  try {
    const room = "open-end";
    const noOwner = await fetch(`${http}/api/rooms/${room}/end`, { method: "POST" });
    check("keys off: end without an owner token is still 403", noOwner.status === 403, noOwner.status);
    const ok = await fetch(`${http}/api/rooms/${room}/end`, { method: "POST", headers: { "x-mesh-owner": ownerToken(room) } });
    check("keys off: end with the owner token (no key) → 200", ok.status === 200, ok.status);
    const re = await wsTry(ws, `room=${room}&user=a&role=daemon`);
    check("keys off: reconnect → 4410", re.code === 4410, re.code);
    await sleep(800);
    check("after MESH_ENDED_TTL_MS the tombstone expires (GET → 200)", (await fetch(`${http}/api/rooms/${room}`)).status === 200);
  } finally {
    child.kill("SIGTERM");
  }
}

async function main(): Promise<void> {
  unit();
  await enforced();
  await openRelay();
  console.log(failures === 0 ? "\nPASS" : `\nFAIL (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("FAIL", e);
  process.exit(1);
});
