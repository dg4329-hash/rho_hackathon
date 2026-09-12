#!/usr/bin/env bash
# One-command public relay: starts apps/relay on $PORT and exposes it through ngrok.
# Prints the wss:// URL teammates put in team.json "relay" (and `mesh join --relay`).
# Keep this terminal open for the whole session; Ctrl-C stops both processes.
#
#   ./scripts/tunnel-relay.sh            # PORT=8090 by default
#   PORT=8080 ./scripts/tunnel-relay.sh
#   NGROK_DOMAIN=my-static.ngrok-free.app ./scripts/tunnel-relay.sh   # reuse a reserved domain
#
# Prerequisites: `ngrok` on PATH with an authtoken configured (`ngrok config add-authtoken …`),
# pnpm install done (@mesh/protocol is imported straight from src/, no build step).
# This is the stop-gap until the Railway deploy (scripts/deploy-relay.sh) is set up.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${PORT:-8090}"
NGROK_API="${NGROK_API:-http://127.0.0.1:4040}"
LOG_DIR="${LOG_DIR:-$ROOT/.local}"
mkdir -p "$LOG_DIR"

if ! command -v ngrok >/dev/null 2>&1; then
  echo "ngrok is not installed. brew install ngrok, then: ngrok config add-authtoken <token>" >&2
  exit 1
fi
if ! ngrok config check >/dev/null 2>&1; then
  echo "ngrok has no valid config/authtoken. Run: ngrok config add-authtoken <token>" >&2
  exit 1
fi
if command -v lsof >/dev/null 2>&1 && lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "port $PORT is already in use; stop that process or set PORT=<other>" >&2
  exit 1
fi

if curl -fsS "$NGROK_API/api/tunnels" >/dev/null 2>&1; then
  echo "another ngrok is already running (API at $NGROK_API); stop it first: pkill -x ngrok" >&2
  exit 1
fi

RELAY_PID=""
NGROK_PID=""
# Kill a process and everything it spawned (pnpm/tsx wrappers, ngrok workers).
kill_tree() {
  local pid="$1"
  [[ -z "$pid" ]] && return 0
  if command -v pgrep >/dev/null 2>&1; then
    local child
    for child in $(pgrep -P "$pid" 2>/dev/null || true); do kill_tree "$child"; done
  fi
  kill "$pid" 2>/dev/null || true
}
cleanup() {
  trap - EXIT INT TERM
  echo ""
  echo "stopping relay + ngrok …"
  kill_tree "$NGROK_PID"
  kill_tree "$RELAY_PID"
  wait 2>/dev/null || true
  echo "stopped."
}
trap cleanup EXIT
trap 'cleanup; exit 130' INT
trap 'cleanup; exit 143' TERM

cd "$ROOT"
# Run node directly (no pnpm wrapper) so RELAY_PID is the relay itself and Ctrl-C/kill reach it.
PORT="$PORT" node --import tsx apps/relay/src/index.ts >"$LOG_DIR/relay.log" 2>&1 &
RELAY_PID=$!

for _ in $(seq 1 50); do
  if curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then break; fi
  sleep 0.2
done
if ! curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
  echo "relay did not come up on :$PORT — see $LOG_DIR/relay.log" >&2
  exit 1
fi
echo "relay listening on http://127.0.0.1:$PORT  (log: $LOG_DIR/relay.log)"

NGROK_ARGS=(http "$PORT" --log=stdout --log-format=json)
[[ -n "${NGROK_DOMAIN:-}" ]] && NGROK_ARGS+=(--domain "$NGROK_DOMAIN")
ngrok "${NGROK_ARGS[@]}" >"$LOG_DIR/ngrok.log" 2>&1 &
NGROK_PID=$!

PUBLIC_URL=""
for _ in $(seq 1 60); do
  PUBLIC_URL=$(curl -fsS "$NGROK_API/api/tunnels" 2>/dev/null \
    | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{const t=(JSON.parse(d).tunnels||[]).find(t=>String(t.public_url).startsWith("https://"));if(t)console.log(t.public_url)}catch{}})' \
    || true)
  [[ -n "$PUBLIC_URL" ]] && break
  if ! kill -0 "$NGROK_PID" 2>/dev/null; then
    echo "ngrok exited — see $LOG_DIR/ngrok.log" >&2
    exit 1
  fi
  sleep 0.5
done
if [[ -z "$PUBLIC_URL" ]]; then
  echo "could not read a public https URL from $NGROK_API/api/tunnels — see $LOG_DIR/ngrok.log" >&2
  exit 1
fi

HOST="${PUBLIC_URL#https://}"
WSS_URL="wss://$HOST"
HEALTH=$(curl -fsS "$PUBLIC_URL/health" 2>/dev/null || echo "unreachable")

echo ""
echo "================================================================"
echo "  relay is public"
echo "  wss URL : $WSS_URL"
echo "  health  : $PUBLIC_URL/health  →  $HEALTH"
echo ""
echo "  team.json  →  \"relay\": \"$WSS_URL\""
echo "  or         →  mesh join <room> --as <user> --relay $WSS_URL"
echo "================================================================"
echo "Keep this terminal open. Ctrl-C stops the relay and the tunnel."
echo ""

# Stay attached; exit (and clean up) if either child dies.
while kill -0 "$RELAY_PID" 2>/dev/null && kill -0 "$NGROK_PID" 2>/dev/null; do
  sleep 2
done
echo "relay or ngrok exited unexpectedly — see $LOG_DIR/relay.log and $LOG_DIR/ngrok.log" >&2
exit 1
