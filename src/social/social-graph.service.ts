import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

/** Read-only questions about who is friends with, or blocked by, whom. */
@Injectable()
export class SocialGraph {
  constructor(private readonly db: DataSource) {}

  /** Accepted friends who are neither blocked (by either side) nor deleted. */
  async friendIds(userId: string): Promise<string[]> {
    const rows: { friend_id: string }[] = await this.db.query(
      `SELECT CASE WHEN f.requester_id = $1 THEN f.addressee_id ELSE f.requester_id END AS friend_id
         FROM friendships f
         JOIN users u ON u.id = CASE WHEN f.requester_id = $1 THEN f.addressee_id ELSE f.requester_id END
        WHERE (f.requester_id = $1 OR f.addressee_id = $1)
          AND f.status = 'accepted'
          AND u.deleted_at IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM blocks b
             WHERE (b.blocker_id = $1 AND b.blocked_id = u.id)
                OR (b.blocker_id = u.id AND b.blocked_id = $1))`,
      [userId],
    );
    return rows.map((r) => r.friend_id);
  }

  async isBlockedEitherWay(a: string, b: string): Promise<boolean> {
    const rows = await this.db.query(
      `SELECT 1 FROM blocks
        WHERE (blocker_id = $1 AND blocked_id = $2) OR (blocker_id = $2 AND blocked_id = $1)
        LIMIT 1`,
      [a, b],
    );
    return rows.length > 0;
  }
}
