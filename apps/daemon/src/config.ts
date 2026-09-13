/**
 * team.json loading. Search order: --config flag, ./team.json, ~/.mesh/team.json.
 */
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { TeamConfig } from "@mesh/protocol";
import { ZodError } from "zod";

export interface LoadedConfig {
  config: TeamConfig;
  /** Absolute path the config was read from. */
  path: string;
  /** Absolute cwd for shell commands (config.cwd resolved relative to the config file, else process.cwd()). */
  cwd: string;
}

const lastConfigFile = () => path.join(homedir(), ".mesh", "last-config");
/** Remember where team.json was found so a later `mesh join` from any folder (e.g. a downloaded .cmd) keeps the same offers. */
export function rememberConfigPath(file: string): void {
  try { mkdirSync(path.dirname(lastConfigFile()), { recursive: true }); writeFileSync(lastConfigFile(), file); } catch { /* best effort */ }
}
function rememberedConfigPath(): string | undefined {
  try { const f = readFileSync(lastConfigFile(), "utf8").trim(); return f && existsSync(f) ? f : undefined; } catch { return undefined; }
}

export function candidatePaths(flag?: string): string[] {
  const base = userCwd();
  const list: string[] = [];
  if (flag) list.push(path.resolve(base, flag));
  list.push(path.resolve(base, "team.json"));
  const remembered = rememberedConfigPath();
  if (remembered) list.push(remembered);
  list.push(path.join(homedir(), ".mesh", "team.json"));
  return list;
}

export function findConfigPath(flag?: string): string | undefined {
  if (flag) return path.resolve(userCwd(), flag);
  return candidatePaths().find((p) => existsSync(p));
}

/**
 * Load and validate team.json. `overrides` (from CLI flags) are applied before validation so flags win.
 * Throws an Error with a readable message on any failure.
 */
/** Where the user actually ran the command. `pnpm -F daemon start …` sets cwd to apps/daemon but exports INIT_CWD. */
export function userCwd(): string {
  return process.env.INIT_CWD || process.cwd();
}

export function loadConfig(flag?: string, overrides: Partial<Record<"user" | "room" | "relay" | "key", string>> = {}): LoadedConfig {
  const file = findConfigPath(flag);
  if (!file || !existsSync(file)) {
    throw new Error(
      `no team.json found (looked at: ${candidatePaths(flag).join(", ")}). Run \`mesh init\` or pass --config.`,
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw new Error(`${file}: not valid JSON (${(e as Error).message})`);
  }
  if (typeof raw !== "object" || raw === null) throw new Error(`${file}: expected a JSON object`);
  const merged = { ...(raw as Record<string, unknown>) };
  for (const [k, v] of Object.entries(overrides)) if (v !== undefined) merged[k] = v;

  let config: TeamConfig;
  try {
    config = TeamConfig.parse(merged);
  } catch (e) {
    if (e instanceof ZodError) {
      const lines = e.issues.map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`);
      throw new Error(`${file}: invalid team.json\n${lines.join("\n")}`);
    }
    throw e;
  }
  const cwd = config.cwd ? path.resolve(path.dirname(file), config.cwd) : userCwd();
  rememberConfigPath(file);
  return { config, path: file, cwd };
}

/**
 * Build a config without a file (used by `mesh ask` when no team.json exists but all flags are given).
 */
export function configFromFlags(user: string, room: string, relay: string, key?: string): TeamConfig {
  return TeamConfig.parse({ user, room, relay, ...(key ? { key } : {}) });
}
