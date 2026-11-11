import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { ApiError } from '../common/api-error.js';
import { DomainEvents } from '../common/domain-events.js';
import { USER_COLUMNS, UserMapper, type UserColumns } from '../common/mappers.js';
import { Block } from '../db/entities/block.entity.js';

@Injectable()
export class BlocksService {
  constructor(
    @InjectRepository(Block) private readonly blocks: Repository<Block>,
    private readonly db: DataSource,
    private readonly mapper: UserMapper,
    private readonly events: DomainEvents,
  ) {}

  async list(userId: string) {
    const rows: UserColumns[] = await this.db.query(
      `SELECT ${USER_COLUMNS}
         FROM blocks b JOIN users u ON u.id = b.blocked_id
        WHERE b.blocker_id = $1 AND u.deleted_at IS NULL
        ORDER BY b.created_at DESC`,
      [userId],
    );
    return { items: rows.map((row) => this.mapper.fromColumns(row)) };
  }

  /** Blocking also ends any friendship or pending request between the two. */
  async block(userId: string, targetId: string): Promise<void> {
    if (targetId === userId) throw ApiError.badRequest('invalid_target', 'You cannot block yourself');
    const target = await this.db.query(`SELECT 1 FROM users WHERE id = $1 AND deleted_at IS NULL`, [targetId]);
    if (target.length === 0) throw ApiError.notFound('User');

    await this.db.transaction(async (m) => {
      await m.query(
        `INSERT INTO blocks (blocker_id, blocked_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [userId, targetId],
      );
      await m.query(
        `DELETE FROM friendships
          WHERE (requester_id = $1 AND addressee_id = $2) OR (requester_id = $2 AND addressee_id = $1)`,
        [userId, targetId],
      );
    });
    this.events.emit({ type: 'relations-changed', userIds: [userId, targetId] });
  }

  async unblock(userId: string, targetId: string): Promise<void> {
    await this.blocks.delete({ blockerId: userId, blockedId: targetId });
    this.events.emit({ type: 'relations-changed', userIds: [userId, targetId] });
  }
}
