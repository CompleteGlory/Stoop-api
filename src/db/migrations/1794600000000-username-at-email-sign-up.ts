import type { MigrationInterface, QueryRunner } from 'typeorm';

/** A pending email sign-up can carry the username chosen on the sign-up screen. */
export class UsernameAtEmailSignUp1794600000000 implements MigrationInterface {
  name = 'UsernameAtEmailSignUp1794600000000';

  async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE email_codes ADD COLUMN username text`);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE email_codes DROP COLUMN username`);
  }
}
