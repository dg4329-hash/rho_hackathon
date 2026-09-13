# Overlay ↔ daemon contract (v1)

The overlay is a small always-on-top browser window (Chrome/Edge Document Picture-in-Picture; plain popup fallback)
served by the relay at `GET /overlay?room=<room>&port=<daemonPort>` and opened from the room page. It talks to
TWO things: the relay (room feed, who's here) and the owner's LOCAL daemon (pending approvals, messages, decisions).

## Local daemon HTTP (http://localhost:<port>, default 7337) — CORS allowed for the relay's origin only
| method | path | body / query | returns |
|---|---|---|---|
| GET | `/health` | | `{ approvals, user, room, relay, members, owner }` (`approvals` = effective approvals mode) |
| GET | `/pending?wait=25&messages=1&consumer=overlay&since=<ISO>` | long-poll ≤ 25 s; returns early on a new request or message | `{ pending: PendingRequest[], messages: InboxMessage[] }` — `consumer=overlay` + `since` returns messages newer than `since` WITHOUT marking them read (the Claude Code watcher uses the default consumer, which marks read). Always send `consumer=overlay`: it is what keeps the overlay from counting as the Claude Code watcher. In `agent` mode `pending` is always `[]` |
| GET | `/approvals` | | `{ mode, modes: ['auto','overlay','agent','dialog'] }` — `mode` may also be `tty` (legacy / `MESH_APPROVE`); show it as `dialog` |
| POST | `/approvals` | `{ mode: 'auto'\|'overlay'\|'agent'\|'dialog' }` (`tty` accepted) | `{ ok: true, mode }` or 400 `{ ok: false, error }`; saved, survives a daemon restart |
| POST | `/decide` | `{ id, decision: 'approved'\|'denied', reason? }` | `{ ok, id, decision }` or 404 |
| POST | `/message` | `{ to: user\|'all', text }` | `{ ok: true }` |
| GET | `/inbox?unread=0` | | `{ messages: InboxMessage[] }` (history for first paint) |

PendingRequest: `{ id, from, to, why, command?, tool?, args?, createdAt }`.
InboxMessage: `{ id, ts, from, to, text, read }`.

While any client long-polls `/pending`, the daemon treats it as an attached watcher and routes approvals to the
pending queue (no modal OS dialog). If nobody answers within 120 s the daemon falls back to the OS dialog.

Approvals mode (the owner's "where do requests go" setting; CONTRACT §2):
| mode | label | overlay gets | Claude Code monitor gets | nobody attached (60 s) |
|---|---|---|---|---|
| `auto` | Both | requests + messages | requests + messages | OS dialog |
| `overlay` | Overlay only | requests + messages | nothing (messages stay unread for `inbox`) | OS dialog at once |
| `agent` | Claude Code only | messages only (`pending: []`) | requests + messages | OS dialog at once (overlay polls don't count) |
| `dialog` | OS dialog | messages only | messages only | OS dialog |

Detect the mode from `GET /approvals` (or `/health`.approvals) on load and after each POST; in `agent` / `dialog` the
overlay can say "requests go to Claude Code / the OS dialog" instead of an empty requests list. Precedence: saved choice
> `MESH_APPROVE` > `auto`.

## Relay (same origin as the overlay page)
| GET | `/api/rooms/<room>?since=<n>` | `{ members, watchers, events, next }` (poll every 2 s) |

## Overlay UX requirements
- Compact (~360×520), matching the landing page's light/dark system theme. One scrollable panel shows requests first
  (requester, full command or tool+args, `why`, Approve / Deny), then messages (newest first, with a one-line reply box
  → POST /message), then room activity. A failed decision stays visible with a retryable error.
- Never steals focus. New request/message: brief highlight + optional sound toggle (off by default). Title bar shows
  a count of pending items.
- Connection state line: daemon (localhost:port) reachable? relay reachable? Show a one-line fix hint if not.
  The footer's Settings disclosure holds the daemon port, room switch, room key, Leave, and owner-only End session.
- Room page: button "Pop out overlay" → `documentPictureInPicture.requestWindow({ width: 360, height: 520 })` if
  available, else `window.open(url, 'mesh-overlay', 'popup,width=380,height=560')`. Remember the daemon port
  (default 7337) in localStorage; allow changing it in the overlay footer's Settings disclosure.
