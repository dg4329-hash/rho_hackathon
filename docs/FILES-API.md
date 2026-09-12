# Artifacts (files / images / PDFs) between agents — contract v1

Files never travel inside WebSocket frames. The OWNER's daemon uploads them to the relay; results and messages
carry small artifact descriptors; the REQUESTER's daemon downloads on demand. Room name gates access, like everything.

## Types (packages/protocol)
```ts
interface Artifact { id: string; name: string; mime: string; size: number; url: string /* absolute, on the relay */ ; sha256?: string }
// ResultFrame gains:   artifacts?: Artifact[]
// EventFrame kind 'file': data = { to: user|'all', artifact: Artifact, note?: string }
// JobResult gains:      artifacts?: Artifact[]
// InboxMessage gains:   artifact?: Artifact   (a 'file' event lands in the recipient's inbox as a message with text = note ?? `sent ${name}`)
```

## Relay
| method | path | body | returns |
|---|---|---|---|
| POST | `/api/files/<room>` | raw bytes; headers `x-mesh-name`, `x-mesh-mime` (fallback application/octet-stream), `x-mesh-from` | `201 { id, name, mime, size, url }` |
| GET | `/api/files/<room>/<id>` | | bytes with `content-type`, `content-disposition: inline; filename=…`, `cache-control: private, max-age=3600` |
| GET | `/api/files/<room>/<id>/meta` | | `{ id, name, mime, size, from, ts }` |
Limits: 25 MB per file (413 otherwise), 200 MB per relay total (LRU eviction), TTL 1 h (then 404). In memory; no disk. CORS same policy as other /api routes.

## Owner daemon (produces artifacts)
1. **Shell commands:** any stdout line matching `^MESH_FILE:\s*(.+)$` names a file to ship. After the command exits, the daemon uploads each existing file (path relative to the command's cwd or absolute), strips nothing from output, and attaches `artifacts` to the `result` frame. Also treat `^PNG:\s*(.+\.png)$` the same way (figma-export.sh compat) — and update scripts/figma-export.sh to print `MESH_FILE: <png>` too.
2. **MCP tools:** if `callTool` returns `image` content (base64 + mimeType) or an embedded `resource` with blob, upload each as an artifact named `<tool>-<n>.<ext>`; text parts still flatten into `tail`.
3. **`send_file` MCP tool** `{ to: user|'all', path: string, note?: string }` → uploads the file (must be under the daemon's cwd or ~/.mesh; reject others) and emits `event` kind `file`. Returns the Artifact.
4. Upload failures never fail the job: log a warning and add `artifactErrors: string[]` to the result.

## Requester daemon (consumes artifacts)
1. `ask_teammate` / `check_job` results include `artifacts` (from the result frame) — description text must say "download with fetch_artifact".
2. **`fetch_artifact` MCP tool** `{ url?: string, id?: string, saveAs?: string }` → downloads to `<cwd>/mesh-artifacts/<from>/<name>` (creates dirs; `saveAs` overrides the filename; never outside cwd), returns `{ path, name, mime, size }` AND, when mime starts with `image/` and size ≤ 5 MB, ALSO returns an MCP `image` content part so the model can see it. For `text/*` or JSON ≤ 200 KB include the text as a second content part.
3. Inbox: a `file` event becomes an inbox message with `artifact` set; the hook's prompt block lists it as `- 19:40 tarush sent onboarding-step2.png (184 KB) → fetch_artifact`.

## Overlay / room page
Artifacts render as chips (name · size) linking to the relay URL in the feed and in messages.

## Tool descriptions (verbatim)
- `send_file`: "Send a file from this machine to a teammate's agent ('all' = everyone). Path must be inside the project or ~/.mesh. The recipient's agent downloads it with fetch_artifact."
- `fetch_artifact`: "Download an artifact a teammate produced (from ask_teammate results, inbox, or team_activity) into ./mesh-artifacts/. Images are also returned inline so you can look at them."
