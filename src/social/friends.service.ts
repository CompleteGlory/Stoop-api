import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { ApiError } from '../common/api-error.js';
import { isUniqueViolation } from '../common/db-errors.js';
import { DomainEvents } from '../common/domain-events.js';
import { USER_COLUMNS, UserMapper, type PublicUserDto, type UserColumns } from '../common/mappers.js';
import { RateLimiter } from '../common/rate-limiter.service.js';
import { Friendship } from '../db/entities/friendship.entity.js';
import { SocialGraph } from './social-graph.service.js';

export interface FriendshipEntryDto {
  /** Friendship id; incoming requests are accepted by it. */
  id: string;
  user: PublicUserDto;
  since: string;
}

@Injectable()
export class FriendsService {
  constructor(
    @InjectRepository(Friendship) private readonly friendships: Repository<Friendship>,
    private readonly db: DataSource,
    private readonly mapper: UserMapper,
    private readonly graph: SocialGraph,
    private readonly events: DomainEvents,
    private readonly limiter: RateLimiter,
  ) {}

  async list(userId: string) {
    const rows: (UserColumns & {
      friendship_id: string;
      status: 'pending' | 'accepted';
      requester_id: string;
      created_at: string;
      accepted_at: string | null;
    })[] = await this.db.query(
      `SELECT f.id AS friendship_id, f.status, f.requester_id, f.created_at, f.accepted_at, ${USER_COLUMNS}
         FROM friendships f
         JOIN users u ON u.id = CASE WHEN f.requester_id = $1 THEN f.addressee_id ELSE f.requester_id END
        WHERE (f.requester_id = $1 OR f.addressee_id = $1)
          AND u.deleted_at IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM blocks b
             WHERE (b.blocker_id = $1 AND b.blocked_id = u.id)
                OR (b.blocker_id = u.id AND b.blocked_id = $1))
        ORDER BY u.username NULLS LAST`,
      [userId],
    );

    const friends: FriendshipEntryDto[] = [];
    const incoming: FriendshipEntryDto[] = [];
    const outgoing: FriendshipEntryDto[] = [];
    for (const row of rows) {
      const entry: FriendshipEntryDto = {
        id: row.friendship_id,
        user: this.mapper.fromColumns(row),
        since: new Date(row.accepted_at ?? row.created_at).toISOString(),
      };
      if (row.status === 'accepted') friends.push(entry);
      else if (row.requester_id === userId) outgoing.push(entry);
      else incoming.push(entry);
    }
    return { friends, incoming, outgoing };
  }

  /**
   * Sends a friend request. When the other person already asked, this accepts
   * theirs instead, so two people adding each other end up as friends.
   */
  async request(userId: string, targetId: string): Promise<{ id: string; status: 'pending' | 'accepted' }> {
    if (targetId === userId) throw ApiError.badRequest('invalid_target', 'You cannot add yourself');
    await this.limiter.consume(`friend-request:${userId}`, 20, 24 * 3600, 'friend requests');

    // an unknown, deleted or blocking user all look the same to the caller
    const target = await this.db.query(`SELECT 1 FROM users WHERE id = $1 AND deleted_at IS NULL`, [targetId]);
    if (target.length === 0 || (await this.graph.isBlockedEitherWay(userId, targetId))) {
      throw ApiError.notFound('User');
    }

    const existing = await this.findPair(userId, targetId);
    if (existing) return this.handleExisting(existing, userId);

    try {
      const created = await this.friendships.save(
        this.friendships.create({ requesterId: userId, addresseeId: targetId, status: 'pending' }),
      );
      this.events.emit({ type: 'friend-requested', fromId: userId, toId: targetId });
      return { id: created.id, status: 'pending' };
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      const raced = await this.findPair(userId, targetId);
      if (!raced) throw err;
      return this.handleExisting(raced, userId);
    }
  }

  private async handleExisting(existing: Friendship, userId: string) {
    if (existing.status === 'accepted') {
      throw ApiError.conflict('already_friends', 'You are already friends');
    }
    if (existing.requesterId === userId) return { id: existing.id, status: 'pending' as const };
    await this.accept(userId, existing.id);
    return { id: existing.id, status: 'accepted' as const };
  }

  private findPair(a: string, b: string) {
    return this.friendships
      .createQueryBuilder('f')
      .where('(f.requester_id = :a AND f.addressee_id = :b) OR (f.requester_id = :b AND f.addressee_id = :a)', { a, b })
      .getOne();
  }

  async accept(userId: string, friendshipId: string): Promise<void> {
    const row = await this.friendships.findOne({ where: { id: friendshipId } });
    if (!row || row.addresseeId !== userId || row.status !== 'pending') {
      throw ApiError.notFound('Friend request');
    }
    if (await this.graph.isBlockedEitherWay(row.requesterId, row.addresseeId)) {
      throw ApiError.notFound('Friend request');
    }
    const res = await this.friendships.update(
      { id: friendshipId, status: 'pending' },
      { status: 'accepted', acceptedAt: new Date() },
    );
    if (res.affected !== 1) throw ApiError.notFound('Friend request');
    this.events.emit({ type: 'relations-changed', userIds: [row.requesterId, row.addresseeId] });
    this.events.emit({ type: 'friend-accepted', byId: userId, requesterId: row.requesterId });
  }

  /** Removes a friend, cancels a request you sent, or declines one you received. Idempotent. */
  async remove(userId: string, otherId: string): Promise<void> {
    const existing = await this.findPair(userId, otherId);
    if (!existing) return;
    await this.friendships.delete({ id: existing.id });
    this.events.emit({ type: 'relations-changed', userIds: [userId, otherId] });
  }
}
