#!/usr/bin/env bash
# Deploy mesh relay to Railway (monorepo root as context).
# Prerequisites: npx @railway/cli login (once), Docker builder enabled on the project.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if ! command -v railway >/dev/null 2>&1 && ! npx -y @railway/cli@latest --version >/dev/null 2>&1; then
  echo "Railway CLI not available. Until it is, expose a laptop relay with: ./scripts/tunnel-relay.sh" >&2
  exit 1
fi
if ! npx -y @railway/cli@latest whoami >/dev/null 2>&1; then
  echo "Not logged in to Railway. Run: npx @railway/cli login   (or use ./scripts/tunnel-relay.sh for now)" >&2
  exit 1
fi

echo "Linking / deploying with Dockerfile apps/relay/Dockerfile …"
npx -y @railway/cli@latest up --dockerfile apps/relay/Dockerfile --service mesh-relay || \
  npx -y @railway/cli@latest up --dockerfile apps/relay/Dockerfile

echo ""
echo "After deploy, copy the public HTTPS host and use wss://<host> as the relay URL."
echo "Paste into docs/PLAN.md §2 and update local team.json relay field."
echo "Health: curl https://<host>/health"
