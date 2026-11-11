import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Avatars become DiceBear characters (style + options, chosen in the app) instead of preset
 * animals or uploaded photos, and people can add photos of a place or its menu.
 */
export class CharactersAndPlacePhotos1794400000000 implements MigrationInterface {
  name = 'CharactersAndPlacePhotos1794400000000';

  async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE users ADD COLUMN avatar_style text, ADD COLUMN avatar_options jsonb`);
    await q.query(`ALTER TABLE users DROP COLUMN avatar_kind, DROP COLUMN avatar_value`);

    await q.query(`
      CREATE TABLE place_photos (
        id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        place_id    uuid NOT NULL REFERENCES places (id) ON DELETE CASCADE,
        user_id     uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        kind        text NOT NULL CHECK (kind IN ('place', 'menu')),
        object_key  text NOT NULL UNIQUE,
        thumb_key   text NOT NULL UNIQUE,
        width       integer NOT NULL,
        height      integer NOT NULL,
        created_at  timestamptz NOT NULL DEFAULT now()
      )`);
    // keyset paging, newest first, optionally per kind
    await q.query(`CREATE INDEX place_photos_place_idx ON place_photos (place_id, created_at DESC, id DESC)`);
    await q.query(`CREATE INDEX place_photos_user_idx ON place_photos (user_id)`);

    // avatar reports have nothing left to point at: keep them as reports about the person
    await q.query(`UPDATE reports SET target_type = 'user' WHERE target_type = 'avatar'`);
    await q.query(`ALTER TABLE reports DROP CONSTRAINT reports_target_type_check`);
    await q.query(
      `ALTER TABLE reports ADD CONSTRAINT reports_target_type_check CHECK (target_type IN ('user', 'rating', 'photo'))`,
    );
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`UPDATE reports SET target_type = 'user' WHERE target_type = 'photo'`);
    await q.query(`ALTER TABLE reports DROP CONSTRAINT reports_target_type_check`);
    await q.query(
      `ALTER TABLE reports ADD CONSTRAINT reports_target_type_check CHECK (target_type IN ('user', 'rating', 'avatar'))`,
    );
    await q.query(`DROP TABLE place_photos`);
    await q.query(`ALTER TABLE users DROP COLUMN avatar_style, DROP COLUMN avatar_options`);
    await q.query(
      `ALTER TABLE users ADD COLUMN avatar_kind text NOT NULL DEFAULT 'preset' CHECK (avatar_kind IN ('preset', 'upload')),
                         ADD COLUMN avatar_value text NOT NULL DEFAULT 'fox'`,
    );
  }
}
