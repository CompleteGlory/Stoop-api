import { createHash, randomInt } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { ApiError } from '../common/api-error.js';

export type CodePurpose = 'verify' | 'reset';

const TTL_MINUTES = 15;
const MAX_ATTEMPTS = 5;

const hash = (code: string) => createHash('sha256').update(code).digest('hex');

/**
 * Six-digit codes sent by email to confirm an address or reset a password. Only a hash is stored;
 * a code lasts 15 minutes and 5 wrong tries kill it. A new code replaces the previous one.
 * A pending sign-up keeps the chosen password's hash here until the address is confirmed.
 */
@Injectable()
export class EmailCodesService {
  constructor(private readonly db: DataSource) {}

  async issue(email: string, purpose: CodePurpose, passwordHash: string | null = null): Promise<string> {
    const code = randomInt(0, 1_000_000).toString().padStart(6, '0');
    await this.db.transaction(async (m) => {
      await m.query(`DELETE FROM email_codes WHERE email = $1 AND purpose = $2`, [email, purpose]);
      await m.query(
        `INSERT INTO email_codes (email, purpose, code_hash, password_hash, expires_at)
         VALUES ($1, $2, $3, $4, now() + make_interval(mins => $5))`,
        [email, purpose, hash(code), passwordHash, TTL_MINUTES],
      );
    });
    return code;
  }

  /** The pending sign-up's password hash, if someone signed up with this email and has not confirmed yet. */
  async pendingPassword(email: string): Promise<string | null> {
    const rows: { password_hash: string | null }[] = await this.db.query(
      `SELECT password_hash FROM email_codes WHERE email = $1 AND purpose = 'verify' AND expires_at > now()`,
      [email],
    );
    return rows[0]?.password_hash ?? null;
  }

  async exists(email: string, purpose: CodePurpose): Promise<boolean> {
    const rows = await this.db.query(
      `SELECT 1 FROM email_codes WHERE email = $1 AND purpose = $2 AND expires_at > now()`,
      [email, purpose],
    );
    return rows.length > 0;
  }

  /** Uses up the code and returns what was stored with it, or throws `400 invalid_code`. */
  async consume(email: string, purpose: CodePurpose, code: string): Promise<{ passwordHash: string | null }> {
    const invalid = ApiError.badRequest('invalid_code', 'That code is wrong or has expired');
    const rows: { id: string; code_hash: string; password_hash: string | null; attempts: number }[] =
      await this.db.query(
        `SELECT id, code_hash, password_hash, attempts FROM email_codes
          WHERE email = $1 AND purpose = $2 AND expires_at > now()`,
        [email, purpose],
      );
    const row = rows[0];
    if (!row || row.attempts >= MAX_ATTEMPTS) throw invalid;
    if (row.code_hash !== hash(code)) {
      await this.db.query(`UPDATE email_codes SET attempts = attempts + 1 WHERE id = $1`, [row.id]);
      throw invalid;
    }
    await this.db.query(`DELETE FROM email_codes WHERE id = $1`, [row.id]);
    return { passwordHash: row.password_hash };
  }

  async forget(email: string): Promise<void> {
    await this.db.query(`DELETE FROM email_codes WHERE email = $1`, [email]);
  }
}
