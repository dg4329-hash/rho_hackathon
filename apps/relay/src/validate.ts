#!/usr/bin/env node
/**
 * Validate a team.json against @mesh/protocol TeamConfig.
 * Usage: pnpm -F relay validate [path]
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { TeamConfig } from "@mesh/protocol";

// pnpm runs package scripts with cwd=apps/relay; INIT_CWD is where the user actually typed the command,
// so `pnpm -F relay validate ./team.json` from the repo root does what it says.
const baseDir = process.env.INIT_CWD ?? process.cwd();
const path = resolve(baseDir, process.argv[2] ?? "./team.json");

let raw: unknown;
try {
  raw = JSON.parse(readFileSync(path, "utf8"));
} catch (err) {
  console.error(`Failed to read ${path}:`, err instanceof Error ? err.message : err);
  process.exit(1);
}

const result = TeamConfig.safeParse(raw);
if (!result.success) {
  console.error(`Invalid team.json (${path}):`);
  for (const issue of result.error.issues) {
    const where = issue.path.length ? issue.path.join(".") : "(root)";
    console.error(`  - ${where}: ${issue.message}`);
  }
  process.exit(1);
}

console.log(`OK ${path}`);
console.log(`  user=${result.data.user} room=${result.data.room}`);
console.log(`  relay=${result.data.relay}`);
console.log(`  shell offers=${result.data.offers.length}${result.data.offers.length ? ` (${result.data.offers.map((o) => `${o.name}:${o.permission}`).join(", ")})` : ""}`);
console.log(`  import: claudeCode=${result.data.import.fromClaudeCode} cursor=${result.data.import.fromCursor} default=${result.data.import.defaultPermission}`);
if (!/^wss?:\/\//.test(result.data.relay)) console.warn(`  warning: relay should be a ws:// or wss:// URL`);
if (result.data.relay.includes("REPLACE_WITH")) console.warn(`  warning: relay is still the placeholder — run scripts/tunnel-relay.sh and paste the wss:// URL`);
