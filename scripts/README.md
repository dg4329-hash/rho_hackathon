Tarush: offered commands go here. See `docs/tasks/TARUSH.md`. Never commit tokens.

## `figma-export.sh`

```bash
export FIGMA_TOKEN=…          # local env only
./scripts/figma-export.sh <fileKey> <nodeId>
```

On Windows, run via Git Bash or WSL (not PowerShell). Prints a PNG path under `/tmp` and an indented node outline.
