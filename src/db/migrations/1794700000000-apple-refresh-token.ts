import type { MigrationInterface, QueryRunner } from 'typeorm';

/** The Sign in with Apple refresh token, kept only so it can be revoked when the account is deleted. */
export class AppleRefreshToken1794700000000 implements MigrationInterface {
  name = 'AppleRefreshToken1794700000000';

  async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE users ADD COLUMN apple_refresh_token text`);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE users DROP COLUMN apple_refresh_token`);
  }
}
