# Live location protocol (`/live`)

Code: `src/live/live.protocol.ts` (wire format and validation), `live.service.ts` (rules), `live.gateway.ts`, `live.adapter.ts` (auth on upgrade). Tests: `test/live.e2e-spec.ts`. Check a running server with `npm run smoke` or `npx wscat`.

## Connecting

`wss://place-rating-api-production.up.railway.app/live` (local: `ws://localhost:3000/live`) with the header `Authorization: Bearer <accessToken>` on the upgrade request. With `URLSessionWebSocketTask` build a `URLRequest`, set that header, then `webSocketTask(with: request)`. A bad or expired token gets an **HTTP 401 during the handshake** and never becomes a socket, so refresh the access token first (it only lives 15 minutes) and retry. An account with no username yet gets an **HTTP 403** instead: finish onboarding first, refreshing will not help.

One connection per person: connecting again closes the older socket with `4409`.

## Frames

Every frame is a JSON text message `{ "t": "<type>", "d": { ... } }`. Frames over 2 KB are refused (close `1009`). Coordinates are rounded to 6 decimals by the server.

| Direction | `t` | `d` | Meaning |
| --- | --- | --- | --- |
| client → server | `loc` | `{ lat, lng, accuracy, heading, ts }` | Your position. `lat` −90…90, `lng` −180…180, `accuracy` metres (≥ 0, **> 100 is rejected**), `heading` degrees 0…359.99, or `-1`/`null` when unknown, `ts` epoch **milliseconds** (the server uses its own clock if yours is more than 60 s off) |
| client → server | `ghost` | `{ on: Bool }` | Hide yourself or show again. Saved on your profile, survives reconnects |
| server → client | `hello` | `{ userId, ghost, friends: [{ userId, lat, lng, accuracy, heading, ts }], serverTime }` | First frame after every connect: your ghost state and the last known position of each friend who is sharing right now |
| server → client | `loc` | `{ userId, lat, lng, accuracy, heading, ts }` | A friend moved (or just became visible) |
| server → client | `gone` | `{ userId }` | Remove that marker: they disconnected, went ghost, removed or blocked you, or deleted their account |
| server → client | `ghost` | `{ on }` | Confirms your ghost setting (also sent when you change it through `PATCH /me`) |
| server → client | `error` | `{ code, message }` | Your last frame was rejected. Codes: `invalid_loc`, `accuracy_too_low`, `invalid_ghost` |

Unknown or unparseable frames are dropped silently. WebSocket-level ping frames come from the server every 20 s; `URLSessionWebSocketTask` answers them automatically, so no app-level ping is needed. A socket that misses a ping interval is terminated.

## Close codes

| Code | Meaning | What the app does |
| --- | --- | --- |
| 4401 | Unauthorized (unknown user) | Refresh the token; if that fails sign out |
| 4403 | Account deleted | Sign out, clear local data |
| 4409 | Replaced by a newer connection of yours (another device or a stale socket) | **Do not auto-reconnect**, or two devices will fight forever. Mark sharing as paused and reconnect only when the user brings the app to the foreground |
| 4429 | Flooded (> 60 frames per 10 s) | Back off for a long time (≥ 30 s); it is a client bug |
| 4400 | More than 10 invalid frames | Same as 4429 |
| 1009 | Frame too big | Client bug |
| 1011 | Server could not start your session | Treat as a normal drop, reconnect with backoff |

## Server rules the client can rely on

- Only **accepted, non-blocked friends** receive your position, and only while you are not in ghost mode. You only receive friends who can see you too (the relationship must hold in both directions).
- Updates from one person closer than **2 s** apart are dropped without an error. Validation runs first, so an invalid frame still gets its `error`.
- Your latest fix lives only in Redis (`loc:{userId}`) and **expires after 60 s** without a new `loc`. On disconnect or ghost it is deleted and friends get `gone`. Nothing is written to Postgres; there is no history.
- Accepted `loc` positions are also compared with friends' positions for "a friend is nearby" pushes (at most once a minute per person, see `api-contract.md`, Push notifications). That comparison happens in the server; nothing extra is sent on the socket.
- Friend requests accepted/removed, blocks and account deletions made through REST update the live graph immediately (new friends appear with `loc`, former friends get `gone`). The server also re-reads the friend list every 60 s as a safety net.

## What the client does

Sending (spec rules):

- Send at most one `loc` every **3 s**, and skip a fix that moved less than **10 m** since the last one sent.
- Still send a **heartbeat `loc` every 15 s** while standing still, so the server's 60 s expiry never lapses.
- Do not send fixes with `horizontalAccuracy` > 100 m or < 0 (CoreLocation uses negative values for "invalid").
- Sharing works only in the foreground: close the socket when the scene leaves `.active` (and stop location updates); reconnect when it returns. The server drops your position within 60 s.

Receiving:

- Keep a `[UserID: FriendFix]` dictionary. `hello` **replaces** it entirely (it is a snapshot), `loc` upserts, `gone` removes.
- A marker **dims after 30 s** without an update and is **removed after 60 s**, so a dropped connection never leaves a frozen friend on the map. Use a timer on the receive side, not the server's clock alone.
- Never log coordinates.

Reconnecting: backoff 1, 2, 4, 8, 16, then every 30 s, each with random jitter (±20 %), reset after a successful `hello`. Show the offline banner and dim markers while disconnected. On every reconnect wait for `hello` before treating the dictionary as current.

## Limitations

Fan-out happens in the memory of the one API process that holds the sockets (`LiveService`). Run **a single API instance**; with more, friends on another instance would miss pushes (see README "Things to know before shipping" for the Redis pub/sub fix).
