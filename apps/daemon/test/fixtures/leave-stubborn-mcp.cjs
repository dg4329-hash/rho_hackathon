// leave.test.ts G: a minimal stdio MCP server that ignores SIGTERM and stdin EOF. argv[2] = pid file.
const fs = require("fs");
fs.writeFileSync(process.argv[2], String(process.pid));
process.on("SIGTERM", () => {});
setInterval(() => {}, 1 << 30);
process.stdin.on("end", () => {});
process.stdin.on("error", () => {});
process.stdout.on("error", () => {});
let buf = "";
process.stdin.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    let m;
    try { m = JSON.parse(line); } catch { continue; }
    if (m.id === undefined) continue;
    let result = {};
    if (m.method === "initialize") result = { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "stubborn", version: "1" } };
    else if (m.method === "tools/list") result = { tools: [{ name: "ping", description: "ping", inputSchema: { type: "object", properties: {} } }] };
    try { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result }) + "\n"); } catch {}
  }
});
