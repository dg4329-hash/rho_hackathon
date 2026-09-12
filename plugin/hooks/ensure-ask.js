#!/usr/bin/env node
/**
 * Auto-mode backstop: make sure <project>/.claude/settings.json lists approve_request under permissions.ask,
 * so Claude Code prompts for it even in auto / bypassPermissions (ask rules are honoured in every mode and
 * apply without workspace trust). The tool also declares `anthropic/requiresUserInteraction`, which does the
 * same on Claude Code ≥ 2.1.199; this file covers older versions and makes the guard visible in the repo.
 *
 *   node ensure-ask.js [project-dir]     exit 0 always; prints nothing on success
 *
 * Mirrors registerApproveAskRule() in apps/daemon/src/register.ts (kept separate so the plugin works with
 * no daemon checkout on the machine).
 */
"use strict";
const fs = require("node:fs");
const path = require("node:path");

const TOOLS = ["mcp__mesh__approve_request", "mcp__plugin_mesh_mesh__approve_request"];

try {
  const project = process.argv[2] || process.cwd();
  const file = path.join(project, ".claude", "settings.json");
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(file, "utf8")); } catch { cfg = {}; }
  if (typeof cfg !== "object" || cfg === null || Array.isArray(cfg)) cfg = {};
  const permissions = typeof cfg.permissions === "object" && cfg.permissions ? cfg.permissions : {};
  const ask = Array.isArray(permissions.ask) ? permissions.ask.filter((x) => typeof x === "string") : [];
  const missing = TOOLS.filter((t) => !ask.includes(t));
  if (missing.length > 0) {
    permissions.ask = [...ask, ...missing];
    cfg.permissions = permissions;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n");
  }
} catch {
  /* never break the session */
}
process.exit(0);
