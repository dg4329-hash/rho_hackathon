#!/usr/bin/env node
/**
 * Bundle the daemon into a single file: apps/daemon/dist/mesh.mjs.
 *   pnpm -F daemon bundle
 *
 * The relay serves the result at GET /mesh.mjs so teammates can join with one command and
 * no clone / pnpm / npm account (see apps/relay/src/web.ts and the install scripts it generates).
 *
 * Notes:
 *   - platform node / format esm / target node20; no minify, no sourcemap (readable stack traces).
 *   - `bufferutil` and `utf-8-validate` are ws's optional native accelerators: left external so the
 *     bundle never tries to resolve them; ws falls back to pure JS when the require() fails.
 *   - Some deps (express, the MCP SDK's CJS builds) use `require`, which does not exist in an ESM
 *     entry. The banner defines one via createRequire so those calls resolve at runtime.
 */
import { build } from "esbuild";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const outfile = path.join(here, "dist", "mesh.mjs");

await build({
  entryPoints: [path.join(here, "src", "cli.ts")],
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  minify: false,
  sourcemap: false,
  external: ["bufferutil", "utf-8-validate"],
  banner: {
    // esbuild hoists the entry file's own `#!/usr/bin/env node` above the banner; the post-step below
    // guarantees exactly one shebang at the top either way.
    js: [
      "import { createRequire } from 'module';",
      "const require = createRequire(import.meta.url);",
    ].join("\n"),
  },
  logLevel: "info",
});
const SHEBANG = "#!/usr/bin/env node\n";
const src = readFileSync(outfile, "utf8");
if (!src.startsWith(SHEBANG)) writeFileSync(outfile, SHEBANG + src);
chmodSync(outfile, 0o755);
