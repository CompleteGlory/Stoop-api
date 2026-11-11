# REST API contract

The source of truth is the code (`src/**/*.controller.ts`, `*.dto.ts`, `*.service.ts`) and `test/rest.e2e-spec.ts`. This file is what the iOS client is built against. If you change a route, change this file in the same commit.

- **Base URL:** production `https://place-rating-api-production.up.railway.app` · local `http://localhost:3000`
- **Format:** JSON, camelCase. Send `Content-Type: application/json`. Unknown body fields are rejected (`400 validation_failed`).
- **Auth:** `Authorization: Bearer <accessToken>` on everything except `/auth/*`, `/health` and `GET /avatars/...`.
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
| 400 | `invalid_key` | Avatar upload key does not belong to you |
| 401 | `unauthorized` | Missing, invalid or expired access token; bad Apple token; bad/used refresh token; account deleted |
| 403 | `username_required` | The account has not picked a username yet. Every signed-in route except `/me` and `/me/avatar/*` returns this until `PATCH /me {username}` succeeds |
| 404 | `not_found` | Unknown route or resource. Blocked and deleted users also look "not found" |
| 409 | `username_taken`, `already_friends` | |
| 422 | `username_reserved`, `invalid_image`, `image_too_large` | |
| 429 | `rate_limited` | See the limits table |
| 500 | `internal_error` | Bug on our side |

Other generic codes can appear from the framework: `bad_request`, `forbidden`, `conflict`, `unprocessable`, `method_not_allowed`, `payload_too_large`, `unsupported_media_type`.

## Shared types

```text
Avatar          { kind: "preset" | "upload", value: string, url: string | null }
                  preset: value is one of the 24 preset ids, url is null (the app draws the artwork)
                  upload: value is the object key "avatars/<userId>/<uuid>.jpg", url is absolute
PublicUser      { id, username: string | null, displayName, avatar: Avatar }
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

Preset ids (ship matching artwork in the app): `fox panda koala owl frog tiger whale penguin cat dog rabbit bear lion octopus turtle dolphin giraffe monkey hedgehog sloth unicorn robot alien ghost`. New accounts start with `fox`.

## Auth

| Request | Response |
| --- | --- |
| `POST /auth/apple` `{identityToken, nonce?, fullName?}` | `200 AuthResponse`. Creates the account on first sign-in. `identityToken` 20–8192 chars; `nonce` is the **raw** nonce (the app sent its SHA-256 hex to Apple); `fullName` ≤ 60 chars, only available to the app on the very first Apple sign-in, so send it then. `needsOnboarding` is `true` until a username is set. Errors: `401 unauthorized` (token invalid, wrong audience = bundle id, nonce mismatch) |
| `POST /auth/refresh` `{refreshToken}` | `200 AuthResponse` with a **new** refresh token. The old one is dead after this call. Presenting an already-used refresh token revokes the whole session family (theft protection) and returns `401`. Persist the new token before doing anything else, and never run two refreshes in parallel |
| `POST /auth/logout` `{refreshToken}` | `204`. Revokes that session (also `204` when the token is unknown). The current access token stays valid until it expires |
| `POST /auth/dev` `{username}` | `200 AuthResponse`. **Local development only**: `404` unless `DEV_AUTH_ENABLED=true`; the server refuses to boot with it on in production |

Access tokens last 15 minutes (`expiresIn`), refresh tokens 30 days. Sign-in calls are limited to 30 per minute per IP (apple + refresh share the counter).

## Me and avatars

| Request | Response |
| --- | --- |
| `GET /me` | `SelfUser` |
| `PATCH /me` `{username?, displayName?, ghostMode?, avatarPreset?}` | `200 SelfUser`. `username`: 3–20 chars of `a-z 0-9 _ .`, trimmed and lowercased by the server, unique, can be changed but never cleared (`null` gives `400 validation_failed`); reserved: `admin administrator support help root moderator official staff null undefined`. `displayName`: 1–40 chars. `avatarPreset`: one of the ids above (also deletes an uploaded photo). `ghostMode` also updates a live socket immediately. Errors: `409 username_taken`, `422 username_reserved` |
| `DELETE /me` | `204`. Deletes ratings, friendships, blocks and sessions, anonymises the row, removes the photo, recomputes place averages, tells friends' sockets the marker is gone. The current access token stops working right away (`401`) |
| `POST /me/avatar/upload-url` `{contentType: "image/jpeg" \| "image/png", contentLength: 1..5242880}` | `200 {key, uploadUrl, method: "PUT", headers: {"Content-Type": ...}, expiresIn: 300}`. 10 per hour |
| `POST /me/avatar/confirm` `{key}` | `200 SelfUser`. Errors: `400 invalid_key`, `404 not_found` (nothing was uploaded under that key), `422 image_too_large`, `422 invalid_image` |
| `GET /avatars/:userId/:file.jpg` | **Public, no token.** `200 image/jpeg`, `Cache-Control: public, max-age=31536000, immutable`. This is the address in `avatar.url`. `404` for anything else |

Upload recipe: (1) `POST upload-url` with the exact byte count of the file; (2) `PUT` the file bytes to `uploadUrl` with exactly the returned `headers` and exactly that many bytes (type and length are part of the signature, a mismatch is rejected by the bucket); (3) `POST confirm {key}`. The server re-encodes to a 256×256 JPEG, strips EXIF, and deletes the original and your previous photo. A new photo gets a new URL, so image caches never go stale.

## Users

`GET /users/search?q=` → `200 { items: [PublicUser + { friendStatus }] }`. `q` is 3–20 chars, lowercased, prefix match on username. Max 20 results, ordered by username, never yourself, blocked people (either direction) or deleted accounts. `friendStatus` is `none | friends | request_sent | request_received`. 60 per hour.

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

`POST /reports` `{targetType: "user" | "rating" | "avatar", targetId, reason: "spam" | "abuse" | "inappropriate" | "impersonation" | "other", details?: ≤500}` → `201 { id, status: "open" }`. For `user` and `avatar` the `targetId` is the user id; for `rating` it is the rating id. `400 invalid_target` (yourself or your own rating), `404 not_found`. 20 per day. There is no admin UI yet: reports are read in SQL (see `operations.md`).

## Health

`GET /health` → `200 {"status":"ok","db":"up","redis":"up"}`; `503` when Postgres or Redis does not answer.

## Rate limits

Counted per signed-in user in Redis (fixed windows), except sign-in which is per IP. A `429 rate_limited` has no `Retry-After`; back off and retry later.

| What | Limit |
| --- | --- |
| Rating writes (PUT + DELETE) | 30 / hour |
| Friend requests | 20 / day |
| Username searches | 60 / hour |
| Avatar upload URLs | 10 / hour |
| Reports | 20 / day |
| `POST /places/resolve` | 120 / hour |
| `POST /auth/apple` + `/auth/refresh` | 30 / minute per IP |

## Where this differs from the original design spec

The spec (`product-spec.md`) was written before the code. Build the client against **this** file:

- `POST /auth/apple` returns `needsOnboarding` (not `isNew`) and `expiresIn`.
- `POST /me/avatar/upload-url` returns `{key, uploadUrl, method, headers, expiresIn}` (not `uploadId`); confirm takes `{key}`.
- `GET /places` items have no `myStars`; `GET /places/:id` has `myRating`. Friends' ratings come from `GET /places/:id/ratings` plus `/friends`.
- `PUT rating` returns `{rating, place}`; `DELETE rating` returns `204` with no body (re-fetch the place if you need the average).
- `GET /places` also returns unrated places (filter on `ratingCount > 0`).
- Usernames may contain `.` as well as letters, digits and `_`.
- The photo thumbnail is produced on confirm and served by the API at `/avatars/...`, not from a bucket URL.
