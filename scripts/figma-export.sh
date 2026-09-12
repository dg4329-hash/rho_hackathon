#!/usr/bin/env bash
# Export a Figma frame to PNG + a readable text outline for coding agents.
#
#   ./scripts/figma-export.sh list                  # frames in $FIGMA_FILE_KEY
#   ./scripts/figma-export.sh "Onboarding/Step 2"   # export by name (owner sets FIGMA_FILE_KEY once)
#   ./scripts/figma-export.sh <fileKey> <nodeId>    # explicit form; 12:34 and 12-34 both accepted
#
# Requires FIGMA_TOKEN in the environment (personal access token, https://www.figma.com/developers/api#access-tokens).
# Never commit the token. Optional: FIGMA_MAX_DEPTH (default 8), FIGMA_OUT_DIR (default /tmp),
# FIGMA_API_BASE (default https://api.figma.com — only override for tests).
#
# Prints:  PNG: <path>            (2x PNG render of the node)
#          Outline: …             (indented tree: name, type, bounding box, text, font, fill)
set -euo pipefail

# ---- arguments ---------------------------------------------------------------
#   figma-export.sh list                      list frames in $FIGMA_FILE_KEY (name → node id)
#   figma-export.sh "<frame name>"            export a frame from $FIGMA_FILE_KEY by name (case-insensitive; substring ok)
#   figma-export.sh <nodeId>                  export by node id from $FIGMA_FILE_KEY
#   figma-export.sh <fileKey> <nodeId>        explicit file + node (original form)
# The owner sets FIGMA_FILE_KEY once next to FIGMA_TOKEN; requesters only need a frame name.
MODE="export"
FILE_KEY=""
NODE_ID=""
FRAME_NAME=""
if [[ $# -ge 2 ]]; then
  FILE_KEY="$1"; NODE_ID="$2"
elif [[ $# -eq 1 && "$1" == "list" ]]; then
  MODE="list"
elif [[ $# -eq 1 && "$1" =~ ^[0-9]+[:-][0-9]+$ ]]; then
  NODE_ID="$1"
elif [[ $# -eq 1 ]]; then
  FRAME_NAME="$1"
else
  echo "Usage: figma-export.sh list | figma-export.sh \"<frame name>\" | figma-export.sh <nodeId> | figma-export.sh <fileKey> <nodeId>" >&2
  exit 2
fi
FILE_KEY="${FILE_KEY:-${FIGMA_FILE_KEY:-}}"
if [[ -z "$FILE_KEY" ]]; then
  echo "No Figma file: set FIGMA_FILE_KEY (segment after /file/ or /design/ in the Figma URL) next to FIGMA_TOKEN, or pass <fileKey> <nodeId>." >&2
  exit 2
fi

if [[ -z "${FIGMA_TOKEN:-}" ]]; then
  echo "FIGMA_TOKEN is not set. Create a personal access token in Figma (Settings → Security → Personal access tokens)" >&2
  echo "and run:  export FIGMA_TOKEN=figd_…   (in your shell only — never commit it)" >&2
  exit 1
fi

for dep in curl node; do
  if ! command -v "$dep" >/dev/null 2>&1; then
    echo "figma-export.sh needs '$dep' on PATH" >&2
    exit 1
  fi
done

API="${FIGMA_API_BASE:-https://api.figma.com}"
OUT_DIR="${FIGMA_OUT_DIR:-/tmp}"
MAX_DEPTH="${FIGMA_MAX_DEPTH:-8}"
AUTH="X-Figma-Token: ${FIGMA_TOKEN}"

# ---- frame lookup by name (pages + top-level frames, one cheap request) ----------------------------------
if [[ "$MODE" == "list" || -n "$FRAME_NAME" ]]; then
  FILE_JSON=$(curl -sS -f -H "$AUTH" "$API/v1/files/${FILE_KEY}?depth=2") || {
    echo "Figma files API request failed (check FIGMA_TOKEN and FIGMA_FILE_KEY '$FILE_KEY')" >&2
    exit 1
  }
  RESOLVED=$(printf '%s' "$FILE_JSON" | node -e '
    const mode = process.argv[1], want = (process.argv[2] || "").toLowerCase();
    let d = ""; process.stdin.on("data", c => d += c); process.stdin.on("end", () => {
      let j; try { j = JSON.parse(d); } catch { console.error("files API returned non-JSON"); process.exit(1); }
      const frames = [];
      for (const page of (j.document && j.document.children) || [])
        for (const n of page.children || [])
          if (["FRAME","COMPONENT","COMPONENT_SET","SECTION","GROUP"].includes(n.type))
            frames.push({ page: page.name, name: n.name, id: n.id, type: n.type, full: page.name + "/" + n.name });
      if (mode === "list") {
        console.log("File: " + (j.name || "") + "  (" + frames.length + " frames)");
        for (const f of frames) console.log("  " + f.full.padEnd(48) + " " + f.id + "  " + f.type);
        process.exit(0);
      }
      const norm = s => s.toLowerCase().trim();
      let hit = frames.filter(f => norm(f.full) === want || norm(f.name) === want);
      if (hit.length === 0) hit = frames.filter(f => norm(f.full).includes(want) || norm(f.name).includes(want));
      if (hit.length === 1) { console.log(hit[0].id); process.exit(0); }
      if (hit.length === 0) { console.error("No frame matching \"" + process.argv[2] + "\". Frames: " + frames.map(f => f.full).join(" | ")); process.exit(3); }
      console.error("Ambiguous \"" + process.argv[2] + "\": " + hit.map(f => f.full + " (" + f.id + ")").join(" | ") + ". Use the full Page/Frame name."); process.exit(3);
    });' "$MODE" "$FRAME_NAME") || exit $?
  if [[ "$MODE" == "list" ]]; then printf '%s\n' "$RESOLVED"; exit 0; fi
  NODE_ID="$RESOLVED"
  echo "Frame: $FRAME_NAME → $NODE_ID"
fi

# Figma URLs spell node ids as 12-34; the API wants 12:34 (URL-encoded as 12%3A34).
if [[ "$NODE_ID" != *:* && "$NODE_ID" == *-* ]]; then
  NODE_ID="${NODE_ID//-/:}"
fi
NODE_ENC=$(node -e 'console.log(encodeURIComponent(process.argv[1]))' "$NODE_ID")
OUT="$OUT_DIR/mesh-figma-${NODE_ID//[:\/]/_}.png"

# --- PNG: GET /v1/images/:key?ids=&format=png&scale=2 → { images: { "<id>": "<url>" } } → download ---
IMG_JSON=$(curl -sS -f -H "$AUTH" "$API/v1/images/${FILE_KEY}?ids=${NODE_ENC}&format=png&scale=2") || {
  echo "Figma images API request failed (check FIGMA_TOKEN, fileKey '$FILE_KEY', nodeId '$NODE_ID')" >&2
  exit 1
}

IMG_URL=$(printf '%s' "$IMG_JSON" | node -e '
  let d = ""; process.stdin.on("data", c => d += c); process.stdin.on("end", () => {
    let j; try { j = JSON.parse(d); } catch { console.error("images API returned non-JSON:", d.slice(0, 200)); process.exit(1); }
    if (j.err) { console.error("images API error:", j.err); process.exit(1); }
    const id = process.argv[1];
    const images = j.images || {};
    const url = images[id] || Object.values(images).find(Boolean);
    if (!url) { console.error("Figma could not render node " + id + " (response: " + JSON.stringify(j) + ")"); process.exit(1); }
    console.log(url);
  });
' "$NODE_ID")

curl -sS -fL -o "$OUT" "$IMG_URL" || { echo "PNG download failed from $IMG_URL" >&2; exit 1; }
echo "PNG: $OUT"

# --- Outline: GET /v1/files/:key/nodes?ids= → walk nodes[<id>].document.children ---
NODES_JSON=$(curl -sS -f -H "$AUTH" "$API/v1/files/${FILE_KEY}/nodes?ids=${NODE_ENC}") || {
  echo "Figma nodes API request failed for fileKey '$FILE_KEY' nodeId '$NODE_ID'" >&2
  exit 1
}

printf '%s' "$NODES_JSON" | node -e '
  const MAX_DEPTH = Number(process.argv[2]) || 8;
  let d = ""; process.stdin.on("data", c => d += c); process.stdin.on("end", () => {
    let j; try { j = JSON.parse(d); } catch { console.error("nodes API returned non-JSON:", d.slice(0, 200)); process.exit(1); }
    if (j.err) { console.error("nodes API error:", j.err); process.exit(1); }
    const nodes = j.nodes || {};
    const entry = nodes[process.argv[1]] || Object.values(nodes).find(Boolean);
    if (!entry || !entry.document) { console.error("No document for node " + process.argv[1] + " in response"); process.exit(1); }
    const root = entry.document;
    const bb = root.absoluteBoundingBox || {};
    console.log("");
    console.log(`Frame: ${root.name} (${root.type}) ${Math.round(bb.width || 0)}x${Math.round(bb.height || 0)}${j.name ? `  file: ${j.name}` : ""}`);
    console.log("Outline (name (type) [x,y wxh] — text | font | fill):");
    let truncated = 0;
    walk(root, 0, bb.x || 0, bb.y || 0);
    if (truncated) console.log(`  … ${truncated} deeper node(s) omitted (FIGMA_MAX_DEPTH=${MAX_DEPTH})`);
    function hex(c) {
      const h = (v) => Math.round((v ?? 0) * 255).toString(16).padStart(2, "0");
      return `#${h(c.r)}${h(c.g)}${h(c.b)}`;
    }
    function walk(n, depth, ox, oy) {
      if (!n || n.visible === false) return;
      if (depth > MAX_DEPTH) { truncated++; return; }
      const pad = "  ".repeat(depth);
      const b = n.absoluteBoundingBox;
      // positions relative to the exported frame so they map straight onto CSS
      const box = b ? ` [${Math.round(b.x - ox)},${Math.round(b.y - oy)} ${Math.round(b.width)}x${Math.round(b.height)}]` : "";
      const bits = [];
      if (n.type === "TEXT" && n.characters) {
        const one = String(n.characters).replace(/\s+/g, " ").trim();
        if (one) bits.push(`"${one.slice(0, 120)}${one.length > 120 ? "…" : ""}"`);
        const s = n.style || {};
        const font = [s.fontFamily, s.fontWeight, s.fontSize ? `${s.fontSize}px` : null].filter(Boolean).join(" ");
        if (font) bits.push(font);
      }
      const fill = (n.fills || []).find((f) => f.type === "SOLID" && f.visible !== false && f.color);
      if (fill) bits.push(`fill ${hex(fill.color)}${fill.opacity != null && fill.opacity < 1 ? ` @${Math.round(fill.opacity * 100)}%` : ""}`);
      if (n.cornerRadius) bits.push(`r${n.cornerRadius}`);
      if (n.layoutMode) bits.push(`${n.layoutMode.toLowerCase()} gap ${n.itemSpacing ?? 0}`);
      const name = n.name || n.type || "?";
      console.log(`${pad}- ${name} (${n.type || "?"})${box}${bits.length ? " — " + bits.join(" | ") : ""}`);
      for (const c of n.children || []) walk(c, depth + 1, ox, oy);
    }
  });
' "$NODE_ID" "$MAX_DEPTH"

echo ""
echo "Done. Use the outline above (and PNG at $OUT) to match the frame."
