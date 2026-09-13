#!/usr/bin/env bash
# Install the mesh hooks into a repo's .claude/settings.json (CONTRACT §4).
#
#   hooks/install.sh [path/to/repo]     # default: current directory
#
# Merges five hook entries (UserPromptSubmit, PreToolUse, PostToolUse x2, Stop) that call
# hooks/emit.js by absolute path. Backs up the existing settings first. Re-running
# is safe: previous mesh entries are replaced, other hooks are left alone.
set -euo pipefail

command -v jq >/dev/null || { echo "install.sh: jq is required (brew install jq)"; exit 1; }
command -v node >/dev/null || { echo "install.sh: node is required"; exit 1; }

HOOKS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EMIT="$HOOKS_DIR/emit.js"
TARGET="$(cd "${1:-.}" && pwd)"
SETTINGS="$TARGET/.claude/settings.json"

mkdir -p "$TARGET/.claude"
if [ -f "$SETTINGS" ]; then
  BACKUP="$SETTINGS.bak.$(date +%Y%m%d%H%M%S)"
  cp "$SETTINGS" "$BACKUP"
  echo "backed up  $SETTINGS -> $BACKUP"
else
  echo '{}' > "$SETTINGS"
  echo "created    $SETTINGS"
fi

hook() { jq -n --arg cmd "node \"$EMIT\" $1" '{type:"command", command:$cmd, timeout:3}'; }

jq \
  --argjson prompt "$(hook prompt)" \
  --argjson pre    "$(hook pre_edit)" \
  --argjson file   "$(hook file_touched)" \
  --argjson tool   "$(hook tool_call)" \
  --argjson stop   "$(hook status)" \
  '
  # drop any previous mesh entries (matched by "emit.js" in the command), keep everything else
  def strip: (. // []) | map(.hooks |= map(select(.command | test("emit\\.js") | not))) | map(select(.hooks | length > 0));
  .hooks //= {} |
  .hooks.UserPromptSubmit = ((.hooks.UserPromptSubmit | strip) + [{hooks: [$prompt]}]) |
  .hooks.PreToolUse       = ((.hooks.PreToolUse | strip) + [{matcher: "Edit|Write|MultiEdit", hooks: [$pre]}]) |
  .hooks.PostToolUse      = ((.hooks.PostToolUse | strip)
                              + [{matcher: "Edit|Write|MultiEdit", hooks: [$file]},
                                 {matcher: "mcp__.*",              hooks: [$tool]}]) |
  .hooks.Stop             = ((.hooks.Stop | strip) + [{hooks: [$stop]}])
  ' "$SETTINGS" > "$SETTINGS.tmp" && mv "$SETTINGS.tmp" "$SETTINGS"

echo "installed  5 mesh hooks into $SETTINGS"
echo "           UserPromptSubmit           -> emit.js prompt      (+ team activity into context)"
echo "           PreToolUse Edit|Write|MultiEdit  -> emit.js pre_edit    (warns if a teammate touched the file)"
echo "           PostToolUse Edit|Write|MultiEdit -> emit.js file_touched"
echo "           PostToolUse mcp__.*        -> emit.js tool_call"
echo "           Stop                       -> emit.js status"
echo "next       restart Claude Code in $TARGET, make sure 'mesh join' is running on :7337"
