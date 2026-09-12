/**
 * Artifact store tests (docs/FILES-API.md "Relay").
 *   pnpm -F relay test        (runs relay.test.ts then this file)
 *
 * Part 1: unit checks on createFileStore with a fake clock (TTL, LRU eviction, room gating, 25 MB cap).
 * Part 2: the real relay (src/index.ts) on a free port with MESH_FILE_TTL_MS=400: upload → meta → download
 *         round-trip, headers, 413 on a 26 MB body, 404 on unknown room/id, TTL expiry, /overlay.js parses.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createFileStore, FileTooLargeError, cleanName, contentDisposition } from "../src/files.js";

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

// ---------- part 1: store unit checks (fake clock) ----------
function unit(): void {
  console.log("store unit checks");
  let t = 1_000_000;
  const now = () => t;
  const store = createFileStore({ maxFileBytes: 100, maxTotalBytes: 250, ttlMs: 1000, now });
  const buf = (n: number, fill = "x") => Buffer.alloc(n, fill);

  // cap per file
  let threw: unknown;
  try { store.put("r1", { name: "big", mime: "application/octet-stream", from: "a", bytes: buf(101) }); } catch (e) { threw = e; }
  check("put above maxFileBytes throws FileTooLargeError", threw instanceof FileTooLargeError);
  check("nothing stored after the rejected put", store.stats().count === 0, store.stats());

  // round-trip + room gating
  const m1 = store.put("r1", { name: "one.txt", mime: "text/plain", from: "a", bytes: buf(100, "1") });
  check("put returns meta with id/size/ts", /^[a-z0-9]{16}$/.test(m1.id) && m1.size === 100 && m1.ts === new Date(t).toISOString(), m1);
  check("get returns bytes for the right room", store.get("r1", m1.id)?.bytes.toString() === "1".repeat(100));
  check("get with the wrong room → undefined (room gating)", store.get("r2", m1.id) === undefined);
  check("meta with the wrong room → undefined", store.meta("r2", m1.id) === undefined);
  check("meta strips bytes", !("bytes" in (store.meta("r1", m1.id) as object)));

  // LRU eviction: total cap 250; three 100-byte files → the least recently *read* one goes
  const m2 = store.put("r1", { name: "two", mime: "text/plain", from: "a", bytes: buf(100, "2") });
  check("two files fit under the total cap", store.stats().count === 2 && store.stats().totalBytes === 200, store.stats());
  store.get("r1", m1.id); // bump m1 → m2 is now least recently used
  const m3 = store.put("r1", { name: "three", mime: "text/plain", from: "a", bytes: buf(100, "3") });
  check("third put evicts the least-recently-used entry (m2)", store.meta("r1", m2.id) === undefined && store.meta("r1", m1.id) !== undefined && store.meta("r1", m3.id) !== undefined, store.stats());
  check("total never exceeds maxTotalBytes", store.stats().totalBytes <= 250, store.stats());

  // TTL
  t += 999;
  check("entry still readable just before TTL", store.meta("r1", m1.id) !== undefined);
  t += 1;
  check("entry gone at TTL (read path)", store.meta("r1", m1.id) === undefined);
  t += 1;
  const swept = store.sweep();
  check("sweep drops the other expired entry", swept >= 1 && store.stats().count === 0, { swept, stats: store.stats() });

  // sweeper timer is unref'd and stoppable
  store.startSweeper(50); store.stopSweeper();
  check("startSweeper/stopSweeper do not throw", true);

  // name / disposition helpers
  check("cleanName strips paths + control chars", cleanName("../../etc/pass\x01wd.png") === "passwd.png", cleanName("../../etc/pass\x01wd.png"));
  check("cleanName decodes percent-encoding", cleanName("my%20file.png") === "my file.png");
  check("cleanName repairs a raw UTF-8 header Node decoded as latin1", cleanName(Buffer.from("héllo wörld.txt", "utf8").toString("latin1")) === "héllo wörld.txt", cleanName(Buffer.from("héllo wörld.txt", "utf8").toString("latin1")));
  check("cleanName leaves already-correct unicode alone", cleanName("日本語.png") === "日本語.png");
  check("cleanName empty → 'file'", cleanName("") === "file" && cleanName("..") === "file");
  check("contentDisposition ascii", contentDisposition("a b.png") === 'inline; filename="a b.png"', contentDisposition("a b.png"));
  check("contentDisposition utf-8 adds filename*", contentDisposition("héllo.png") === `inline; filename="h_llo.png"; filename*=UTF-8''h%C3%A9llo.png`, contentDisposition("héllo.png"));
}

// ---------- part 2: against the real relay ----------
async function integration(): Promise<void> {
  console.log("relay integration checks");
  const port = await freePort();
  const here = path.dirname(fileURLToPath(import.meta.url));
  const child: ChildProcess = spawn(process.execPath, ["--import", "tsx", path.join(here, "..", "src", "index.ts")], {
    env: { ...process.env, PORT: String(port), MESH_FILE_TTL_MS: "400" },
    stdio: ["ignore", "pipe", "inherit"],
  });
  await new Promise<void>((resolve, reject) => {
    child.stdout!.on("data", (d: Buffer) => { if (d.toString().includes("listening")) resolve(); });
    child.once("exit", (code) => reject(new Error(`relay exited early (${code})`)));
  });
  const base = `http://127.0.0.1:${port}`;
  const room = "files-test";
  try {
    // upload → meta → download
    const payload = Buffer.from("\x89PNG\r\n\x1a\n" + "pixels ".repeat(1000), "latin1");
    const up = await fetch(`${base}/api/files/${room}`, {
      method: "POST", body: payload,
      headers: { "x-mesh-name": "onboarding step2.png", "x-mesh-mime": "image/png", "x-mesh-from": "tarush", "content-type": "application/octet-stream" },
    });
    const upBody = (await up.json()) as { id: string; name: string; mime: string; size: number; url: string };
    check("POST /api/files/:room → 201", up.status === 201, { status: up.status, body: upBody });
    check("201 body has id/name/mime/size/url", typeof upBody.id === "string" && upBody.name === "onboarding step2.png" && upBody.mime === "image/png" && upBody.size === payload.length, upBody);
    check("url is absolute on this relay", upBody.url === `${base}/api/files/${room}/${upBody.id}`, upBody.url);
    check("POST reply has CORS *", up.headers.get("access-control-allow-origin") === "*");

    const meta = await fetch(`${base}/api/files/${room}/${upBody.id}/meta`);
    const metaBody = (await meta.json()) as Record<string, unknown>;
    check("GET …/meta → 200 { id, name, mime, size, from, ts }", meta.status === 200 && metaBody.id === upBody.id && metaBody.name === "onboarding step2.png" && metaBody.mime === "image/png" && metaBody.size === payload.length && metaBody.from === "tarush" && typeof metaBody.ts === "string", metaBody);

    const dl = await fetch(upBody.url);
    const bytes = Buffer.from(await dl.arrayBuffer());
    check("GET file → 200 with identical bytes", dl.status === 200 && bytes.equals(payload), { status: dl.status, len: bytes.length });
    check("content-type is the uploaded mime", dl.headers.get("content-type") === "image/png", dl.headers.get("content-type"));
    check("content-disposition inline + filename", dl.headers.get("content-disposition") === 'inline; filename="onboarding step2.png"', dl.headers.get("content-disposition"));
    check("cache-control private, max-age=3600", dl.headers.get("cache-control") === "private, max-age=3600", dl.headers.get("cache-control"));
    check("content-length set", Number(dl.headers.get("content-length")) === payload.length, dl.headers.get("content-length"));
    check("GET file has CORS *", dl.headers.get("access-control-allow-origin") === "*");
    check("sha256 round-trips", createHash("sha256").update(bytes).digest("hex") === createHash("sha256").update(payload).digest("hex"));

    const head = await fetch(upBody.url, { method: "HEAD" });
    check("HEAD file → 200 with content-length, no body", head.status === 200 && Number(head.headers.get("content-length")) === payload.length && (await head.arrayBuffer()).byteLength === 0);

    // defaults: no headers → application/octet-stream + name "file"
    const up2 = await fetch(`${base}/api/files/${room}`, { method: "POST", body: Buffer.from("hi") });
    const up2Body = (await up2.json()) as { id: string; name: string; mime: string };
    check("missing headers fall back to application/octet-stream / 'file'", up2.status === 201 && up2Body.mime === "application/octet-stream" && up2Body.name === "file", up2Body);

    // 404s
    check("unknown id → 404", (await fetch(`${base}/api/files/${room}/0123456789abcdef`)).status === 404);
    check("unknown id meta → 404", (await fetch(`${base}/api/files/${room}/0123456789abcdef/meta`)).status === 404);
    check("right id, wrong room → 404 (room gating)", (await fetch(`${base}/api/files/other-room/${upBody.id}`)).status === 404);
    check("malformed id → 404", (await fetch(`${base}/api/files/${room}/..%2F..`)).status === 404);
    check("bad room name on upload → 400", (await fetch(`${base}/api/files/BAD_ROOM!`, { method: "POST", body: "x" })).status === 400);
    check("empty upload → 400", (await fetch(`${base}/api/files/${room}`, { method: "POST", body: Buffer.alloc(0) })).status === 400);
    check("GET on the upload path → 405", (await fetch(`${base}/api/files/${room}`)).status === 405);

    // 413 on > 25 MB (26 MB body)
    const big = Buffer.alloc(26 * 1024 * 1024, 1);
    let bigStatus = 0;
    try {
      const r = await fetch(`${base}/api/files/${room}`, { method: "POST", body: big, headers: { "x-mesh-name": "big.bin" } });
      bigStatus = r.status;
      await r.text();
    } catch (e) {
      // undici may surface the early reset as a fetch error when the server answers before the body is fully sent
      bigStatus = -1;
      console.log(`      (26 MB upload fetch rejected: ${(e as Error).message})`);
    }
    check("26 MB upload → 413", bigStatus === 413, bigStatus);
    // same again without content-length (chunked) so the streaming limiter, not the header check, is exercised
    let chunkedStatus = 0;
    try {
      const stream = new ReadableStream<Uint8Array>({
        start(ctrl) { for (let i = 0; i < 26; i++) ctrl.enqueue(new Uint8Array(1024 * 1024)); ctrl.close(); },
      });
      const r = await fetch(`${base}/api/files/${room}`, { method: "POST", body: stream, duplex: "half", headers: { "x-mesh-name": "big.bin" } } as RequestInit);
      chunkedStatus = r.status;
      await r.text();
    } catch (e) {
      chunkedStatus = -1;
      console.log(`      (chunked 26 MB upload fetch rejected: ${(e as Error).message})`);
    }
    check("chunked 26 MB upload → 413 (or connection reset)", chunkedStatus === 413 || chunkedStatus === -1, chunkedStatus);
    check("relay still serves the earlier file after the 413s", (await fetch(upBody.url)).status === 200);

    // TTL (MESH_FILE_TTL_MS=400)
    await sleep(600);
    check("file → 404 after TTL", (await fetch(upBody.url)).status === 404);
    check("meta → 404 after TTL", (await fetch(`${base}/api/files/${room}/${upBody.id}/meta`)).status === 404);

    // /health untouched by the file store; /overlay.js still parses and exposes the chip helpers
    const health = (await (await fetch(`${base}/health`)).json()) as { rooms: number; connections: number };
    check("file uploads do not create rooms", health.rooms === 0 && health.connections === 0, health);
    const js = await (await fetch(`${base}/overlay.js`)).text();
    let parsed = false;
    try { new Function(js); parsed = true; } catch (e) { console.log(`      overlay.js parse error: ${(e as Error).message}`); }
    check("/overlay.js parses (new Function)", parsed);
    const sandbox: Record<string, unknown> = {};
    new Function("globalThis", "window", js.replace(/\(typeof globalThis !== "undefined" \? globalThis : this\);\s*$/, "(arguments[0]);"))(sandbox, undefined);
    const api = sandbox.meshOverlay as { feedLine(f: unknown): string | null; artifactChip(a: unknown): string; fmtSize(n: number): string } | undefined;
    check("overlay api exposes feedLine/artifactChip/fmtSize", Boolean(api && api.feedLine && api.artifactChip && api.fmtSize));
    if (api) {
      check("fmtSize", api.fmtSize(184 * 1024) === "184 KB" && api.fmtSize(500) === "500 B" && api.fmtSize(2.5 * 1024 * 1024) === "2.5 MB", [api.fmtSize(184 * 1024), api.fmtSize(500), api.fmtSize(2.5 * 1024 * 1024)]);
      const art = { id: "x", name: "a<b>.png", mime: "image/png", size: 184 * 1024, url: `${base}/api/files/${room}/x` };
      const chip = api.artifactChip(art);
      check("artifact chip links to url with target=_blank rel=noopener and escapes the name", chip.includes(`href="${base}/api/files/${room}/x"`) && chip.includes('target="_blank"') && chip.includes('rel="noopener"') && chip.includes("a&lt;b&gt;.png") && chip.includes("184 KB"), chip);
      check("javascript: url renders an unlinked chip", !api.artifactChip({ ...art, url: "javascript:alert(1)" }).includes("href="));
      const resLine = api.feedLine({ type: "result", from: "tarush", ts: new Date().toISOString(), exitCode: 0, durationMs: 1200, artifacts: [art] }) ?? "";
      check("result frame with artifacts renders a chip", resLine.includes('class="chip"') && resLine.includes("exit 0"), resLine);
      const fileLine = api.feedLine({ type: "event", kind: "file", from: "tarush", ts: new Date().toISOString(), summary: "sent a<b>.png", data: { to: "dev", artifact: art, note: "step 2" } }) ?? "";
      check("file event renders → to, note and a chip", fileLine.includes("→ dev") && fileLine.includes("step 2") && fileLine.includes('class="chip"'), fileLine);
      check("result frame without artifacts renders no chip", !(api.feedLine({ type: "result", from: "a", ts: "", exitCode: 0, durationMs: 0 }) ?? "").includes("chip"));
    }
    const page = await (await fetch(`${base}/r/${room}`)).text();
    check("room page carries the chip renderer", page.includes('class="chip"') && page.includes("f.kind === \"file\"") && page.includes("chips(f.artifacts)"));
  } finally {
    child.kill("SIGTERM");
  }
}

async function main(): Promise<void> {
  unit();
  await integration();
  console.log(failures === 0 ? "\nPASS" : `\nFAIL (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("FAIL", e);
  process.exit(1);
});
