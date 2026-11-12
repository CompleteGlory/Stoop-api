import type { MigrationInterface, QueryRunner } from 'typeorm';

/** Devices that get push notifications, and the per-person switch for "a friend is nearby" alerts. */
export class PushAndNearby1794800000000 implements MigrationInterface {
  name = 'PushAndNearby1794800000000';

  async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE push_devices (
        token       text PRIMARY KEY,
        user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        environment text NOT NULL CHECK (environment IN ('sandbox', 'production')),
        created_at  timestamptz NOT NULL DEFAULT now(),
        updated_at  timestamptz NOT NULL DEFAULT now()
      )`);
    await q.query(`CREATE INDEX push_devices_user_idx ON push_devices (user_id)`);
    await q.query(`ALTER TABLE users ADD COLUMN nearby_alerts boolean NOT NULL DEFAULT false`);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE users DROP COLUMN nearby_alerts`);
    await q.query(`DROP TABLE push_devices`);
  }
}
