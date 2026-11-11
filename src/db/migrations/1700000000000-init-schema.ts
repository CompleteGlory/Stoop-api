import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Initial schema. Places and ratings are not TypeORM entities: places carry
 * a `geography` column and ratings feed an aggregate that is recomputed in
 * the same transaction, so both are handled with SQL in their services.
 */
export class InitSchema1700000000000 implements MigrationInterface {
  name = 'InitSchema1700000000000';

  async up(q: QueryRunner): Promise<void> {
    await q.query(`CREATE EXTENSION IF NOT EXISTS postgis`);

    await q.query(`
      CREATE TABLE users (
        id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        apple_sub     text UNIQUE,
        username      text CHECK (username ~ '^[a-z0-9_.]{3,20}$'),
        display_name  text NOT NULL DEFAULT '',
        avatar_kind   text NOT NULL DEFAULT 'preset' CHECK (avatar_kind IN ('preset', 'upload')),
        avatar_value  text NOT NULL DEFAULT 'fox',
        ghost_mode    boolean NOT NULL DEFAULT false,
        created_at    timestamptz NOT NULL DEFAULT now(),
        deleted_at    timestamptz
      )`);
    await q.query(`CREATE UNIQUE INDEX users_username_key ON users (username) WHERE username IS NOT NULL`);
    // LIKE 'abc%' needs this operator class unless the database collation is C
    await q.query(
      `CREATE INDEX users_username_prefix_idx ON users (username text_pattern_ops) WHERE username IS NOT NULL`,
    );

    await q.query(`
      CREATE TABLE places (
        id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        apple_id      text UNIQUE,
        name          text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
        category      text CHECK (char_length(category) <= 60),
        location      geography(Point, 4326) NOT NULL,
        avg_rating    double precision NOT NULL DEFAULT 0,
        rating_count  integer NOT NULL DEFAULT 0,
        created_at    timestamptz NOT NULL DEFAULT now()
      )`);
    await q.query(`CREATE INDEX places_location_gix ON places USING gist (location)`);

    await q.query(`
      CREATE TABLE ratings (
        id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id     uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        place_id    uuid NOT NULL REFERENCES places (id) ON DELETE CASCADE,
        stars       smallint NOT NULL CHECK (stars BETWEEN 1 AND 5),
        comment     text CHECK (char_length(comment) <= 280),
        created_at  timestamptz NOT NULL DEFAULT now(),
        updated_at  timestamptz NOT NULL DEFAULT now(),
        UNIQUE (user_id, place_id)
      )`);
    await q.query(`CREATE INDEX ratings_place_recent_idx ON ratings (place_id, updated_at DESC, id DESC)`);

    await q.query(`
      CREATE TABLE friendships (
        id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        requester_id  uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        addressee_id  uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted')),
        created_at    timestamptz NOT NULL DEFAULT now(),
        accepted_at   timestamptz,
        CHECK (requester_id <> addressee_id)
      )`);
    // one row per pair, whichever side asked first
    await q.query(`
      CREATE UNIQUE INDEX friendships_pair_key
        ON friendships (LEAST(requester_id, addressee_id), GREATEST(requester_id, addressee_id))`);
    await q.query(`CREATE INDEX friendships_requester_idx ON friendships (requester_id, status)`);
    await q.query(`CREATE INDEX friendships_addressee_idx ON friendships (addressee_id, status)`);

    await q.query(`
      CREATE TABLE blocks (
        blocker_id  uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        blocked_id  uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        created_at  timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (blocker_id, blocked_id),
        CHECK (blocker_id <> blocked_id)
      )`);
    await q.query(`CREATE INDEX blocks_blocked_idx ON blocks (blocked_id)`);

    await q.query(`
      CREATE TABLE reports (
        id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        reporter_id  uuid REFERENCES users (id) ON DELETE SET NULL,
        target_type  text NOT NULL CHECK (target_type IN ('user', 'rating', 'avatar')),
        target_id    uuid NOT NULL,
        reason       text NOT NULL CHECK (reason IN ('spam', 'abuse', 'inappropriate', 'impersonation', 'other')),
        details      text CHECK (char_length(details) <= 500),
        status       text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'actioned', 'dismissed')),
        created_at   timestamptz NOT NULL DEFAULT now()
      )`);
    await q.query(`CREATE INDEX reports_open_idx ON reports (created_at) WHERE status = 'open'`);

    await q.query(`
      CREATE TABLE refresh_tokens (
        id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id     uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        family_id   uuid NOT NULL,
        token_hash  text NOT NULL UNIQUE,
        expires_at  timestamptz NOT NULL,
        revoked_at  timestamptz,
        created_at  timestamptz NOT NULL DEFAULT now()
      )`);
    await q.query(`CREATE INDEX refresh_tokens_user_idx ON refresh_tokens (user_id)`);
    await q.query(`CREATE INDEX refresh_tokens_family_idx ON refresh_tokens (family_id)`);
  }

  async down(q: QueryRunner): Promise<void> {
    for (const table of [
      'refresh_tokens',
      'reports',
      'blocks',
      'friendships',
      'ratings',
      'places',
      'users',
    ]) {
      await q.query(`DROP TABLE IF EXISTS ${table}`);
    }
  }
}
