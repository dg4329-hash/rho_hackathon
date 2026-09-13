/**
 * Room keys (docs/ROOM-KEYS.md), daemon half, fully in-process: link parsing, keyed connect,
 * the no-key rejection path (error frame / 4401 → no reconnect loop → the CLI's exit 2),
 * the `x-mesh-key` header on artifact upload/download/meta, and switch_room into a keyed room.
 *   pnpm -F daemon exec tsx test/keys.test.ts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TeamConfig } from "@mesh/protocol";
import { createCore } from "../src/core.js";
import { createMcpImport } from "../src/mcp-import.js";
import { artifactMeta, downloadArtifact, uploadBytes } from "../src/artifacts.js";
import { keyFromLink, maskKey, parseRoomArg } from "../src/register.js";
import { RelayClient, ROOM_KEY_HELP, RoomKeyError, isRoomKeyError } from "../src/relay-client.js";
import { roomKey, startFakeRelay } from "./fake-relay.js";

let failures = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  console.log(`${ok ? "  ok  " : "  FAIL"} ${name}${ok || detail === undefined ? "" : `  → ${JSON.stringify(detail)}`}`);
  if (!ok) failures++;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(pred: () => boolean, ms = 3000): Promise<boolean> {
  const stop = Date.now() + ms;
  while (Date.now() < stop) {
    if (pred()) return true;
    await sleep(25);
  }
  return pred();
}
const caught = async (p: Promise<unknown>): Promise<Error | undefined> => p.then(() => undefined, (e: Error) => e);

const SECRET = "room-secret-for-tests";

function testLinkParsing(): void {
  console.log("link parsing");
  const a = parseRoomArg("https://relay.example/r/otter-5434#k=abcd1234wxyz");
  check("https room link with #k= → room, wss relay, key", a.room === "otter-5434" && a.relay === "wss://relay.example" && a.key === "abcd1234wxyz", a);
  const b = parseRoomArg("https://relay.example/r/otter-5434?k=abcd1234wxyz");
  check("?k= form", b.room === "otter-5434" && b.key === "abcd1234wxyz", b);
  const c = parseRoomArg("http://127.0.0.1:8080/r/room-1/?from=page&key=zzz9");
  check("&key= form (and ws:// for http)", c.room === "room-1" && c.relay === "ws://127.0.0.1:8080" && c.key === "zzz9", c);
  const d = parseRoomArg("wss://relay.example/otter-5434#k=frag");
  check("wss link without /r/", d.room === "otter-5434" && d.relay === "wss://relay.example" && d.key === "frag", d);
  const e = parseRoomArg("https://relay.example/r/otter-5434/#k=frag&other=1");
  check("trailing slash + extra fragment params", e.room === "otter-5434" && e.key === "frag", e);
  const f = parseRoomArg("https://relay.example/r/otter-5434");
  check("link without a key → no key", f.room === "otter-5434" && f.relay === "wss://relay.example" && f.key === undefined, f);
  const g = parseRoomArg("  otter-5434  ");
  check("bare room name → room only", g.room === "otter-5434" && g.relay === undefined && g.key === undefined, g);
  const h = parseRoomArg("https://relay.example/r/room-1?k=query#k=fragment");
  check("fragment wins over query", h.key === "fragment", h);
  check("keyFromLink on a bare name → undefined", keyFromLink("otter-5434") === undefined);
  check("maskKey never shows the key", maskKey("abcdefgh1234") === "k…1234" && maskKey(undefined) === "");
  check("isRoomKeyError matches both relay messages", isRoomKeyError("room key required") && isRoomKeyError("wrong room key") && !isRoomKeyError("nope"));
}

async function main(): Promise<void> {
  testLinkParsing();

  const relay = await startFakeRelay(0, { requireKey: true, secret: SECRET });
  const relayUrl = `ws://127.0.0.1:${relay.port}`;
  const room1 = `keys-${Date.now()}-1`;
  const room2 = `keys-${Date.now()}-2`;
  const room3 = `keys-${Date.now()}-3`;
  const key1 = roomKey(SECRET, room1);
  const key2 = roomKey(SECRET, room2);
  const key3 = roomKey(SECRET, room3);
  check("keys are 16 base32 chars", /^[a-z2-7]{16}$/.test(key1) && key1 !== key2, { key1, key2 });

  // ---------- connect ----------
  console.log("connect");
  const good = new RelayClient({ relay: relayUrl, room: room1, user: "a", offers: [], key: key1 });
  check("url carries &key=", good.url.includes(`key=${key1}`), good.url);
  const openErr = await caught(good.connect());
  check("connect with the right key → open", openErr === undefined, openErr?.message);

  const attemptsBefore = relay.wsAttempts();
  const naked = new RelayClient({ relay: relayUrl, room: room1, user: "b", offers: [] });
  let sawKeyEvent = "";
  naked.on("keyError", (m) => { sawKeyEvent = m; });
  const nakedErr = await caught(naked.connect());
  check("connect without a key → RoomKeyError", nakedErr instanceof RoomKeyError, nakedErr?.message);
  check("error message is the one the CLI prints (and exits 2 on)", nakedErr?.message === ROOM_KEY_HELP, nakedErr?.message);
  check("relay's own wording is kept", (nakedErr as RoomKeyError | undefined)?.relayMessage === "room key required", (nakedErr as RoomKeyError | undefined)?.relayMessage);
  check("keyError event fired (what cli.ts exits 2 on)", sawKeyEvent === "room key required", sawKeyEvent);
  await sleep(2600); // two backoff windows (1 s, 2 s) would have redialled by now
  check("no reconnect loop after a key rejection", relay.wsAttempts() === attemptsBefore + 1, { before: attemptsBefore, after: relay.wsAttempts() });
  check("client stays disconnected", naked.status() === "disconnected");

  const wrong = new RelayClient({ relay: relayUrl, room: room1, user: "c", offers: [], key: "not-the-key" });
  const wrongErr = await caught(wrong.connect());
  check("connect with a wrong key → RoomKeyError 'wrong room key'", wrongErr instanceof RoomKeyError && (wrongErr as RoomKeyError).relayMessage === "wrong room key", wrongErr?.message);

  // ---------- artifacts carry x-mesh-key ----------
  console.log("artifacts");
  const bytes = Buffer.from("keys are in the link\n");
  const art = await uploadBytes(relayUrl, room1, "a", "notes.txt", bytes, "text/plain", key1);
  check("upload with the key → artifact", art.name === "notes.txt" && art.size === bytes.length, art);
  check("relay saw x-mesh-key on the upload", relay.fileKeys().at(-1) === key1, relay.fileKeys().at(-1));
  const upErr = await caught(uploadBytes(relayUrl, room1, "a", "nope.txt", bytes, "text/plain"));
  check("upload without the key → rejected (401)", /401/.test(upErr?.message ?? ""), upErr?.message);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-keys-"));
  const dest = path.join(tmp, "notes.txt");
  const dl = await downloadArtifact(art.url, dest, key1);
  check("download with the key → bytes", dl.size === bytes.length && fs.readFileSync(dest, "utf8") === bytes.toString());
  check("relay saw x-mesh-key on the download", relay.fileKeys().at(-1) === key1);
  const dlErr = await caught(downloadArtifact(art.url, path.join(tmp, "x.txt")));
  check("download without the key → readable error", /needs its key/.test(dlErr?.message ?? ""), dlErr?.message);
  check("meta with the key → uploader", (await artifactMeta(art.url, key1))?.from === "a");
  check("meta without the key → undefined", (await artifactMeta(art.url)) === undefined);

  // ---------- core: send_file / fetch_artifact through a keyed room ----------
  console.log("core");
  const configA = TeamConfig.parse({ user: "a", room: room1, relay: relayUrl, key: key1 });
  const coreA = createCore({ config: configA, cwd: tmp, client: good, mcpImport: createMcpImport(), shellOffers: [], mcpOffers: [], quiet: true });
  fs.writeFileSync(path.join(tmp, "report.md"), "# report\n");
  const sent = await coreA.sendFile("all", "report.md", "have a look");
  check("send_file uploads through the keyed relay", sent.name === "report.md", sent);
  check("send_file carried x-mesh-key", relay.fileKeys().at(-1) === key1);
  const fetched = await coreA.fetchArtifact({ url: sent.url });
  check("fetch_artifact downloads with the key", fs.existsSync(fetched.path) && fetched.from === "a", fetched);

  // ---------- switch_room ----------
  console.log("switch_room");
  const switched = await coreA.switchRoom(`http://127.0.0.1:${relay.port}/r/${room2}#k=${key2}`);
  check("switch to a keyed room via its link", switched.room === room2 && configA.room === room2, switched);
  check("the new key is kept on the config", configA.key === key2);
  check("connected in the new room", await until(() => coreA.relayStatus() === "connected"));

  const witness = new RelayClient({ relay: relayUrl, room: room2, user: "w", offers: [], key: key2 });
  await witness.connect();
  check("a teammate in the new room sees us", await until(() => (witness.presence()?.members ?? []).some((m) => m.user === "a")));

  // No key given, same relay: the current key is carried over — and room3 refuses it ("wrong room key",
  // not "room key required": proof that we did send one).
  const carryErr = await caught(coreA.switchRoom(room3));
  check("switching without a key carries the current one (relay says 'wrong room key')", /wrong room key/.test(carryErr?.message ?? ""), carryErr?.message);
  check("the tool error is readable and names the room link", /needs its own room key/.test(carryErr?.message ?? "") && /#k=/.test(carryErr?.message ?? ""), carryErr?.message);
  check("we stayed in the old room", configA.room === room2 && configA.key === key2);
  check("and reconnected to it", await until(() => coreA.relayStatus() === "connected" && (witness.presence()?.members ?? []).some((m) => m.user === "a"), 5000), witness.presence()?.members);

  const ok3 = await coreA.switchRoom(`http://127.0.0.1:${relay.port}/r/${room3}#k=${key3}`);
  check("switch into a third keyed room with its link", ok3.room === room3 && configA.key === key3, ok3);

  witness.close();
  good.close();
  wrong.close();
  naked.close();
  await relay.close();
  fs.rmSync(tmp, { recursive: true, force: true });

  console.log(failures === 0 ? "\nPASS" : `\nFAIL (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("FAIL", e);
  process.exit(1);
});
