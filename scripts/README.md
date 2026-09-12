Tarush: offered commands go here. See `docs/tasks/TARUSH.md`. Never commit tokens.

## `figma-export.sh`

```bash
export FIGMA_TOKEN=…          # local env only
./scripts/figma-export.sh <fileKey> <nodeId>
```

On Windows, run via Git Bash or WSL (not PowerShell). Prints a PNG path under `/tmp` and an indented node outline.

## `tunnel-relay.sh` — public relay without Railway

```bash
./scripts/tunnel-relay.sh            # relay on :8090 + ngrok; prints wss://<host>.ngrok-free.dev
PORT=8080 ./scripts/tunnel-relay.sh
```

Needs `ngrok` with an authtoken (`ngrok config add-authtoken …`). Keep the terminal open; Ctrl-C stops both.
Paste the printed `wss://` URL into `team.json` `"relay"` or pass `mesh join … --relay wss://…`.
Logs: `.local/relay.log`, `.local/ngrok.log`.

## `deploy-relay.sh` — Railway (needs Railway CLI + Docker; not yet done)

## `team.json.starter`

Starter content for `mesh init`. Validate any team.json from the repo root with
`pnpm -F relay validate ./team.json`.

## Relay tests

```bash
pnpm -F relay test                       # CONTRACT §1 acceptance (spawns the relay on a free port)
RELAY_URL=wss://<host> pnpm -F relay test # same suite against a running/public relay
pnpm -F relay soak                       # 80-frame output soak + late joiner (relay must be running on :8080 or RELAY_URL)
```

