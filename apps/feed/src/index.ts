/**
 * mesh feed — the live team feed for the projector.
 *
 *   pnpm -F feed start <room> [--relay ws://host:port] [--user abhi]
 *
 * Joins the room read-only (role=feed), sends one `hello`, then pretty-prints
 * every frame the relay forwards (CONTRACT §1). Designed for 24pt on a dark
 * background: wide gutters, padded names, high-contrast colours.
 */
import WebSocket from "ws";
import chalk from "chalk";
import { parseFrame, DEFAULT_PORT } from "@mesh/protocol";
import type { Frame, Offer, PresenceFrame, RequestFrame, EventFrame } from "@mesh/protocol";

// ---------- args ----------
const argv = process.argv.slice(2).filter((a) => a !== "feed");
const flag = (name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const room = argv.find((a) => !a.startsWith("--") && !Object.values(flags()).includes(a)) ?? process.env.MESH_ROOM ?? "rho";
function flags() { return { relay: flag("--relay"), user: flag("--user") }; }
const relay = flags().relay ?? process.env.MESH_RELAY ?? "ws://localhost:8080";
const user = flags().user ?? process.env.MESH_USER ?? "abhi";

// ---------- layout ----------
const NAME_W = 8;                     // user handles are padded to this
const GUTTER = "  ";
const TIME_W = 8;                     // HH:MM:SS
const INDENT = " ".repeat(TIME_W + GUTTER.length + NAME_W + GUTTER.length);
const MAX_OUTPUT_LINES = 20;
const cols = () => Math.max(60, process.stdout.columns ?? 100);

const c = {
  time: chalk.dim,
  name: chalk.bold.white,
  dim: chalk.dim,
  request: chalk.yellow,
  approved: chalk.green.bold,
  auto: chalk.cyan.bold,
  denied: chalk.red.bold,
  ok: chalk.green.bold,
  fail: chalk.red.bold,
  output: chalk.dim,
  stderr: chalk.red.dim,
  prompt: chalk.magentaBright,
  tool_call: chalk.blueBright,
  file_touched: chalk.cyanBright,
  status: chalk.dim,
  note: chalk.white,
  message: chalk.cyanBright,
  header: chalk.bold.bgBlue.white,
  rule: chalk.blue.dim,
  online: chalk.green,
  feed: chalk.dim,
};

const ICON: Record<EventFrame["kind"], string> = {
  prompt: "💬", tool_call: "🔧", file_touched: "📁", status: "⏸ ", note: "📝", message: "✉ ",
};

const pad = (s: string, w = NAME_W) => s.length >= w ? s : s + " ".repeat(w - s.length);
const hhmmss = (ts?: string) => {
  const d = ts ? new Date(ts) : new Date();
  return isNaN(d.getTime()) ? "--:--:--" : d.toTimeString().slice(0, 8);
};
const short = (id: string) => id.replace(/-/g, "").slice(-4);
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
const clip = (s: string, w: number) => (s.length > w ? s.slice(0, Math.max(0, w - 1)) + "…" : s);
const secs = (ms: number) => (ms / 1000).toFixed(1) + "s";

/** `HH:MM:SS  name      body` — the shape of every top-level line. */
function line(ts: string | undefined, name: string, body: string) {
  console.log(`${c.time(hhmmss(ts))}${GUTTER}${c.name(pad(name))}${GUTTER}${body}`);
}
function rule(label = "") {
  const w = cols();
  const text = label ? ` ${label} ` : "";
  console.log(c.rule("─".repeat(3) + text + "─".repeat(Math.max(0, w - 3 - text.length))));
}

// ---------- per-job state (request → decision → output* → result) ----------
interface Job { from: string; to: string; label: string; printed: number; partial: string; capped: boolean }
const jobs = new Map<string, Job>();
const job = (id: string): Job =>
  jobs.get(id) ?? { from: "?", to: "?", label: "", printed: 0, partial: "", capped: false };

// ---------- renderers ----------
function renderPresence(f: PresenceFrame) {
  rule("team");
  if (f.members.length === 0) console.log(`${INDENT}${c.dim("nobody here yet")}`);
  for (const m of f.members) {
    if (m.role === "feed") {
      console.log(`${c.feed("○")}${GUTTER}${c.dim(pad(m.user))}${GUTTER}${c.dim("(watching)")}`);
      continue;
    }
    console.log(`${c.online("●")}${GUTTER}${c.name(pad(m.user))}${GUTTER}${summarizeOffers(m.offers)}`);
  }
  rule();
}

/** `supabase(3) github(2) figma.export vercel.deploy` */
function summarizeOffers(offers: Offer[]): string {
  const byServer = new Map<string, number>();
  const shell: string[] = [];
  for (const o of offers) {
    if (o.kind === "mcp") {
      const s = o.server ?? o.name.split(".")[0];
      byServer.set(s, (byServer.get(s) ?? 0) + 1);
    } else shell.push(o.name);
  }
  const parts = [
    ...[...byServer].map(([s, n]) => `${chalk.cyan(s)}${c.dim(`(${n})`)}`),
    ...shell.map((n) => chalk.yellow(n)),
  ];
  return parts.length ? parts.join("  ") : c.dim("no offers");
}

function renderEvent(f: EventFrame) {
  const colour = c[f.kind] ?? chalk.white;
  const label = f.kind === "file_touched" ? "file" : f.kind === "tool_call" ? "tool" : f.kind === "message" ? `msg → ${String(f.data?.to ?? "all")}` : f.kind;
  const text = f.kind === "message" ? String(f.data?.text ?? f.summary) : f.summary;
  const body = `${ICON[f.kind]} ${colour(label + ":")} ${colour(clip(oneLine(text), cols() - INDENT.length - 12))}`;
  line(f.ts, f.from, body);
}

function renderRequest(f: RequestFrame) {
  const what = f.command
    ? `$ ${f.command}`
    : `${f.tool} ${f.args ? JSON.stringify(f.args) : ""}`;
  const label = clip(oneLine(what), Math.max(30, cols() - INDENT.length - 30));
  jobs.set(f.id, { from: f.from, to: f.to, label, printed: 0, partial: "", capped: false });
  const arrow = `${c.name(pad(f.from))}${GUTTER}${c.request("──▶")}${GUTTER}${c.name(pad(f.to))}`;
  console.log(`${c.time(hhmmss(f.ts))}${GUTTER}${arrow}${GUTTER}${c.request.bold(label)}${GUTTER}${c.dim(`#${short(f.id)}`)}`);
  console.log(`${INDENT}${c.dim("why:")} ${c.request(clip(oneLine(f.why), cols() - INDENT.length - 6))}`);
}

function renderDecision(f: Extract<Frame, { type: "decision" }>) {
  const tag = c.dim(`#${short(f.id)}`);
  const body =
    f.decision === "approved" ? c.approved("✅ approved")
    : f.decision === "auto" ? c.auto("⚡ auto-approved")
    : c.denied("❌ denied") + (f.reason ? c.denied(`  (${oneLine(f.reason)})`) : "");
  line(f.ts, f.from, `${body}  ${tag}`);
}

/** Buffer partial lines per job, print complete ones dim + indented, cap at MAX_OUTPUT_LINES. */
function renderOutputText(id: string, text: string, stream: "stdout" | "stderr" = "stdout", flush = false) {
  const j = job(id);
  jobs.set(id, j);
  j.partial += text;
  const parts = j.partial.split("\n");
  j.partial = flush ? "" : (parts.pop() ?? "");
  if (flush && parts[parts.length - 1] === "") parts.pop();
  for (const raw of parts) {
    if (j.capped) return;
    if (j.printed >= MAX_OUTPUT_LINES) {
      j.capped = true;
      console.log(`${INDENT}${c.dim(`#${short(id)} ▏ …`)}`);
      return;
    }
    j.printed++;
    const colour = stream === "stderr" ? c.stderr : c.output;
    console.log(`${INDENT}${c.dim(`#${short(id)}`)} ${colour("▏ " + clip(raw.replace(/\t/g, "  "), cols() - INDENT.length - 8))}`);
  }
}

/** mcp tool results are usually JSON; pretty-print so they read from across the room. */
function prettyTail(tail: string): string {
  const t = tail.trim();
  if (!/^[\[{]/.test(t)) return tail;
  try { return JSON.stringify(JSON.parse(t), null, 2); } catch { return tail; }
}

function renderResult(f: Extract<Frame, { type: "result" }>) {
  const j = job(f.id);
  // mcp results carry no output frames; show the tail so the room sees what came back
  if (j.printed === 0 && !j.partial && f.tail.trim()) renderOutputText(f.id, prettyTail(f.tail), "stdout", true);
  else if (j.partial) renderOutputText(f.id, "", "stdout", true);

  const tag = c.dim(`#${short(f.id)}`);
  let body: string;
  if (f.timedOut) body = c.fail(`✘ timed out after ${secs(f.durationMs)}`);
  else if (f.exitCode === 0) body = c.ok(`✔ exit 0 in ${secs(f.durationMs)}`);
  else body = c.fail(`✘ exit ${f.exitCode ?? "?"} in ${secs(f.durationMs)}`);
  line(f.ts, f.from, `${body}  ${tag}`);
  jobs.delete(f.id);
}

function render(f: Frame) {
  switch (f.type) {
    case "presence": return renderPresence(f);
    case "event": return renderEvent(f);
    case "request": return renderRequest(f);
    case "decision": return renderDecision(f);
    case "output": return renderOutputText(f.id, f.chunk, f.stream);
    case "result": return renderResult(f);
    case "hello": return line(f.ts, f.from, c.dim(`joined as ${f.role}`));
    case "error": return console.log(`${INDENT}${c.fail("relay error: " + f.message)}`);
  }
}

// ---------- connection ----------
let attempt = 0;
function connect() {
  const url = `${relay.replace(/\/$/, "")}/?room=${encodeURIComponent(room)}&user=${encodeURIComponent(user)}&role=feed`;
  const ws = new WebSocket(url);

  ws.on("open", () => {
    attempt = 0;
    ws.send(JSON.stringify({ type: "hello", from: user, ts: new Date().toISOString(), role: "feed", offers: [] }));
    console.log(`${INDENT}${c.dim(`connected to ${relay} · room ${room}`)}`);
  });

  ws.on("message", (raw) => {
    const text = raw.toString();
    try {
      render(parseFrame(text));
    } catch {
      console.log(`${INDENT}${c.dim("unparsed frame: " + clip(oneLine(text), 80))}`);
    }
  });

  ws.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code !== "ECONNREFUSED") console.log(`${INDENT}${c.fail("relay error: " + (err.code ?? err.message))}`);
  });
  ws.on("close", () => {
    const wait = Math.min(5_000, 1000 * 2 ** attempt++);
    console.log(`${INDENT}${c.dim(`relay disconnected · retrying in ${wait / 1000}s`)}`);
    setTimeout(connect, wait);
  });
}

console.clear();
console.log(c.header(`  mesh  `) + "  " + chalk.bold(`room ${room}`) + c.dim(`   ${relay}   daemon :${DEFAULT_PORT}`));
console.log();
connect();
