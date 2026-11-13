# Data model

Source: `src/db/migrations/1700000000000-init-schema.ts` (the schema, with all constraints) and `src/db/entities/*.entity.ts`. Production already ran this migration: **never edit it**. `1794500000000-email-and-google-sign-in.ts` added the email, password and Google columns and `email_codes`; `1794600000000-username-at-email-sign-up.ts` added `email_codes.username`. `1794400000000-characters-and-place-photos.ts` replaced the avatar columns with `avatar_style`/`avatar_options`, added `place_photos`, and changed report targets to `user`/`rating`/`photo`. Add a new migration class and list it in `migrations: [...]` in `src/db/database.module.ts`; migrations run on startup (`migrationsRun: true`).

## Postgres (durable)

`CREATE EXTENSION postgis` runs first, so the database must be PostGIS-capable (`postgis/postgis` image; Railway's plain Postgres template is not).

| Table | Columns and rules |
| --- | --- |
| `users` | `id` uuid PK · `apple_sub` text unique (null after deletion) · `username` text, `^[a-z0-9_.]{3,20}$`, unique where not null, prefix index (`text_pattern_ops`) · `display_name` text (≤ 40 used) · `avatar_style` DiceBear style (null until chosen) · `avatar_options` jsonb of the chosen DiceBear options · `email` lowercase, unique where not null · `email_verified_at` · `password_hash` scrypt (`scrypt$N$r$p$salt$hash`) · `google_sub` unique · `apple_refresh_token` text (from the Sign in with Apple code exchange, never returned by the API, revoked and cleared on deletion) · `ghost_mode` bool · `nearby_alerts` bool ("a friend is nearby" pushes, off by default) · `created_at` · `deleted_at` (soft delete) |
| `places` | `id` · `apple_id` text unique · `name` 1–120 · `category` ≤ 60 · `location` `geography(Point,4326)` with GiST index · `avg_rating` float · `rating_count` int · `created_at`. The aggregates are denormalised and recomputed from `ratings` inside the rating transaction |
| `ratings` | `id` · `user_id` → users (cascade) · `place_id` → places (cascade) · `stars` 1–5 · `comment` ≤ 280 · `created_at`, `updated_at` · **unique `(user_id, place_id)`** · index `(place_id, updated_at DESC, id DESC)` for keyset paging |
| `friendships` | `id` · `requester_id`, `addressee_id` → users · `status` `pending`\|`accepted` · `created_at`, `accepted_at` · `requester ≠ addressee` · **one row per pair** via a unique index on `(LEAST(a,b), GREATEST(a,b))` whichever side asked first |
| `blocks` | PK `(blocker_id, blocked_id)` · `created_at`. A block hides both people from each other everywhere (search, friends, ratings, live) and deletes any friendship |
| `place_photos` | `id` · `place_id` → places (cascade) · `user_id` → users (cascade) · `kind` `place`\|`menu` · `object_key`, `thumb_key` unique · `width`, `height` · `created_at` · index `(place_id, created_at DESC, id DESC)` for keyset paging |
| `reports` | `id` · `reporter_id` → users (set null on delete) · `target_type` `user`\|`rating`\|`photo` · `target_id` · `reason` `spam`\|`abuse`\|`inappropriate`\|`impersonation`\|`other` · `details` ≤ 500 · `status` `open`\|`actioned`\|`dismissed` · partial index on open reports |
| `email_codes` | `id` · `email` · `purpose` `verify`\|`reset` · `code_hash` SHA-256 of the 6-digit code · `password_hash` and `username` (pending sign-up only; the username is a wish, not a reservation) · `attempts` (5 kills it) · `expires_at` (15 min). A new code replaces the previous one for the same email and purpose |
| `push_devices` | `token` text PK (APNs device token, lowercase hex, never returned or logged) · `user_id` → users (cascade) · `environment` `sandbox`\|`production` · `created_at`, `updated_at`. One account per token: registering a token moves it. Deleted on account deletion and when Apple reports it dead |
| `refresh_tokens` | `id` · `user_id` · `family_id` (one family per sign-in session, kept across rotations) · `token_hash` SHA-256 (the raw token is never stored) · `expires_at` · `revoked_at` |

Places and ratings are handled with raw SQL (PostGIS, `FOR UPDATE`, aggregate recompute); the other tables use TypeORM repositories.

## Redis (short-lived, no durable data)

| Key | Value | Lifetime |
| --- | --- | --- |
| `loc:{userId}` | JSON `{lat, lng, accuracy, heading, ts}`, the only copy of a live position | 60 s, refreshed by each accepted `loc`, deleted on disconnect/ghost/deletion |
| `near:{userId}` | JSON `{lat, lng, ts}` rounded to 3 decimals, the latest background position, only for the nearby check and never sent to anyone | 30 min, replaced by each report; deleted on ghost, alerts off and deletion; only written while `nearby_alerts` is on |
| `nearby-check:{userId}` | `1`; the nearby check for this person ran in the last minute | 60 s |
| `nearby-pair:{idA}:{idB}` | `1` (ids sorted); these two were told they are near each other | 24 h |
| `rl:{what}:{userId or auth:ip}` | fixed-window rate-limit counter | the window (1 min, 1 h or 1 day) |
| `revoked:user:{userId}` | `1`; makes access tokens of a deleted user fail | access-token TTL + 60 s |

Losing Redis loses nothing important: friends' positions reappear with the next `loc`, counters reset.

## Bucket (S3-compatible, private)

- `uploads/{userId}/{uuid}`: raw photo upload from the phone, temporary. Deleted when confirmed or rejected; abandoned ones are never cleaned up automatically.
- `photos/{placeId}/{id}.jpg` (at most 1600 px) and `photos/{placeId}/{id}-t.jpg` (400 px square thumbnail): processed JPEGs without metadata. Immutable; deleted with the photo row. Served by `GET /photos/...`.

## Invariants (tested; keep them true)

- One rating per user per place; `PUT` is an upsert and a no-op when nothing changed.
- `places.avg_rating`/`rating_count` always equal the aggregate of `ratings`. Writers lock the place row (`SELECT … FOR UPDATE`) and call `recomputePlaceAggregates` in the same transaction.
- A client can create a place but never change or delete one.
- Friendship is symmetric once accepted; blocks are one-directional rows but act in both directions (`SocialGraph.isBlockedEitherWay`).
- Account deletion: ratings, friendships, blocks, refresh tokens and push devices are deleted (and `near:{userId}`), the user row is anonymised (`username`, `apple_sub` and `apple_refresh_token` null, the Apple token revoked with Apple when a key is configured, `display_name = 'Deleted user'`, avatar cleared, `deleted_at` set) and their place photos are deleted with their files, place averages are recomputed, the photo is deleted, access tokens are revoked via Redis, friends' sockets get `gone`. Reports about or by them stay.
- Deleted users never appear in search, friend lists, rating lists or the live graph.
