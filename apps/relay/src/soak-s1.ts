/**
 * Local relay soak for S1 readiness: many output frames + late joiner.
 * Does not replace Dev's ask_teammate/check_job E2E (daemon still required).
 * Usage (relay already running): pnpm -F relay exec tsx src/soak-s1.ts
 */
import WebSocket from "ws";

const RELAY = process.env.RELAY_URL ?? "ws://localhost:8080";
const ROOM = "soak-s1";

function connect(user: string): Promise<{ ws: WebSocket; msgs: unknown[] }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${RELAY}/?room=${ROOM}&user=${user}&role=daemon`);
    const msgs: unknown[] = [];
    ws.on("open", () => resolve({ ws, msgs }));
    ws.on("message", (d) => {
      try {
        msgs.push(JSON.parse(d.toString()));
      } catch {
        msgs.push(d.toString());
      }
    });
    ws.on("error", reject);
  });
}

const a = await connect("owner");
const b = await connect("asker");
const hello = (from: string) =>
  JSON.stringify({
    type: "hello",
    from,
    ts: new Date().toISOString(),
    role: "daemon",
    offers: [],
  });
a.ws.send(hello("owner"));
b.ws.send(hello("asker"));
await new Promise((r) => setTimeout(r, 150));

const id = "job-soak-1";
const n = 80;
for (let i = 0; i < n; i++) {
  a.ws.send(
    JSON.stringify({
      type: "output",
      from: "owner",
      ts: new Date().toISOString(),
      id,
      stream: "stdout",
      chunk: `line-${i}\n`,
    }),
  );
}
a.ws.send(
  JSON.stringify({
    type: "result",
    from: "owner",
    ts: new Date().toISOString(),
    id,
    exitCode: 0,
    durationMs: 70_000,
    timedOut: false,
    tail: "done",
  }),
);
await new Promise((r) => setTimeout(r, 400));

const outputs = b.msgs.filter((m) => (m as { type?: string }).type === "output");
const result = b.msgs.find((m) => (m as { type?: string }).type === "result");
console.log(`asker received ${outputs.length}/${n} output frames`);
console.log(`asker received result:`, Boolean(result));

const late = await connect("late");
late.ws.send(hello("late"));
await new Promise((r) => setTimeout(r, 400));
const lateOutputs = late.msgs.filter((m) => (m as { type?: string }).type === "output");
const lateResult = late.msgs.find((m) => (m as { type?: string }).type === "result");
console.log(`late joiner history outputs: ${lateOutputs.length}, result: ${Boolean(lateResult)}`);

const ok = outputs.length === n && Boolean(result) && lateOutputs.length === n && Boolean(lateResult);
console.log(ok ? "SOAK OK" : "SOAK FAIL");
a.ws.close();
b.ws.close();
late.ws.close();
process.exit(ok ? 0 : 1);
