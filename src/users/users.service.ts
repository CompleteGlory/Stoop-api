import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, IsNull, Repository } from 'typeorm';
import { ApiError } from '../common/api-error.js';
import { isUniqueViolation, escapeLike } from '../common/db-errors.js';
import { DomainEvents } from '../common/domain-events.js';
import {
  USER_COLUMNS,
  UserMapper,
  type AvatarDto,
  type PublicUserDto,
  type UserColumns,
} from '../common/mappers.js';
import { RateLimiter } from '../common/rate-limiter.service.js';
import { SocialGraph } from '../social/social-graph.service.js';
import { User } from '../db/entities/user.entity.js';
import { TokensService } from '../auth/tokens.service.js';
import { recomputePlaceAggregates } from '../ratings/aggregates.js';
import { AvatarService } from './avatar.service.js';
import { DEFAULT_AVATAR_PRESET } from './avatar-presets.js';
import type { UpdateMeDto } from './users.dto.js';

const RESERVED_USERNAMES = new Set([
  'admin', 'administrator', 'support', 'help', 'root', 'moderator', 'official', 'staff', 'null', 'undefined',
]);

export interface SelfUserDto extends PublicUserDto {
  ghostMode: boolean;
  createdAt: string;
}

export type FriendStatus = 'none' | 'friends' | 'request_sent' | 'request_received';

export interface UserSearchResultDto extends PublicUserDto {
  friendStatus: FriendStatus;
}

@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(User) private readonly users: Repository<User>,
    private readonly db: DataSource,
    private readonly mapper: UserMapper,
    private readonly avatars: AvatarService,
    private readonly events: DomainEvents,
    private readonly limiter: RateLimiter,
    private readonly graph: SocialGraph,
    private readonly tokens: TokensService,
  ) {}

  toSelf(user: User): SelfUserDto {
    return {
      id: user.id,
      username: user.username,
      displayName: user.displayName,
      avatar: this.mapper.avatar(user.avatarKind, user.avatarValue) satisfies AvatarDto,
      ghostMode: user.ghostMode,
      createdAt: user.createdAt.toISOString(),
    };
  }

  private async mustFind(id: string): Promise<User> {
    const user = await this.users.findOne({ where: { id, deletedAt: IsNull() } });
    if (!user) throw ApiError.notFound('User');
    return user;
  }

  async getSelf(id: string): Promise<SelfUserDto> {
    return this.toSelf(await this.mustFind(id));
  }

  async updateSelf(id: string, dto: UpdateMeDto): Promise<SelfUserDto> {
    const user = await this.mustFind(id);
    const patch: Partial<User> = {};

    if (dto.username !== undefined && dto.username !== user.username) {
      if (RESERVED_USERNAMES.has(dto.username)) {
        throw ApiError.unprocessable('username_reserved', 'That username is not available');
      }
      patch.username = dto.username;
    }
    if (dto.displayName !== undefined) patch.displayName = dto.displayName;
    if (dto.ghostMode !== undefined) patch.ghostMode = dto.ghostMode;
    if (dto.avatarPreset !== undefined) {
      patch.avatarKind = 'preset';
      patch.avatarValue = dto.avatarPreset;
    }

    if (Object.keys(patch).length > 0) {
      try {
        await this.users.update({ id }, patch);
      } catch (err) {
        if (isUniqueViolation(err, 'users_username_key')) {
          throw ApiError.conflict('username_taken', 'That username is already taken');
        }
        throw err;
      }
      if (patch.avatarKind === 'preset') await this.avatars.deleteUploaded(user);
      if (patch.ghostMode !== undefined && patch.ghostMode !== user.ghostMode) {
        this.events.emit({ type: 'ghost-changed', userId: id, on: patch.ghostMode });
      }
    }
    return this.getSelf(id);
  }

  /**
   * Deletes the account the way App Review expects: the person's ratings,
   * friendships, blocks and sessions go, and the row is anonymised. Reports
   * about or by them stay so moderation history is not lost.
   */
  async deleteSelf(id: string): Promise<void> {
    const user = await this.mustFind(id);
    const friendIds = await this.graph.friendIds(id);

    await this.db.transaction(async (m) => {
      const placeRows: { place_id: string }[] = await m.query(
        `SELECT DISTINCT place_id FROM ratings WHERE user_id = $1`,
        [id],
      );
      await m.query(`DELETE FROM ratings WHERE user_id = $1`, [id]);
      await recomputePlaceAggregates(m, placeRows.map((r) => r.place_id));
      await m.query(`DELETE FROM friendships WHERE requester_id = $1 OR addressee_id = $1`, [id]);
      await m.query(`DELETE FROM blocks WHERE blocker_id = $1 OR blocked_id = $1`, [id]);
      await m.query(`DELETE FROM refresh_tokens WHERE user_id = $1`, [id]);
      await m.query(
        `UPDATE users
            SET deleted_at = now(), apple_sub = NULL, username = NULL, display_name = 'Deleted user',
                avatar_kind = 'preset', avatar_value = $2, ghost_mode = true
          WHERE id = $1`,
        [id, DEFAULT_AVATAR_PRESET],
      );
    });

    await this.tokens.revokeAccessTokens(id);
    await this.avatars.deleteUploaded(user);
    this.events.emit({ type: 'user-deleted', userId: id, friendIds });
  }

  /** Prefix search on usernames, never returning the caller, blocked users or deleted accounts. */
  async search(callerId: string, query: string): Promise<UserSearchResultDto[]> {
    await this.limiter.consume(`user-search:${callerId}`, 60, 3600, 'searches');

    const rows: (UserColumns & { status: string | null; requester_id: string | null })[] =
      await this.db.query(
        `SELECT ${USER_COLUMNS}, f.status, f.requester_id
           FROM users u
           LEFT JOIN friendships f
             ON (f.requester_id = $1 AND f.addressee_id = u.id)
             OR (f.requester_id = u.id AND f.addressee_id = $1)
          WHERE u.username LIKE $2 ESCAPE '\\'
            AND u.id <> $1
            AND u.deleted_at IS NULL
            AND NOT EXISTS (
              SELECT 1 FROM blocks b
               WHERE (b.blocker_id = $1 AND b.blocked_id = u.id)
                  OR (b.blocker_id = u.id AND b.blocked_id = $1))
          ORDER BY u.username
          LIMIT 20`,
        [callerId, `${escapeLike(query)}%`],
      );

    return rows.map((row) => ({
      ...this.mapper.fromColumns(row),
      friendStatus: friendStatusOf(callerId, row.status, row.requester_id),
    }));
  }
}

export function friendStatusOf(
  callerId: string,
  status: string | null,
  requesterId: string | null,
): FriendStatus {
  if (!status) return 'none';
  if (status === 'accepted') return 'friends';
  return requesterId === callerId ? 'request_sent' : 'request_received';
}
