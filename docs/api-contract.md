# REST API contract

The source of truth is the code (`src/**/*.controller.ts`, `*.dto.ts`, `*.service.ts`) and `test/rest.e2e-spec.ts`. This file is what the iOS client is built against. If you change a route, change this file in the same commit.

- **Base URL:** production `https://place-rating-api-production.up.railway.app` · local `http://localhost:3000`
- **Format:** JSON, camelCase. Send `Content-Type: application/json`. Unknown body fields are rejected (`400 validation_failed`).
- **Auth:** `Authorization: Bearer <accessToken>` on everything except `/auth/*`, `/health` and `GET /photos/...`.
- **Timestamps:** ISO-8601 UTC **with milliseconds**, e.g. `2026-11-11T06:54:12.345Z`. Swift's default `.iso8601` decoder rejects the fractional part; use a custom strategy (see `ios-app-brief.md`).
- **Ids:** UUID strings. A malformed id in a path gives `400 invalid_id`.
- **Pagination:** only `GET /places/:id/ratings`. `?limit=` (default 20, max 50) and `?cursor=` (opaque, copy `nextCursor` from the previous page). `nextCursor` is `null` on the last page.

## Errors

Every error, including 404s for unknown routes and 5xx, has this shape:

```json
{ "error": { "code": "username_taken", "message": "That username is already taken" } }
```

Switch on `code`, show `message` only for debugging.

| Status | `code` | When |
| --- | --- | --- |
| 400 | `validation_failed` | Body or query failed validation; `message` lists the problems joined by `; ` |
| 400 | `invalid_id` | A path id is not a UUID |
| 400 | `invalid_cursor` | Bad pagination cursor |
| 400 | `invalid_bbox` | Malformed box, out of range, min ≥ max, or wider than 5 degrees |
| 400 | `invalid_target` | Friending/blocking/reporting yourself, or reporting your own rating |
| 400 | `invalid_key` | Photo upload key does not belong to you |
| 400 | `invalid_avatar` | `PATCH /me` `avatar` is not a valid character: unknown style, option or value |
| 401 | `unauthorized` | Missing, invalid or expired access token; bad Apple token; bad/used refresh token; account deleted |
| 403 | `username_required` | The account has not picked a username yet. Every signed-in route except `/me` and `/users/availability` returns this until `PATCH /me {username}` succeeds |
| 404 | `not_found` | Unknown route or resource. Blocked and deleted users also look "not found" |
| 409 | `username_taken`, `already_friends` | |
| 422 | `username_reserved`, `invalid_image`, `image_too_large` | |
| 429 | `rate_limited` | See the limits table |
| 500 | `internal_error` | Bug on our side |

Other generic codes can appear from the framework: `bad_request`, `forbidden`, `conflict`, `unprocessable`, `method_not_allowed`, `payload_too_large`, `unsupported_media_type`.

## Shared types

```text
Avatar          { style: string, options: { [option]: string } }
                  a DiceBear 9.4.2 character; the app draws it, the server only checks it
PublicUser      { id, username: string | null, displayName, avatar: Avatar | null }
                  avatar is null until the person picks a character
PlacePhoto      { id, kind: "place" | "menu", url, thumbnailUrl, width, height, createdAt, user: PublicUser }
                  url: JPEG at most 1600 px; thumbnailUrl: 400 px square; both absolute and immutable
SelfUser        PublicUser + { ghostMode: boolean, createdAt }
Place           { id, appleId: string | null, name, category: string | null,
                  latitude, longitude, avgRating: number, ratingCount: number }
                  avgRating is 0 when ratingCount is 0, otherwise rounded to 2 decimals
MyRating        { id, stars: 1..5, comment: string | null, updatedAt }
Rating          { id, stars, comment: string | null, createdAt, updatedAt }
PlaceRating     Rating + { user: PublicUser }
FriendshipEntry { id, user: PublicUser, since }      id is the friendship id
AuthResponse    { accessToken, refreshToken, expiresIn: seconds (900), needsOnboarding: boolean, user: SelfUser }
```

Character styles (DiceBear 9.4.2, the same version in the app and the server): `adventurer avataaars bigEars bigSmile croodles dylan lorelei micah miniavs notionists openPeeps personas pixelArt toonHead`. `options` maps an option of that style to one of its values, to a 6-digit lowercase hex colour for colour options, or to `none` for parts the style can leave out (it has a matching `…Probability` option). Picture settings (`seed`, `backgroundColor`, `scale`, `flip` and similar) and `…Probability` options are refused. New accounts have no avatar.

## Auth

| Request | Response |
| --- | --- |
| `POST /auth/apple` `{identityToken, nonce?, fullName?}` | `200 AuthResponse`. Creates the account on first sign-in. `identityToken` 20–8192 chars; `nonce` is the **raw** nonce (the app sent its SHA-256 hex to Apple); `fullName` ≤ 60 chars, only available to the app on the very first Apple sign-in, so send it then. `needsOnboarding` is `true` until a username is set. Errors: `401 unauthorized` (token invalid, wrong audience = bundle id, nonce mismatch) |
| `POST /auth/refresh` `{refreshToken}` | `200 AuthResponse` with a **new** refresh token. The old one is dead after this call. Presenting an already-used refresh token revokes the whole session family (theft protection) and returns `401`, except within 30 seconds of its use: then the call succeeds and replaces the session's live token, so a client that lost the response can retry. Persist the new token before doing anything else, and never run two refreshes in parallel |
| `POST /auth/logout` `{refreshToken}` | `204`. Revokes that session (also `204` when the token is unknown). The current access token stays valid until it expires |
| `POST /auth/dev` `{username}` | `200 AuthResponse`. **Local development only**: `404` unless `DEV_AUTH_ENABLED=true`; the server refuses to boot with it on in production |

Access tokens last 15 minutes (`expiresIn`), refresh tokens 30 days. Sign-in calls are limited to 30 per minute per IP (apple + refresh share the counter).

## Me

| Request | Response |
| --- | --- |
| `GET /me` | `SelfUser` |
| `PATCH /me` `{username?, displayName?, ghostMode?, avatar?}` | `200 SelfUser`. `username`: 3–20 chars of `a-z 0-9 _ .`, trimmed and lowercased by the server, unique, can be changed but never cleared (`null` gives `400 validation_failed`); reserved: `admin administrator support help root moderator official staff null undefined`. `displayName`: 1–40 chars. `avatar`: a character `{style, options}` as described under Shared types; anything else gives `400 invalid_avatar`. `ghostMode` also updates a live socket immediately. Errors: `409 username_taken`, `422 username_reserved` |
| `DELETE /me` | `204`. Deletes ratings, friendships, blocks, sessions and the person's place photos (with their files), anonymises the row, recomputes place averages, tells friends' sockets the marker is gone. The current access token stops working right away (`401`) |


## Users

`GET /users/search?q=` → `200 { items: [PublicUser + { friendStatus }] }`. `q` is 3–20 chars, lowercased, prefix match on username. Max 20 results, ordered by username, never yourself, blocked people (either direction) or deleted accounts. `friendStatus` is `none | friends | request_sent | request_received`. 60 per hour.

`GET /users/availability?username=` → `200 { available: boolean, reason: "taken" | "reserved" | "invalid" | null }`. For the username picker, so it works before the account has a username. `username` is 1–64 chars, trimmed and lowercased; a badly formed name answers `invalid` rather than an error. Your own current username counts as available. `PATCH /me` can still return `409 username_taken` if someone saves it first. 300 per hour.

## Places and ratings

| Request | Response |
| --- | --- |
| `GET /places?bbox=minLng,minLat,maxLng,maxLat` | `200 { items: Place[] }`, at most 200, most-rated first. The box may span at most 5° in each direction. **It returns every known place in the box, including ones nobody rated yet (`ratingCount: 0`); the client shows pins only for `ratingCount > 0`.** |
| `POST /places/resolve` `{appleId?, name, category?, latitude, longitude}` | `200 Place`. Find-or-create for the point of interest the person tapped. `name` 1–120, `category` ≤ 60, `appleId` ≤ 200 (`MKMapItem.identifier`). With `appleId` the place is matched on it; without, on the same name (case-insensitive) within 30 m. An existing place is never renamed or moved by a client. 120 per hour |
| `GET /places/:id` | `200 Place + { myRating: MyRating \| null }` |
| `GET /places/:id/ratings?limit&cursor` | `200 { items: PlaceRating[], nextCursor }`, newest first, hides blocked people and deleted accounts. Friends are not sorted first: the client fetches `/friends` and groups by `user.id` |
| `PUT /places/:id/rating` `{stars: 1..5, comment?: string \| null}` | `200 { rating: Rating, place: Place }`. Create-or-replace, **idempotent**: repeating the same body changes nothing (not even `updatedAt`). `comment` ≤ 280 chars after trimming; `null` or missing clears it. The returned `place` carries the new average |
| `DELETE /places/:id/rating` | `204`, also when there was nothing to delete. `place` average is recomputed |

Rating writes (PUT and DELETE together) are limited to 30 per hour. A rating saves when a star is tapped; the comment saves when its field loses focus (both are a `PUT` with the current stars and comment).

## Place photos

People add photos of a place or of its menu. The upload goes straight to the private bucket, then the server checks and re-encodes it.

| Request | Response |
| --- | --- |
| `POST /places/:id/photos/upload-url` `{contentType: "image/jpeg" \| "image/png", contentLength: 1..10485760}` | `200 {key, uploadUrl, method: "PUT", headers: {"Content-Type": ...}, expiresIn: 300}`. `404` for an unknown place. 30 per hour |
| `POST /places/:id/photos` `{kind: "place" \| "menu", key}` | `201 PlacePhoto`. Re-encodes to a JPEG of at most 1600 px plus a 400 px square thumbnail, EXIF removed, and deletes the raw upload. Errors: `400 invalid_key`, `404 not_found` (unknown place, or nothing uploaded under that key), `422 image_too_large`, `422 invalid_image`. 60 per day |
| `GET /places/:id/photos?kind&limit&cursor` | `200 { items: PlacePhoto[], nextCursor }`, newest first, optional `kind` filter, paged like ratings. Hides blocked people and deleted accounts |
| `DELETE /places/:id/photos/:photoId` | `204`. Only the person who added it; anyone else gets `404` |
| `GET /photos/:placeId/:file.jpg` | **Public, no token.** `200 image/jpeg`, `Cache-Control: public, max-age=31536000, immutable`. These are the `url` and `thumbnailUrl` addresses. `404` for anything else |

Upload recipe: (1) `POST upload-url` with the exact byte count of the file; (2) `PUT` the file bytes to `uploadUrl` with exactly the returned `headers` and exactly that many bytes (type and length are part of the signature, a mismatch is rejected by the bucket); (3) `POST /places/:id/photos {kind, key}`. Convert HEIC to JPEG on the phone first.

## Friends and blocks

| Request | Response |
| --- | --- |
| `GET /friends` | `200 { friends, incoming, outgoing }`, each `FriendshipEntry[]` ordered by username. `incoming` are requests others sent you (accept with the entry's `id`), `outgoing` are requests you sent |
| `POST /friends/requests` `{userId}` | `200 { id, status: "pending" \| "accepted" }`. If that person already asked you, this accepts their request and returns `accepted`. Re-sending is harmless. `400 invalid_target` (yourself), `404 not_found` (unknown, deleted or blocked either way), `409 already_friends`. 20 per day |
| `POST /friends/requests/:id/accept` | `204`. `:id` is the friendship id from `incoming[].id`. `404` if it is not a pending request addressed to you |
| `DELETE /friends/:userId` | `204`, idempotent. `:userId` is the other **user** id. Removes a friend, cancels a request you sent, or declines one you received |
| `GET /blocks` | `200 { items: PublicUser[] }` newest first |
| `POST /blocks` `{userId}` | `204`. Also removes any friendship or request between you. `400 invalid_target`, `404 not_found` |
| `DELETE /blocks/:userId` | `204`. Does not restore the friendship |

Friend changes and blocks take effect on a connected live socket immediately (people appear or get a `gone` frame).

## Reports

`POST /reports` `{targetType: "user" | "rating" | "photo", targetId, reason: "spam" | "abuse" | "inappropriate" | "impersonation" | "other", details?: ≤500}` → `201 { id, status: "open" }`. For `user` the `targetId` is the user id, for `rating` the rating id, for `photo` the photo id. `400 invalid_target` (yourself, your own rating or your own photo), `404 not_found`. 20 per day. There is no admin UI yet: reports are read in SQL (see `operations.md`).

## Health

`GET /health` → `200 {"status":"ok","db":"up","redis":"up"}`; `503` when Postgres or Redis does not answer.

## Rate limits

Counted per signed-in user in Redis (fixed windows), except sign-in which is per IP. A `429 rate_limited` has no `Retry-After`; back off and retry later.

| What | Limit |
| --- | --- |
| Rating writes (PUT + DELETE) | 30 / hour |
| Friend requests | 20 / day |
| Username searches | 60 / hour |
| Username availability checks | 300 / hour |
| Photo upload URLs | 30 / hour |
| New place photos | 60 / day |
| Reports | 20 / day |
| `POST /places/resolve` | 120 / hour |
| `POST /auth/apple` + `/auth/refresh` | 30 / minute per IP |

## Where this differs from the original design spec

The spec (`product-spec.md`) was written before the code. Build the client against **this** file:

- `POST /auth/apple` returns `needsOnboarding` (not `isNew`) and `expiresIn`.
- Avatars are DiceBear characters (`{style, options}`), not presets or uploaded photos; photos belong to places instead (`/places/:id/photos`).
- `GET /places` items have no `myStars`; `GET /places/:id` has `myRating`. Friends' ratings come from `GET /places/:id/ratings` plus `/friends`.
- `PUT rating` returns `{rating, place}`; `DELETE rating` returns `204` with no body (re-fetch the place if you need the average).
- `GET /places` also returns unrated places (filter on `ratingCount > 0`).
- Usernames may contain `.` as well as letters, digits and `_`.
- Photos and thumbnails are produced on the server and served by the API at `/photos/...`, not from a bucket URL.
