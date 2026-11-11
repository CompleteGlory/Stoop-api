import type { MigrationInterface, QueryRunner } from 'typeorm';

/** Email and password sign-in (with emailed codes) and Google sign-in, all linked by verified email. */
export class EmailAndGoogleSignIn1794500000000 implements MigrationInterface {
  name = 'EmailAndGoogleSignIn1794500000000';

  async up(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE users
        ADD COLUMN email text CHECK (email = lower(email) AND char_length(email) <= 254),
        ADD COLUMN email_verified_at timestamptz,
        ADD COLUMN password_hash text,
        ADD COLUMN google_sub text UNIQUE`);
    await q.query(`CREATE UNIQUE INDEX users_email_key ON users (email) WHERE email IS NOT NULL`);

    await q.query(`
      CREATE TABLE email_codes (
        id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        email          text NOT NULL,
        purpose        text NOT NULL CHECK (purpose IN ('verify', 'reset')),
        code_hash      text NOT NULL,
        password_hash  text,
        attempts       integer NOT NULL DEFAULT 0,
        expires_at     timestamptz NOT NULL,
        created_at     timestamptz NOT NULL DEFAULT now()
      )`);
    await q.query(`CREATE INDEX email_codes_email_idx ON email_codes (email, purpose)`);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE email_codes`);
    await q.query(`DROP INDEX users_email_key`);
    await q.query(
      `ALTER TABLE users DROP COLUMN email, DROP COLUMN email_verified_at, DROP COLUMN password_hash, DROP COLUMN google_sub`,
    );
  }
}
