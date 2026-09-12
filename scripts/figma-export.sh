#!/usr/bin/env bash
# Export a Figma frame to PNG + a readable text outline for coding agents.
# Usage: ./scripts/figma-export.sh <fileKey> <nodeId>
# Requires: FIGMA_TOKEN in the environment. Never commit the token.
set -euo pipefail

FILE_KEY="${1:-}"
NODE_ID="${2:-}"

if [[ -z "$FILE_KEY" || -z "$NODE_ID" ]]; then
  echo "Usage: figma-export.sh <fileKey> <nodeId>" >&2
  exit 2
fi

if [[ -z "${FIGMA_TOKEN:-}" ]]; then
  echo "FIGMA_TOKEN is not set in the environment." >&2
  exit 1
fi

# Figma API wants node ids URL-encoded (e.g. 12:34 → 12%3A34)
NODE_ENC=$(node -e "console.log(encodeURIComponent(process.argv[1]))" "$NODE_ID")

OUT="/tmp/mesh-figma-${NODE_ID//[:\/]/_}.png"
AUTH="X-Figma-Token: ${FIGMA_TOKEN}"

# --- PNG ---
IMG_JSON=$(curl -sS -H "$AUTH" \
  "https://api.figma.com/v1/images/${FILE_KEY}?ids=${NODE_ENC}&format=png&scale=2")

IMG_URL=$(printf '%s' "$IMG_JSON" | node -e '
  let d=""; process.stdin.on("data",c=>d+=c); process.stdin.on("end",()=>{
    const j=JSON.parse(d);
    if (j.err) { console.error(j.err); process.exit(1); }
    const id=process.argv[1];
    const url=j.images && (j.images[id] || Object.values(j.images)[0]);
    if (!url) { console.error("No image URL in response:", JSON.stringify(j)); process.exit(1); }
    console.log(url);
  });
' "$NODE_ID")

curl -sS -o "$OUT" "$IMG_URL"
echo "PNG: $OUT"

# --- Text outline ---
NODES_JSON=$(curl -sS -H "$AUTH" \
  "https://api.figma.com/v1/files/${FILE_KEY}/nodes?ids=${NODE_ENC}")

printf '%s' "$NODES_JSON" | node -e '
  let d=""; process.stdin.on("data",c=>d+=c); process.stdin.on("end",()=>{
    const j=JSON.parse(d);
    if (j.err) { console.error(j.err); process.exit(1); }
    const nodes=j.nodes || {};
    const entry=Object.values(nodes)[0];
    if (!entry || !entry.document) {
      console.error("No document node in response");
      process.exit(1);
    }
    console.log("");
    console.log("Outline:");
    walk(entry.document, 0);
  });

  function walk(n, depth) {
    if (!n) return;
    const pad="  ".repeat(depth);
    const name=n.name || n.type || "?";
    const box=n.absoluteBoundingBox
      ? ` [${Math.round(n.absoluteBoundingBox.x)},${Math.round(n.absoluteBoundingBox.y)} ${Math.round(n.absoluteBoundingBox.width)}x${Math.round(n.absoluteBoundingBox.height)}]`
      : "";
    let text="";
    if (n.type==="TEXT" && n.characters) {
      const one=String(n.characters).replace(/\s+/g," ").trim();
      if (one) text=` — "${one.slice(0,120)}${one.length>120?"…":""}"`;
    }
    console.log(`${pad}- ${name} (${n.type||"?"})${box}${text}`);
    const kids=n.children || [];
    for (const c of kids) walk(c, depth+1);
  }
'

echo ""
echo "Done. Use the outline above (and PNG at $OUT) to match the frame."
