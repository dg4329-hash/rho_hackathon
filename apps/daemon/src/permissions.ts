/** Glob-based permission and notes resolution over team.json (CONTRACT §2). */
import { minimatch } from "minimatch";
import type { Permission, TeamConfig } from "@mesh/protocol";

function firstMatch<T>(name: string, table: Record<string, T>): T | undefined {
  for (const [glob, value] of Object.entries(table)) {
    if (minimatch(name, glob)) return value;
  }
  return undefined;
}

/**
 * Permission for an offer name. `permissions` globs win (first match, in config order);
 * otherwise `fallback` (import.defaultPermission for mcp offers, offer.permission for shell offers).
 */
export function resolvePermission(name: string, config: TeamConfig, fallback?: Permission): Permission {
  return firstMatch(name, config.permissions) ?? fallback ?? config.import.defaultPermission;
}

/** Owner notes for an offer name: first matching glob in config.notes, else undefined. */
export function resolveNotes(name: string, config: TeamConfig): string | undefined {
  return firstMatch(name, config.notes);
}
