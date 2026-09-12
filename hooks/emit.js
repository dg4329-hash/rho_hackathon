#!/usr/bin/env node
/**
 * mesh hook emitter — CONTRACT §4.
 *
 *   node hooks/emit.js <prompt|file_touched|tool_call|status>
 *
 * Reads the Claude Code hook payload from stdin, turns it into { kind, summary, data },
 * POSTs it to the local daemon (http://localhost:7337/event). For `prompt` it also fetches
 * GET /activity?sinceMinutes=10 and prints it to stdout, which Claude Code adds to the
 * agent's context.
 *
 * Must never break the hook: every failure is swallowed, exit code is always 0,
 * each HTTP call is capped at 1 s.
 */
"use strict";

const DAEMON = process.env.MESH_DAEMON || "http://localhost:7337";
const TIMEOUT_MS = 1000;
const kind = process.argv[2];

async function main() {
  const payload = await readStdin();
  const body = build(kind, payload);
  if (!body) return;

  // fetch activity first so the block doesn't include the prompt we're about to post
  const activity = kind === "prompt" ? await get(`${DAEMON}/activity?sinceMinutes=10`) : null;
  await post(`${DAEMON}/event`, body);

  if (kind === "prompt") {
    const block = formatActivity(activity);
    if (block) process.stdout.write(block + "\n");
  }
}

function build(kind, p) {
  const data = {};
  if (p.cwd) data.cwd = p.cwd;
  if (p.session_id) data.session = String(p.session_id).slice(0, 8);

  switch (kind) {
    case "prompt": {
      const text = String(p.prompt || "").replace(/\s+/g, " ").trim();
      if (!text) return null;
      return { kind, summary: text.slice(0, 140), data };
    }
    case "file_touched": {
      const input = p.tool_input || {};
      let file = input.file_path || input.path || input.notebook_path || "";
      if (!file) return null;
      if (p.cwd && file.startsWith(p.cwd + "/")) file = file.slice(p.cwd.length + 1);
      data.tool = p.tool_name;
      return { kind, summary: file, data };
    }
    case "tool_call": {
      const name = p.tool_name || "";
      if (!name) return null;
      // keep the args short: they can be huge
      const args = p.tool_input ? JSON.stringify(p.tool_input).slice(0, 200) : undefined;
      if (args) data.args = args;
      return { kind, summary: name, data };
    }
    case "status":
      return { kind, summary: "idle", data };
    default:
      return null;
  }
}

function formatActivity(res) {
  const events = res && Array.isArray(res.events) ? res.events : [];
  if (events.length === 0) return "";
  const lines = events.slice(-20).map((e) => {
    const t = new Date(e.ts);
    const hhmm = isNaN(t) ? "--:--" : t.toTimeString().slice(0, 5);
    const label = e.type === "file_touched" ? "file" : e.type === "tool_call" ? "tool" : e.type;
    return `- ${hhmm} ${e.from} ${label}: ${String(e.summary || "").slice(0, 120)}`;
  });
  return `Team activity (last 10 min):\n${lines.join("\n")}`;
}

// ---------- io helpers: everything is best-effort ----------
function readStdin() {
  return new Promise((resolve) => {
    let buf = "";
    const done = () => { try { resolve(JSON.parse(buf || "{}")); } catch { resolve({}); } };
    if (process.stdin.isTTY) return resolve({});
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (buf += c));
    process.stdin.on("end", done);
    process.stdin.on("error", done);
    setTimeout(done, TIMEOUT_MS);
  });
}

async function post(url, body) {
  try {
    await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch { /* daemon not running, or slow: not our problem */ }
}

async function get(url) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

main().catch(() => {}).finally(() => process.exit(0));
