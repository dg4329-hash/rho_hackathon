/**
 * Artifacts end to end (docs/FILES-API.md), fully automated: fake relay with in-memory file routes,
 * owner core `a` (shell offer + imported fixture MCP server), requester core `b` with its local MCP server.
 *   pnpm -F daemon exec tsx test/artifacts.test.ts
 */
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { TeamConfig, type Offer } from "@mesh/protocol";
import { createCore } from "../src/core.js";
import { createLocalServer } from "../src/local-server.js";
import { createMcpImport } from "../src/mcp-import.js";
import { RelayClient } from "../src/relay-client.js";
import { resolvePermission } from "../src/permissions.js";
import { httpOrigin, mimeFor, scanOutputForFiles, uploadBytes, MAX_UPLOAD_BYTES } from "../src/artifacts.js";
import { startFakeRelay } from "./fake-relay.js";

/** Same 1x1 PNG the fixture server's `pixel` tool returns (not imported: that module connects stdio on load). */
const PIXEL_PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";

process.env.MESH_APPROVE = "tty"; // never a native dialog from a test

const here = path.dirname(fileURLToPath(import.meta.url));
let failures = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  console.log(`${ok ? "  ok  " : "  FAIL"} ${name}${ok || detail === undefined ? "" : `  → ${JSON.stringify(detail)}`}`);
  if (!ok) failures++;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise<number>((res, rej) => {
  const s = net.createServer();
  s.listen(0, () => { const p = (s.address() as net.AddressInfo).port; s.close(() => res(p)); });
  s.on("error", rej);
});
type Part = { type: string; text?: string; data?: string; mimeType?: string };
const partsOf = (r: { content: unknown }) => r.content as Part[];
const textOf = (r: { content: unknown }) => partsOf(r).filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n");
const firstJson = (r: { content: unknown }) => JSON.parse(partsOf(r).find((c) => c.type === "text")?.text ?? "{}");

function shellOffers(config: TeamConfig): Offer[] {
  return config.offers.map((o) => ({ kind: "command", name: o.name, description: o.description, permission: resolvePermission(o.name, config, o.permission) }));
}

function testPure(): void {
  console.log("artifacts helpers");
  check("httpOrigin wss → https", httpOrigin("wss://relay.example/") === "https://relay.example");
  check("httpOrigin ws → http", httpOrigin("ws://127.0.0.1:8080") === "http://127.0.0.1:8080");
  check("mimeFor png / unknown", mimeFor("a.PNG") === "image/png" && mimeFor("weird.xyz") === "application/octet-stream");
  const scanned = scanOutputForFiles("building…\nMESH_FILE: out/a.pdf\nPNG: shot.png\nPNG: not-a-png.txt\nMESH_FILE:  out/a.pdf \nnoise MESH_FILE: nope\n", "/work");
  check("scanOutputForFiles: MESH_FILE + PNG(.png only), anchored, deduped", JSON.stringify(scanned) === JSON.stringify(["/work/out/a.pdf", "/work/shot.png"]), scanned);
}

async function main(): Promise<void> {
  testPure();

  console.log("end to end");
  const relay = await startFakeRelay(0);
  const relayUrl = `ws://127.0.0.1:${relay.port}`;
  const room = `art-${Date.now()}`;
  const tmpA = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-art-a-"));
  const tmpB = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-art-b-"));
  const makeFile = path.join(here, "fixtures", "make-file.sh");

  // owner a: shell offer that prints MESH_FILE, plus the fixture MCP server (tool `pixel` returns an image part)
  const tsxBin = path.resolve(here, "../../../node_modules/.bin/tsx");
  const fixture = path.join(here, "fixture-server.ts");
  fs.writeFileSync(path.join(tmpA, ".mcp.json"), JSON.stringify({ mcpServers: { fixture: fs.existsSync(tsxBin) ? { command: tsxBin, args: [fixture] } : { command: "npx", args: ["tsx", fixture] } } }));
  const configA = TeamConfig.parse({
    user: "a", room, relay: relayUrl, timeoutSeconds: 10, allowArbitrary: "never",
    offers: [{ name: "make.file", command: makeFile, description: "Usage: make-file.sh <out.png>", permission: "always" }],
    import: { fromClaudeCode: true, fromCursor: false, servers: ["fixture"], defaultPermission: "always" },
  });
  const configB = TeamConfig.parse({ user: "b", room, relay: relayUrl });

  const realHome = process.env.HOME;
  process.env.HOME = tmpA; // keep the real ~/.claude.json out of the import
  const mcpA = createMcpImport();
  const imported = await mcpA.start(configA, tmpA);
  process.env.HOME = realHome;
  check("a imported fixture.pixel", imported.offers.some((o) => o.name === "fixture.pixel"), imported);

  const clientA = new RelayClient({ relay: relayUrl, room, user: "a", offers: [...shellOffers(configA), ...imported.offers] });
  const clientB = new RelayClient({ relay: relayUrl, room, user: "b", offers: [] });
  const a = createCore({ config: configA, cwd: tmpA, client: clientA, mcpImport: mcpA, shellOffers: shellOffers(configA), mcpOffers: imported.offers, quiet: true });
  const b = createCore({ config: configB, cwd: tmpB, client: clientB, mcpImport: createMcpImport(), shellOffers: [], mcpOffers: [], quiet: true });
  await Promise.all([clientA.connect(), clientB.connect()]);
  for (let i = 0; i < 50 && !b.members().some((m) => m.user === "a"); i++) await sleep(20);
  check("b sees a", b.members().some((m) => m.user === "a"));

  const portA = await freePort();
  const portB = await freePort();
  const serverA = createLocalServer();
  const serverB = createLocalServer();
  await serverA.start(a, portA);
  await serverB.start(b, portB);
  const mcpClientA = new Client({ name: "test-a", version: "0" });
  const mcpClientB = new Client({ name: "test-b", version: "0" });
  try {
    await mcpClientA.connect(new StreamableHTTPClientTransport(new URL(`http://localhost:${portA}/mcp`)));
    await mcpClientB.connect(new StreamableHTTPClientTransport(new URL(`http://localhost:${portB}/mcp`)));

    // 1. shell MESH_FILE → artifact on the result
    const outPng = path.join(tmpA, "shots", "pixel.png");
    const r1 = await b.ask({ who: "a", command: `make-file.sh ${outPng}`, why: "test", waitSeconds: 10 });
    check("MESH_FILE job completed exit 0", r1.status === "completed" && r1.exitCode === 0, r1);
    check("output still contains the MESH_FILE line (nothing stripped)", (r1.output ?? "").includes("MESH_FILE:"), r1.output);
    const art1 = r1.artifacts?.[0];
    check("result has exactly 1 artifact", r1.artifacts?.length === 1 && !r1.artifactErrors, r1.artifacts);
    check("artifact name/size/mime/url", art1?.name === "pixel.png" && art1.size === fs.statSync(outPng).size && art1.mime === "image/png" && art1.url.startsWith(`http://127.0.0.1:${relay.port}/api/files/`), art1);
    const relayHas = await fetch(art1!.url).then((r) => r.status);
    check("relay serves the artifact url", relayHas === 200, relayHas);

    // 2. check_job on the same job still carries the artifact
    const cj = await b.checkJob(r1.jobId, 0);
    check("check_job includes artifacts", cj.artifacts?.[0]?.id === art1?.id, cj);

    // 3. fetch_artifact by id via b's MCP server → file under mesh-artifacts/a/ + inline image part
    const f1 = await mcpClientB.callTool({ name: "fetch_artifact", arguments: { id: art1!.id } });
    const f1Obj = firstJson(f1);
    const expected = path.join(tmpB, "mesh-artifacts", "a", "pixel.png");
    check("fetch_artifact by id → path under <cwd>/mesh-artifacts/a/", !f1.isError && f1Obj.path === expected && fs.existsSync(expected), f1Obj);
    check("fetched bytes identical", fs.readFileSync(expected).equals(fs.readFileSync(outPng)));
    check("fetch_artifact returns {path,name,mime,size}", f1Obj.name === "pixel.png" && f1Obj.mime === "image/png" && f1Obj.size === art1!.size, f1Obj);
    const img = partsOf(f1).find((c) => c.type === "image");
    check("fetch_artifact returns an inline image part", !!img && img.mimeType === "image/png" && Buffer.from(img.data ?? "", "base64").equals(fs.readFileSync(outPng)), img && { ...img, data: (img.data ?? "").slice(0, 20) });

    // 4. fetch by url + saveAs; saveAs escaping cwd is refused
    const f2 = firstJson(await mcpClientB.callTool({ name: "fetch_artifact", arguments: { url: art1!.url, saveAs: "renamed.png" } }));
    check("fetch_artifact by url + saveAs", f2.path === path.join(tmpB, "mesh-artifacts", "a", "renamed.png") && fs.existsSync(f2.path), f2);
    const f3 = await mcpClientB.callTool({ name: "fetch_artifact", arguments: { id: art1!.id, saveAs: "../../../../escape.png" } });
    check("saveAs escaping cwd → isError", f3.isError === true && /outside/.test(textOf(f3)), textOf(f3));
    const f4 = await mcpClientB.callTool({ name: "fetch_artifact", arguments: { id: "nope" } });
    check("unknown id → isError", f4.isError === true && /no artifact/.test(textOf(f4)), textOf(f4));
    const f5 = await mcpClientB.callTool({ name: "fetch_artifact", arguments: {} });
    check("neither url nor id → isError", f5.isError === true);

    // 5. MESH_FILE naming a missing file: job still completes, artifactErrors explains
    const r5 = await b.ask({ who: "a", command: `make-file.sh ${path.join(tmpA, "ok.png")}`, why: "test", waitSeconds: 10 });
    check("second MESH_FILE job fine", r5.status === "completed" && r5.artifacts?.length === 1, r5);
    const fixtureMissing = path.join(tmpA, "missing.sh");
    fs.writeFileSync(fixtureMissing, "#!/bin/sh\necho 'MESH_FILE: does-not-exist.png'\n");
    fs.chmodSync(fixtureMissing, 0o755);
    // a second owner core whose only offer prints a MESH_FILE line for a file that doesn't exist
    const cfgMissing = TeamConfig.parse({ ...configA, offers: [{ name: "missing", command: fixtureMissing, description: "x", permission: "always" }] });
    const clientA2 = new RelayClient({ relay: relayUrl, room, user: "a2", offers: shellOffers(cfgMissing) });
    createCore({ config: { ...cfgMissing, user: "a2" }, cwd: tmpA, client: clientA2, mcpImport: createMcpImport(), shellOffers: shellOffers(cfgMissing), mcpOffers: [], quiet: true });
    await clientA2.connect();
    for (let i = 0; i < 50 && !b.members().some((m) => m.user === "a2"); i++) await sleep(20);
    const r5b = await b.ask({ who: "a2", command: "missing.sh", why: "test", waitSeconds: 10 });
    check("missing MESH_FILE target → completed, no artifacts, artifactErrors set", r5b.status === "completed" && r5b.exitCode === 0 && !r5b.artifacts && r5b.artifactErrors?.length === 1 && /no such file/.test(r5b.artifactErrors[0]!), r5b);
    clientA2.close();

    // 6. MCP image part → artifact named <tool>-<n>.<ext>
    const r6 = await b.ask({ who: "a", tool: "fixture.pixel", args: {}, why: "test", waitSeconds: 10 });
    check("fixture.pixel completed", r6.status === "completed" && r6.exitCode === 0, r6);
    check("text part still flattened into output", (r6.output ?? "").includes("here is your pixel") && (r6.output ?? "").includes("[image image/png]"), r6.output);
    const art6 = r6.artifacts?.[0];
    const pixelBytes = Buffer.from(PIXEL_PNG_B64, "base64").length;
    check("image part became an artifact fixture.pixel-1.png (image/png, right size)", r6.artifacts?.length === 1 && art6?.name === "fixture.pixel-1.png" && art6.mime === "image/png" && art6.size === pixelBytes, r6.artifacts);
    const f6 = await mcpClientB.callTool({ name: "fetch_artifact", arguments: { id: art6!.id } });
    check("fetching the tool artifact returns the image inline", partsOf(f6).some((c) => c.type === "image" && c.mimeType === "image/png"), partsOf(f6).map((c) => c.type));

    // 7. send_file a → b (text file: inbox gets the artifact; fetch returns text inline)
    const notes = path.join(tmpA, "notes.txt");
    fs.writeFileSync(notes, "line one\nline two\n");
    const s7 = await mcpClientA.callTool({ name: "send_file", arguments: { to: "b", path: "notes.txt", note: "read these" } });
    const s7Obj = firstJson(s7);
    check("send_file returns the artifact", !s7.isError && s7Obj.ok === true && s7Obj.artifact?.name === "notes.txt" && s7Obj.artifact?.mime === "text/plain", s7Obj);
    await sleep(200);
    const inbox = b.inbox({ unreadOnly: true, sinceMinutes: 5 });
    const msg = inbox.find((m) => m.artifact);
    check("b's inbox has the file message with artifact + note as text", !!msg && msg.from === "a" && msg.to === "b" && msg.text === "read these" && msg.artifact?.id === s7Obj.artifact.id, inbox);
    check("a's own inbox does not see it", !a.inbox({ unreadOnly: false, sinceMinutes: 5 }).some((m) => m.artifact));
    const f7 = await mcpClientB.callTool({ name: "fetch_artifact", arguments: { url: msg!.artifact!.url } });
    const f7Obj = firstJson(f7);
    check("fetch from inbox url → mesh-artifacts/a/notes.txt", f7Obj.path === path.join(tmpB, "mesh-artifacts", "a", "notes.txt") && fs.readFileSync(f7Obj.path, "utf8") === "line one\nline two\n", f7Obj);
    check("text artifact comes back as a second text part", partsOf(f7).filter((c) => c.type === "text").length === 2 && textOf(f7).includes("line two"), partsOf(f7).map((c) => c.type));

    // 7b. send_file to 'all' without a note → default text "sent <name> (<size>)"
    const s7b = await mcpClientA.callTool({ name: "send_file", arguments: { to: "all", path: notes } });
    check("send_file to all (absolute path inside cwd) ok", !s7b.isError, textOf(s7b));
    await sleep(200);
    const all = b.inbox({ unreadOnly: true, sinceMinutes: 5 }).find((m) => m.artifact && m.to === "all");
    check("default text is 'sent <name> (<size>)'", all?.text === "sent notes.txt (18 B)", all);
    const wp = await b.watchPoll(0);
    check("watchPoll messages carry artifact (already read here → none unread, shape ok)", Array.isArray(wp.messages), wp);

    // 8. send_file refuses paths outside cwd / ~/.mesh, missing files, and offline recipients
    const s8 = await mcpClientA.callTool({ name: "send_file", arguments: { to: "b", path: "/etc/hosts" } });
    check("send_file outside cwd → isError mentioning the project", s8.isError === true && /outside the project/.test(textOf(s8)), textOf(s8));
    const s8b = await mcpClientA.callTool({ name: "send_file", arguments: { to: "b", path: "nope.txt" } });
    check("send_file missing file → isError", s8b.isError === true && /no such file/.test(textOf(s8b)), textOf(s8b));
    const s8c = await mcpClientA.callTool({ name: "send_file", arguments: { to: "ghost", path: "notes.txt" } });
    check("send_file to offline teammate → isError", s8c.isError === true && /not online/.test(textOf(s8c)), textOf(s8c));
    check("nothing was written to a's tree by fetches", !fs.existsSync(path.join(tmpA, "mesh-artifacts")));

    // 9. activity shows the file event; 25 MB cap is client-side
    check("activity shows the file event", b.activity(5).some((e) => e.type === "file" && e.summary.includes("notes.txt")), b.activity(5).map((e) => e.summary));
    const big = new Uint8Array(MAX_UPLOAD_BYTES + 1);
    const capErr = await uploadBytes(relayUrl, room, "a", "big.bin", big).then(() => "", (e: Error) => e.message);
    check("uploadBytes refuses > 25 MB with a clear message", /25\.0 MB/.test(capErr) && /big\.bin/.test(capErr), capErr);
    const listB = await mcpClientB.listTools();
    check("send_file + fetch_artifact are registered", ["send_file", "fetch_artifact"].every((n) => listB.tools.some((t) => t.name === n)));
  } finally {
    await Promise.allSettled([mcpClientA.close(), mcpClientB.close()]);
    await Promise.allSettled([serverA.stop(), serverB.stop(), mcpA.stop()]);
    clientA.close();
    clientB.close();
    await relay.close();
    fs.rmSync(tmpA, { recursive: true, force: true });
    fs.rmSync(tmpB, { recursive: true, force: true });
  }

  console.log(failures === 0 ? "\nPASS" : `\nFAIL (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
}

const timer = setTimeout(() => { console.log("FAIL: test timed out"); process.exit(1); }, 90_000);
main().then(() => clearTimeout(timer)).catch((e) => {
  console.error("FAIL", e);
  process.exit(1);
});
