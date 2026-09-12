#!/usr/bin/env node
/**
 * Validate a team.json against @mesh/protocol TeamConfig.
 * Usage: pnpm -F relay validate [path]
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { TeamConfig } from "@mesh/protocol";

const path = resolve(process.cwd(), process.argv[2] ?? "./team.json");

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
console.log(`  shell offers=${result.data.offers.length}`);
