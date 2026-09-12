/**
 * Zero-config plumbing for `mesh join`:
 *   - parse a room link (https://host/r/room) into relay + room
 *   - default handle from git config / OS user
 *   - register the local MCP server with Claude Code, Cursor, Codex (whichever are present)
 *   - install the Claude Code hooks (prompt/file/tool/stop → daemon) into the current project
 * Every step is best-effort: a failure prints one dim line and never blocks the join.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import chalk from "chalk";

export interface RoomTarget { room: string; relay?: string }

/** `otter-5434` | `https://host/r/otter-5434` | `wss://host/otter-5434` → { room, relay } */
export function parseRoomArg(arg: string): RoomTarget {
  const m = arg.match(/^(https?|wss?):\/\/([^/]+)\/(?:r\/)?([a-z0-9][a-z0-9-]{1,40})\/?$/i);
  if (!m) return { room: arg };
  const [, scheme, host, room] = m;
  const ws = scheme === "https" || scheme === "wss" ? "wss" : "ws";
  return { room: room!, relay: `${ws}://${host}` };
}

/** git user.name → OS username, lowercased, [a-z0-9_-] only, ≤ 32 chars. */
export function defaultHandle(cwd: string = process.env.INIT_CWD || process.cwd()): string {
  let name = "";
  try { name = execFileSync("git", ["config", "user.name"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { /* no git */ }
  if (!name) { try { name = userInfo().username; } catch { /* ignore */ } }
  const first = name.split(/\s+/)[0] ?? "";
  const clean = first.toLowerCase().replace(/[^a-z0-9_-]/g, "");
  return clean.slice(0, 32) || "me";
}

export interface RegisterResult { tool: string; status: "registered" | "already" | "skipped" | "failed"; note?: string }

function readJson(file: string): Record<string, unknown> | undefined {
  try { return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>; } catch { return undefined; }
}
function writeJson(file: string, obj: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(obj, null, 2) + "\n");
}
function onPath(bin: string): boolean {
  const r = spawnSync(process.platform === "win32" ? "where" : "which", [bin], { stdio: "ignore" });
  return r.status === 0;
}

/** True when the `mesh` Claude Code plugin is installed (any marketplace): it ships the MCP server + hooks itself. */
export function meshPluginInstalled(): boolean {
  const file = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(homedir(), ".claude"), "plugins", "installed_plugins.json");
  const installed = readJson(file);
  const plugins = (installed?.plugins as Record<string, unknown> | undefined) ?? {};
  return Object.keys(plugins).some((k) => k.startsWith("mesh@"));
}

/** Canonical tool names Claude Code uses for approve_request: `claude mcp add mesh …` form and the plugin form. */
export const APPROVE_REQUEST_TOOLS = ["mcp__mesh__approve_request", "mcp__plugin_mesh_mesh__approve_request"] as const;

/**
 * Force Claude Code to prompt for approve_request even in auto / bypass modes: `permissions.ask` rules in
 * <cwd>/.claude/settings.json (ask rules apply without workspace trust and are honoured by auto mode). The tool
 * also carries `anthropic/requiresUserInteraction`; this rule is the backstop for older Claude Code versions.
 */
export function registerApproveAskRule(cwd: string): RegisterResult {
  const file = path.join(cwd, ".claude", "settings.json");
  const cfg = readJson(file) ?? {};
  const permissions = (cfg.permissions as Record<string, unknown> | undefined) ?? {};
  const ask = Array.isArray(permissions.ask) ? (permissions.ask as unknown[]).filter((x): x is string => typeof x === "string") : [];
  const missing = APPROVE_REQUEST_TOOLS.filter((t) => !ask.includes(t));
  if (missing.length === 0) return { tool: "Claude Code approve_request ask rule", status: "already" };
  permissions.ask = [...ask, ...missing];
  cfg.permissions = permissions;
  try { writeJson(file, cfg); } catch (e) { return { tool: "Claude Code approve_request ask rule", status: "failed", note: (e as Error).message }; }
  return { tool: "Claude Code approve_request ask rule", status: "registered", note: file };
}

/** Claude Code: `claude mcp add` (local scope = this project). Falls back to skipped if the CLI isn't installed. */
export function registerClaudeCode(port: number, cwd: string): RegisterResult {
  const url = `http://localhost:${port}/mcp`;
  if (!onPath("claude")) return { tool: "Claude Code", status: "skipped", note: "claude CLI not on PATH" };
  if (meshPluginInstalled()) return { tool: "Claude Code", status: "already", note: "the mesh plugin provides the MCP server" };
  const list = spawnSync("claude", ["mcp", "get", "mesh"], { cwd, encoding: "utf8" });
  if (list.status === 0 && (list.stdout ?? "").includes(url)) return { tool: "Claude Code", status: "already" };
  if (list.status === 0) spawnSync("claude", ["mcp", "remove", "mesh"], { cwd, stdio: "ignore" });
  const r = spawnSync("claude", ["mcp", "add", "--transport", "http", "mesh", url], { cwd, encoding: "utf8" });
  if (r.status !== 0) return { tool: "Claude Code", status: "failed", note: (r.stderr || r.stdout || "").trim().split("\n")[0] };
  return { tool: "Claude Code", status: "registered", note: `project scope, ${cwd}` };
}

/** Cursor: merge into <cwd>/.cursor/mcp.json. Only if the project already uses Cursor or Cursor is installed. */
export function registerCursor(port: number, cwd: string, force = false): RegisterResult {
  const file = path.join(cwd, ".cursor", "mcp.json");
  const cursorPresent = force || existsSync(path.join(cwd, ".cursor")) || existsSync(path.join(homedir(), ".cursor"));
  if (!cursorPresent) return { tool: "Cursor", status: "skipped", note: "no .cursor directory (pass --cursor to force)" };
  const url = `http://localhost:${port}/mcp`;
  const cfg = readJson(file) ?? {};
  const servers = (cfg.mcpServers as Record<string, unknown> | undefined) ?? {};
  const existing = servers.mesh as { url?: string } | undefined;
  if (existing?.url === url) return { tool: "Cursor", status: "already" };
  servers.mesh = { url };
  cfg.mcpServers = servers;
  try { writeJson(file, cfg); } catch (e) { return { tool: "Cursor", status: "failed", note: (e as Error).message }; }
  return { tool: "Cursor", status: "registered", note: file };
}

/** Codex CLI: append/replace [mcp_servers.mesh] in ~/.codex/config.toml. Uses a streamable-HTTP url; newer Codex reads it directly. */
export function registerCodex(port: number, force = false): RegisterResult {
  const dir = path.join(homedir(), ".codex");
  if (!force && !existsSync(dir) && !onPath("codex")) return { tool: "Codex", status: "skipped", note: "codex not installed (pass --codex to force)" };
  const file = path.join(dir, "config.toml");
  const url = `http://localhost:${port}/mcp`;
  // Prefer the CLI (codex ≥ 0.150 has `codex mcp add --url`); it validates and keeps the TOML tidy.
  if (onPath("codex")) {
    const get = spawnSync("codex", ["mcp", "get", "mesh"], { encoding: "utf8" });
    if (get.status === 0 && (get.stdout ?? "").includes(url)) return { tool: "Codex", status: "already" };
    if (get.status === 0) spawnSync("codex", ["mcp", "remove", "mesh"], { stdio: "ignore" });
    const r = spawnSync("codex", ["mcp", "add", "mesh", "--url", url], { encoding: "utf8" });
    if (r.status === 0) return { tool: "Codex", status: "registered", note: `codex mcp add (${file})` };
    // fall through to editing the file directly
  }
  let toml = existsSync(file) ? readFileSync(file, "utf8") : "";
  const block = `[mcp_servers.mesh]\nurl = "${url}"\n`;
  if (toml.includes(block)) return { tool: "Codex", status: "already" };
  // drop any previous [mcp_servers.mesh] table (up to the next table header)
  toml = toml.replace(/\[mcp_servers\.mesh\][\s\S]*?(?=\n\[|$)/g, "").replace(/\n{3,}/g, "\n\n");
  toml = (toml.trimEnd() + "\n\n" + block).replace(/^\n+/, "");
  try { mkdirSync(dir, { recursive: true }); writeFileSync(file, toml); } catch (e) { return { tool: "Codex", status: "failed", note: (e as Error).message }; }
  return { tool: "Codex", status: "registered", note: file };
}

/** Locate hooks/emit.js: repo checkout (dev) → ~/.mesh/emit.js (installer) → none. */
export function findEmitScript(): string | undefined {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, "../../../hooks/emit.js"),   // apps/daemon/src → repo root
    path.resolve(here, "../../hooks/emit.js"),      // apps/daemon/dist → (if ever)
    path.join(homedir(), ".mesh", "emit.js"),
  ];
  return candidates.find((p) => existsSync(p));
}

/** Claude Code hooks → <cwd>/.claude/settings.json (merge; replaces previous mesh entries; keeps everything else). */
export function installClaudeHooks(cwd: string, port: number): RegisterResult {
  if (!onPath("claude")) return { tool: "Claude Code hooks", status: "skipped", note: "claude CLI not on PATH" };
  if (meshPluginInstalled()) return { tool: "Claude Code hooks", status: "already", note: "the mesh plugin provides the hooks" };
  const emit = findEmitScript();
  if (!emit) return { tool: "Claude Code hooks", status: "skipped", note: "emit.js not found (expected ~/.mesh/emit.js)" };
  // keep a stable copy under ~/.mesh so the hook survives repo moves
  const stable = path.join(homedir(), ".mesh", "emit.js");
  try { if (path.resolve(emit) !== path.resolve(stable)) { mkdirSync(path.dirname(stable), { recursive: true }); copyFileSync(emit, stable); } } catch { /* fall back to repo path */ }
  const script = existsSync(stable) ? stable : emit;
  const env = port === 7337 ? "" : `MESH_DAEMON=http://localhost:${port} `;
  const cmd = (kind: string) => `${env}node "${script}" ${kind}`;
  const file = path.join(cwd, ".claude", "settings.json");
  const cfg = readJson(file) ?? {};
  const hooks = (cfg.hooks as Record<string, Array<{ matcher?: string; hooks: Array<{ type: string; command: string; timeout?: number }> }>> | undefined) ?? {};
  const isMesh = (h: { command: string }) => /emit\.js/.test(h.command);
  const strip = (arr: typeof hooks[string] | undefined) => (arr ?? []).map((e) => ({ ...e, hooks: e.hooks.filter((h) => !isMesh(h)) })).filter((e) => e.hooks.length > 0);
  const entry = (kind: string, matcher?: string) => ({ ...(matcher ? { matcher } : {}), hooks: [{ type: "command", command: cmd(kind), timeout: 5 }] });
  hooks.UserPromptSubmit = [...strip(hooks.UserPromptSubmit), entry("prompt")];
  hooks.PostToolUse = [...strip(hooks.PostToolUse), entry("file_touched", "Edit|Write|MultiEdit"), entry("tool_call", "mcp__.*")];
  hooks.Stop = [...strip(hooks.Stop), entry("status")];
  cfg.hooks = hooks;
  try { writeJson(file, cfg); } catch (e) { return { tool: "Claude Code hooks", status: "failed", note: (e as Error).message }; }
  return { tool: "Claude Code hooks", status: "registered", note: file };
}

export function printRegister(results: RegisterResult[]): void {
  for (const r of results) {
    const icon = r.status === "registered" ? chalk.green("✓") : r.status === "already" ? chalk.green("✓") : r.status === "failed" ? chalk.red("✗") : chalk.dim("–");
    const label = r.status === "registered" ? "registered" : r.status === "already" ? "already registered" : r.status;
    console.log(`  ${icon} ${r.tool}: ${label}${r.note ? chalk.dim(`  ${r.note}`) : ""}`);
  }
}
