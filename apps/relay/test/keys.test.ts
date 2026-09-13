/**
 * Room-key tests (docs/ROOM-KEYS.md).
 *   pnpm -F relay test
 *
 * Part 1: key derivation under a fixed ROOM_SECRET (deterministic, base32lower, 16 chars) + timing-safe verify.
 * Part 2: the real relay with ROOM_SECRET=test-secret and enforcement ON — ws 4401 without/with a wrong key,
 *         /api/rooms 401/200, files 401/201/200, POST /api/rooms → { room, key, link }, /join.cmd bakes --key,
 *         public routes stay public, and the served page scripts still parse.
 * Part 3: the same relay with MESH_REQUIRE_KEY=0 — nothing is gated, but /api/rooms still hands out a key.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

process.env.ROOM_SECRET = "test-secret";
process.env.MESH_REQUIRE_KEY = "1";
const { base32lower, roomKey, verifyKey, requireKey, roomLink, KEY_RE } = await import("../src/keys.js");

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

interface WsResult { frames: Record<string, unknown>[]; code: number; reason: string; opened: boolean }

/** Connect, collect frames until close (or 1.5 s of silence), then report. */
function wsTry(url: string, query: string): Promise<WsResult> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`${url}/?${query}`);
    const frames: Record<string, unknown>[] = [];
    let opened = false;
    const done = (code: number, reason: string) => resolve({ frames, code, reason, opened });
    const timer = setTimeout(() => { try { ws.close(); } catch { /* ignore */ } done(0, "timeout"); }, 1500);
    ws.on("open", () => { opened = true; });
    ws.on("message", (d) => { try { frames.push(JSON.parse(d.toString())); } catch { /* ignore */ } });
    ws.on("close", (code, reason) => { clearTimeout(timer); done(code, reason.toString()); });
    ws.on("error", () => { /* close follows */ });
  });
}

function unit(): void {
  console.log("key derivation");
  check("base32lower uses the RFC 4648 alphabet, lowercase, no padding", base32lower(Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff])) === "77777777" && base32lower(Buffer.from([0])) === "aa", [base32lower(Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff])), base32lower(Buffer.from([0]))]);
  const k = roomKey("otter-1234");
  check("key is 16 chars of [a-z2-7]", KEY_RE.test(k), k);
  check("key is deterministic under a fixed ROOM_SECRET", roomKey("otter-1234") === k && k === "zihi6gueqkwcg7un", k);
  check("different rooms get different keys", roomKey("otter-1235") !== k);
  check("verifyKey accepts the right key", verifyKey("otter-1234", k));
  check("verifyKey rejects a wrong key of the same length", !verifyKey("otter-1234", "a".repeat(16)));
  check("verifyKey rejects a wrong-length key / null / empty", !verifyKey("otter-1234", "short") && !verifyKey("otter-1234", null) && !verifyKey("otter-1234", ""));
  check("requireKey defaults to true, off only for '0'", requireKey({} as NodeJS.ProcessEnv) && requireKey({ MESH_REQUIRE_KEY: "1" } as NodeJS.ProcessEnv) && !requireKey({ MESH_REQUIRE_KEY: "0" } as NodeJS.ProcessEnv));
  check("roomLink puts the key in the fragment", roomLink("https://relay.example", "otter-1234", k) === `https://relay.example/r/otter-1234#k=${k}`, roomLink("https://relay.example", "otter-1234", k));
}

async function startRelay(env: Record<string, string>): Promise<{ child: ChildProcess; port: number }> {
  const port = await freePort();
  const here = path.dirname(fileURLToPath(import.meta.url));
  const child = spawn(process.execPath, ["--import", "tsx", path.join(here, "..", "src", "index.ts")], {
    env: { ...process.env, PORT: String(port), ...env },
    stdio: ["ignore", "pipe", "inherit"],
  });
  await new Promise<void>((resolve, reject) => {
    child.stdout!.on("data", (d: Buffer) => { if (d.toString().includes("listening")) resolve(); });
    child.once("exit", (code) => reject(new Error(`relay exited early (${code})`)));
  });
  return { child, port };
}

async function enforced(): Promise<void> {
  console.log("relay with keys enforced");
  const { child, port } = await startRelay({ ROOM_SECRET: "test-secret", MESH_REQUIRE_KEY: "1" });
  const http = `http://127.0.0.1:${port}`;
  const ws = `ws://127.0.0.1:${port}`;
  const room = "keys-test";
  const key = roomKey(room);
  try {
    // --- POST /api/rooms → { room, key, link }
    const created = await fetch(`${http}/api/rooms`, { method: "POST" });
    const body = (await created.json()) as { room: string; key: string; link: string };
    check("POST /api/rooms → 201 { room, key, link }", created.status === 201 && KEY_RE.test(body.key) && body.link === `${http}/r/${body.room}#k=${body.key}`, body);
    check("the returned key is the room's key", body.key === roomKey(body.room), body);

    // --- WebSocket
    const noKey = await wsTry(ws, `room=${room}&user=a&role=daemon`);
    check("ws without a key → error frame 'room key required'", noKey.frames.some((f) => f.type === "error" && f.message === "room key required"), noKey.frames);
    check("ws without a key → close 4401", noKey.code === 4401, { code: noKey.code, reason: noKey.reason });
    const wrong = await wsTry(ws, `room=${room}&user=a&role=daemon&key=${"a".repeat(16)}`);
    check("ws with a wrong key → error frame 'wrong room key'", wrong.frames.some((f) => f.type === "error" && f.message === "wrong room key"), wrong.frames);
    check("ws with a wrong key → close 4401", wrong.code === 4401, { code: wrong.code, reason: wrong.reason });

    const good = new WebSocket(`${ws}/?room=${room}&user=a&role=daemon&key=${key}`);
    const frames: Record<string, unknown>[] = [];
    let closedCode = 0;
    good.on("message", (d) => { try { frames.push(JSON.parse(d.toString())); } catch { /* ignore */ } });
    good.on("close", (c) => { closedCode = c; });
    await new Promise<void>((resolve, reject) => { good.on("open", () => resolve()); good.on("error", reject); });
    good.send(JSON.stringify({ type: "hello", from: "a", ts: new Date().toISOString(), role: "daemon", offers: [] }));
    await sleep(200);
    check("ws with the right key stays open and gets presence", closedCode === 0 && frames.some((f) => f.type === "presence" && Array.isArray(f.members) && (f.members as { user: string }[]).some((m) => m.user === "a")), { closedCode, frames });

    // --- GET /api/rooms/:room
    const r401 = await fetch(`${http}/api/rooms/${room}`);
    check("GET /api/rooms/:room without a key → 401 'room key required'", r401.status === 401 && (await r401.json()).error === "room key required", r401.status);
    const rBad = await fetch(`${http}/api/rooms/${room}?key=${"a".repeat(16)}`);
    check("GET /api/rooms/:room with a wrong key → 401 'wrong room key'", rBad.status === 401 && (await rBad.json()).error === "wrong room key", rBad.status);
    const rOk = await fetch(`${http}/api/rooms/${room}?key=${key}`);
    const rOkBody = (await rOk.json()) as { members: { user: string }[] };
    check("GET /api/rooms/:room with the key → 200 with members", rOk.status === 200 && rOkBody.members.some((m) => m.user === "a"), rOkBody);
    const rHdr = await fetch(`${http}/api/rooms/${room}`, { headers: { "x-mesh-key": key } });
    check("the x-mesh-key header works too", rHdr.status === 200, rHdr.status);
    good.close();

    // --- files
    const up401 = await fetch(`${http}/api/files/${room}`, { method: "POST", body: "hello", headers: { "x-mesh-name": "a.txt" } });
    check("POST /api/files/:room without a key → 401", up401.status === 401 && (await up401.json()).error === "room key required", up401.status);
    const up = await fetch(`${http}/api/files/${room}`, { method: "POST", body: "hello", headers: { "x-mesh-name": "a.txt", "x-mesh-key": key } });
    const upBody = (await up.json()) as { id: string; url: string };
    check("POST /api/files/:room with the key → 201", up.status === 201 && typeof upBody.id === "string", upBody);
    check("GET the artifact without a key → 401", (await fetch(upBody.url)).status === 401);
    check("GET …/meta without a key → 401", (await fetch(`${http}/api/files/${room}/${upBody.id}/meta`)).status === 401);
    check("GET the artifact with ?key= → 200", (await fetch(`${upBody.url}?key=${key}`)).status === 200);
    check("GET the artifact with x-mesh-key → 200", (await fetch(upBody.url, { headers: { "x-mesh-key": key } })).status === 200);
    check("GET …/meta with the key → 200", (await fetch(`${http}/api/files/${room}/${upBody.id}/meta?key=${key}`)).status === 200);
    check("a wrong key on files → 401", (await fetch(`${upBody.url}?key=${"a".repeat(16)}`)).status === 401);
    check("OPTIONS preflight is never gated", (await fetch(`${http}/api/files/${room}`, { method: "OPTIONS" })).status === 204);

    // --- public routes stay public
    check("/health is public", (await fetch(`${http}/health`)).status === 200);
    check("/ is public", (await fetch(`${http}/`)).status === 200);
    check("/install.sh is public", (await fetch(`${http}/install.sh`)).status === 200);
    check("/install.ps1 is public", (await fetch(`${http}/install.ps1`)).status === 200);
    check("/r/:room is public HTML", (await fetch(`${http}/r/${room}`)).status === 200);
    check("/overlay is public HTML", (await fetch(`${http}/overlay?room=${room}`)).status === 200);
    check("/overlay.js is public", (await fetch(`${http}/overlay.js`)).status === 200);

    // --- join.cmd / join.command bake --key
    const cmd = await (await fetch(`${http}/join.cmd?room=${room}&key=${key}&as=dev`)).text();
    check("/join.cmd bakes --key and --as", cmd.includes(`--key ${key}`) && cmd.includes("--as dev"), cmd.split("\r\n")[3]);
    const command = await (await fetch(`${http}/join.command?room=${room}&key=${key}`)).text();
    check("/join.command bakes --key", command.includes(`--key ${key}`), command);
    const noKeyCmd = await (await fetch(`${http}/join.cmd?room=${room}`)).text();
    check("/join.cmd without a key bakes no --key", !noKeyCmd.includes("--key"), noKeyCmd);
    const junkKeyCmd = await (await fetch(`${http}/join.cmd?room=${room}&key=not%20a%20key`)).text();
    check("/join.cmd ignores a malformed key", !junkKeyCmd.includes("--key"), junkKeyCmd);
  } finally {
    child.kill("SIGTERM");
  }
}

async function pages(): Promise<void> {
  console.log("served scripts");
  const { child, port } = await startRelay({ ROOM_SECRET: "test-secret", MESH_REQUIRE_KEY: "1" });
  const http = `http://127.0.0.1:${port}`;
  try {
    for (const [what, url] of [["landing", `${http}/`], ["room page", `${http}/r/keys-test`]] as const) {
      const html = await (await fetch(url)).text();
      const script = html.split("<script>").pop()!.split("</script>")[0]!;
      let parsed = false;
      try { new Function(script); parsed = true; } catch (e) { console.log(`      ${what} parse error: ${(e as Error).message}`); }
      check(`${what} script parses (new Function)`, parsed);
    }
    const roomHtml = await (await fetch(`${http}/r/keys-test`)).text();
    check("room page reads the key from the fragment and remembers it", roomHtml.includes("keyFromHash(location.hash)") && roomHtml.includes('"mesh.key." + ROOM'), false);
    check("room page bakes --key into the one-liner", roomHtml.includes('" --key " + KEY'), false);
    check("room page shows the share warning", roomHtml.includes("Anyone with this link can join"), false);
    check("room page has the paste-the-link box when there is no key", roomHtml.includes("Paste the room link"), false);
    check("landing has a join box", roomHtml.includes('id="jlink"'), false);
    check("pop-out passes the key to the overlay", roomHtml.includes('"#k=" + KEY') && roomHtml.includes("key: KEY"), false);
    const js = await (await fetch(`${http}/overlay.js`)).text();
    let parsed = false;
    try { new Function(js); parsed = true; } catch (e) { console.log(`      overlay.js parse error: ${(e as Error).message}`); }
    check("/overlay.js parses (new Function)", parsed);
  } finally {
    child.kill("SIGTERM");
  }
}

async function disabled(): Promise<void> {
  console.log("relay with MESH_REQUIRE_KEY=0");
  const { child, port } = await startRelay({ ROOM_SECRET: "test-secret", MESH_REQUIRE_KEY: "0" });
  const http = `http://127.0.0.1:${port}`;
  const ws = `ws://127.0.0.1:${port}`;
  const room = "open-room";
  try {
    const res = await wsTry(ws, `room=${room}&user=a&role=daemon`);
    check("ws without a key connects", res.opened && res.code !== 4401, { opened: res.opened, code: res.code });
    check("GET /api/rooms/:room without a key → 200", (await fetch(`${http}/api/rooms/${room}`)).status === 200);
    const up = await fetch(`${http}/api/files/${room}`, { method: "POST", body: "hi" });
    const upBody = (await up.json()) as { url: string };
    check("files without a key → 201 + 200", up.status === 201 && (await fetch(upBody.url)).status === 200, up.status);
    const created = (await (await fetch(`${http}/api/rooms`, { method: "POST" })).json()) as { room: string; key: string; link: string };
    check("POST /api/rooms still returns a key + link", KEY_RE.test(created.key) && created.link.includes("#k="), created);
  } finally {
    child.kill("SIGTERM");
  }
}

async function main(): Promise<void> {
  unit();
  await enforced();
  await pages();
  await disabled();
  console.log(failures === 0 ? "\nPASS" : `\nFAIL (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("FAIL", e);
  process.exit(1);
});
