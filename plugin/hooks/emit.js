#!/usr/bin/env node
/**
 * mesh hook emitter — CONTRACT §4.
 *
 *   node hooks/emit.js <prompt|file_touched|tool_call|status|pre_edit>
 *
 * Reads the Claude Code hook payload from stdin, turns it into { kind, summary, data },
 * POSTs it to the local daemon (http://localhost:7337/event). For `prompt` it also fetches
 * GET /activity?sinceMinutes=10 and prints it to stdout, which Claude Code adds to the
 * agent's context.
 *
 * `pre_edit` (PreToolUse on Edit|Write|MultiEdit) posts nothing: it asks GET /touched?path=&minutes=10
 * whether a teammate touched the file in the last 10 minutes and, if so, prints a one-line warning
 * as PreToolUse JSON (`hookSpecificOutput.additionalContext`, so it lands in the agent's context;
 * `systemMessage` so the user sees it too). It never blocks the edit.
 *
 * Must never break the hook: every failure is swallowed, exit code is always 0,
 * each HTTP call is capped at 1 s.
 */
"use strict";

const argDaemon = (() => { const i = process.argv.indexOf("--daemon"); return i > 0 ? process.argv[i + 1] : undefined; })();
const DAEMON = argDaemon || process.env.MESH_DAEMON || "http://localhost:7337";
const TIMEOUT_MS = 1000;
const kind = process.argv[2];

async function main() {
  const payload = await readStdin();
  if (kind === "pre_edit") return preEdit(payload);
  const body = build(kind, payload);
  if (!body) return;

  // fetch activity first so the block doesn't include the prompt we're about to post
  const activity = kind === "prompt" ? await get(`${DAEMON}/activity?sinceMinutes=10`) : null;
  const inbox = kind === "prompt" ? await get(`${DAEMON}/inbox?unread=1`) : null;
  await post(`${DAEMON}/event`, body);

  if (kind === "prompt") {
    const msgs = formatInbox(inbox);
    if (msgs) process.stdout.write(msgs + "\n");
    const block = formatActivity(activity);
    if (block) process.stdout.write(block + "\n");
  }
}

/** The edited file, relative to the hook's cwd when it is inside it (same rule as the file_touched event). */
function editedPath(p) {
  const input = p.tool_input || {};
  let file = String(input.file_path || input.path || input.notebook_path || "").replace(/\\/g, "/");
  if (!file) return "";
  const cwd = p.cwd ? String(p.cwd).replace(/\\/g, "/").replace(/\/+$/, "") : "";
  if (cwd && file.startsWith(cwd + "/")) file = file.slice(cwd.length + 1);
  return file;
}

/** Conflict warning before an edit: who else touched this file in the last 10 minutes (CONTRACT §4). */
async function preEdit(p) {
  const file = editedPath(p);
  if (!file) return;
  const res = await get(`${DAEMON}/touched?path=${encodeURIComponent(file)}&minutes=10`);
  const touched = res && Array.isArray(res.touched) ? res.touched : [];
  if (touched.length === 0) return;
  const lines = touched.slice(0, 3).map((t) => {
    const mins = Math.round((Date.now() - Date.parse(t.ts)) / 60000);
    const when = !isFinite(mins) ? "recently" : mins < 1 ? "just now" : `${mins} min ago`;
    return `mesh: ${t.user} edited ${file} ${when} — coordinate before changing it (send_message ${t.user})`;
  });
  const text = lines.join("\n");
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: text },
    systemMessage: text,
  }) + "\n");
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
      const file = editedPath(p);
      if (!file) return null;
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

function formatInbox(res) {
  const msgs = res && Array.isArray(res.messages) ? res.messages : [];
  if (msgs.length === 0) return "";
  const lines = msgs.slice(-10).map((m) => {
    const t = new Date(m.ts);
    const hhmm = isNaN(t) ? "--:--" : t.toTimeString().slice(0, 5);
    return `- ${hhmm} ${m.from}${m.to === "all" ? " (to all)" : ""}: ${String(m.text || "").slice(0, 500)}`;
  });
  return `Messages from teammates (unread; reply with the mesh send_message tool if needed):\n${lines.join("\n")}`;
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
