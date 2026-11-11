# Data model

Source: `src/db/migrations/1700000000000-init-schema.ts` (the schema, with all constraints) and `src/db/entities/*.entity.ts`. Production already ran this migration: **never edit it**. `1794400000000-characters-and-place-photos.ts` replaced the avatar columns with `avatar_style`/`avatar_options`, added `place_photos`, and changed report targets to `user`/`rating`/`photo`. Add a new migration class and list it in `migrations: [...]` in `src/db/database.module.ts`; migrations run on startup (`migrationsRun: true`).

## Postgres (durable)

`CREATE EXTENSION postgis` runs first, so the database must be PostGIS-capable (`postgis/postgis` image; Railway's plain Postgres template is not).

| Table | Columns and rules |
| --- | --- |
| `users` | `id` uuid PK · `apple_sub` text unique (null after deletion) · `username` text, `^[a-z0-9_.]{3,20}$`, unique where not null, prefix index (`text_pattern_ops`) · `display_name` text (≤ 40 used) · `avatar_style` DiceBear style (null until chosen) · `avatar_options` jsonb of the chosen DiceBear options · `ghost_mode` bool · `created_at` · `deleted_at` (soft delete) |
| `places` | `id` · `apple_id` text unique · `name` 1–120 · `category` ≤ 60 · `location` `geography(Point,4326)` with GiST index · `avg_rating` float · `rating_count` int · `created_at`. The aggregates are denormalised and recomputed from `ratings` inside the rating transaction |
| `ratings` | `id` · `user_id` → users (cascade) · `place_id` → places (cascade) · `stars` 1–5 · `comment` ≤ 280 · `created_at`, `updated_at` · **unique `(user_id, place_id)`** · index `(place_id, updated_at DESC, id DESC)` for keyset paging |
| `friendships` | `id` · `requester_id`, `addressee_id` → users · `status` `pending`\|`accepted` · `created_at`, `accepted_at` · `requester ≠ addressee` · **one row per pair** via a unique index on `(LEAST(a,b), GREATEST(a,b))` whichever side asked first |
| `blocks` | PK `(blocker_id, blocked_id)` · `created_at`. A block hides both people from each other everywhere (search, friends, ratings, live) and deletes any friendship |
| `place_photos` | `id` · `place_id` → places (cascade) · `user_id` → users (cascade) · `kind` `place`\|`menu` · `object_key`, `thumb_key` unique · `width`, `height` · `created_at` · index `(place_id, created_at DESC, id DESC)` for keyset paging |
| `reports` | `id` · `reporter_id` → users (set null on delete) · `target_type` `user`\|`rating`\|`photo` · `target_id` · `reason` `spam`\|`abuse`\|`inappropriate`\|`impersonation`\|`other` · `details` ≤ 500 · `status` `open`\|`actioned`\|`dismissed` · partial index on open reports |
| `refresh_tokens` | `id` · `user_id` · `family_id` (one family per sign-in session, kept across rotations) · `token_hash` SHA-256 (the raw token is never stored) · `expires_at` · `revoked_at` |

Places and ratings are handled with raw SQL (PostGIS, `FOR UPDATE`, aggregate recompute); the other tables use TypeORM repositories.

## Redis (short-lived, no durable data)

| Key | Value | Lifetime |
| --- | --- | --- |
| `loc:{userId}` | JSON `{lat, lng, accuracy, heading, ts}`, the only copy of a live position | 60 s, refreshed by each accepted `loc`, deleted on disconnect/ghost/deletion |
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
- Account deletion: ratings, friendships, blocks and refresh tokens are deleted, the user row is anonymised (`username` and `apple_sub` null, `display_name = 'Deleted user'`, avatar cleared, `deleted_at` set) and their place photos are deleted with their files, place averages are recomputed, the photo is deleted, access tokens are revoked via Redis, friends' sockets get `gone`. Reports about or by them stay.
- Deleted users never appear in search, friend lists, rating lists or the live graph.
