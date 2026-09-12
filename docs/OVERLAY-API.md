# Overlay ↔ daemon contract (v1)

The overlay is a small always-on-top browser window (Chrome/Edge Document Picture-in-Picture; plain popup fallback)
served by the relay at `GET /overlay?room=<room>&port=<daemonPort>` and opened from the room page. It talks to
TWO things: the relay (room feed, who's here) and the owner's LOCAL daemon (pending approvals, messages, decisions).

## Local daemon HTTP (http://localhost:<port>, default 7337) — CORS allowed for the relay's origin only
| method | path | body / query | returns |
|---|---|---|---|
| GET | `/health` | | `{ user, room, relay, members }` |
| GET | `/pending?wait=25&messages=1&consumer=overlay&since=<ISO>` | long-poll ≤ 25 s; returns early on a new request or message | `{ pending: PendingRequest[], messages: InboxMessage[] }` — `consumer=overlay` + `since` returns messages newer than `since` WITHOUT marking them read (the Claude Code watcher uses the default consumer, which marks read) |
| POST | `/decide` | `{ id, decision: 'approved'\|'denied', reason? }` | `{ ok, id, decision }` or 404 |
| POST | `/message` | `{ to: user\|'all', text }` | `{ ok: true }` |
| GET | `/inbox?unread=0` | | `{ messages: InboxMessage[] }` (history for first paint) |

PendingRequest: `{ id, from, to, why, command?, tool?, args?, createdAt }`.
InboxMessage: `{ id, ts, from, to, text, read }`.

While any client long-polls `/pending`, the daemon treats it as an attached watcher and routes approvals to the
pending queue (no modal OS dialog). If nobody answers within 120 s the daemon falls back to the OS dialog.

## Relay (same origin as the overlay page)
| GET | `/api/rooms/<room>?since=<n>` | `{ members, watchers, events, next }` (poll every 2 s) |

## Overlay UX requirements
- Compact (~360×520), dark, readable at a glance. Sections: pending requests (top, with Approve / Deny buttons, the
  `why`, the command or tool+args), messages (newest first, with a one-line reply box → POST /message), live feed (compact).
- Never steals focus. New request/message: brief highlight + optional sound toggle (off by default). Title bar shows
  a count of pending items.
- Connection state line: daemon (localhost:port) reachable? relay reachable? Show a one-line fix hint if not.
- Room page: button "Pop out overlay" → `documentPictureInPicture.requestWindow({ width: 360, height: 520 })` if
  available, else `window.open(url, 'mesh-overlay', 'popup,width=380,height=560')`. Remember the daemon port
  (default 7337) in localStorage; allow changing it in the overlay footer.
