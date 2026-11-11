import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, IsNull, Repository } from 'typeorm';
import { ApiError } from '../common/api-error.js';
import { isUniqueViolation, escapeLike } from '../common/db-errors.js';
import { DomainEvents } from '../common/domain-events.js';
import { USER_COLUMNS, UserMapper, type PublicUserDto, type UserColumns } from '../common/mappers.js';
import { RateLimiter } from '../common/rate-limiter.service.js';
import { SocialGraph } from '../social/social-graph.service.js';
import { User } from '../db/entities/user.entity.js';
import { TokensService } from '../auth/tokens.service.js';
import { recomputePlaceAggregates } from '../ratings/aggregates.js';
import { StorageService } from '../common/storage.service.js';
import { validateCharacter } from './character.js';
import { USERNAME_PATTERN, type UpdateMeDto } from './users.dto.js';

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

export interface UsernameAvailabilityResultDto {
  available: boolean;
  reason: 'taken' | 'reserved' | 'invalid' | null;
}

@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(User) private readonly users: Repository<User>,
    private readonly db: DataSource,
    private readonly mapper: UserMapper,
    private readonly storage: StorageService,
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
      avatar: this.mapper.avatar(user.avatarStyle, user.avatarOptions),
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
    if (dto.avatar !== undefined) {
      const character = validateCharacter(dto.avatar);
      patch.avatarStyle = character.style;
      patch.avatarOptions = character.options;
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
      if (patch.ghostMode !== undefined && patch.ghostMode !== user.ghostMode) {
        this.events.emit({ type: 'ghost-changed', userId: id, on: patch.ghostMode });
      }
    }
    return this.getSelf(id);
  }

  /**
   * Deletes the account the way App Review expects: the person's ratings,
   * friendships, blocks, sessions and place photos go, and the row is anonymised. Reports
   * about or by them stay so moderation history is not lost.
   */
  async deleteSelf(id: string): Promise<void> {
    const user = await this.mustFind(id);
    const friendIds = await this.graph.friendIds(id);

    const photoKeys = await this.db.transaction(async (m) => {
      const placeRows: { place_id: string }[] = await m.query(
        `SELECT DISTINCT place_id FROM ratings WHERE user_id = $1`,
        [id],
      );
      await m.query(`DELETE FROM ratings WHERE user_id = $1`, [id]);
      await recomputePlaceAggregates(m, placeRows.map((r) => r.place_id));
      await m.query(`DELETE FROM friendships WHERE requester_id = $1 OR addressee_id = $1`, [id]);
      await m.query(`DELETE FROM blocks WHERE blocker_id = $1 OR blocked_id = $1`, [id]);
      await m.query(`DELETE FROM refresh_tokens WHERE user_id = $1`, [id]);
      if (user.email) await m.query(`DELETE FROM email_codes WHERE email = $1`, [user.email]);
      // TypeORM answers a DELETE ... RETURNING with [rows, affected count]
      const [photos]: [{ object_key: string; thumb_key: string }[], number] = await m.query(
        `DELETE FROM place_photos WHERE user_id = $1 RETURNING object_key, thumb_key`,
        [id],
      );
      await m.query(
        `UPDATE users
            SET deleted_at = now(), apple_sub = NULL, username = NULL, display_name = 'Deleted user',
                avatar_style = NULL, avatar_options = NULL, ghost_mode = true,
                email = NULL, email_verified_at = NULL, password_hash = NULL, google_sub = NULL
          WHERE id = $1`,
        [id],
      );
      return photos.flatMap((p) => [p.object_key, p.thumb_key]);
    });

    await this.tokens.revokeAccessTokens(id);
    await Promise.all(photoKeys.map((key) => this.storage.delete(key)));
    this.events.emit({ type: 'user-deleted', userId: id, friendIds });
  }

  /**
   * Whether `username` could be saved by the caller right now. Saving can still lose a race.
   * Works signed out too (the email sign-up screen), limited per IP address instead of per account.
   */
  async checkUsername(caller: { userId?: string; ip?: string }, username: string): Promise<UsernameAvailabilityResultDto> {
    if (caller.userId) {
      await this.limiter.consume(`username-check:${caller.userId}`, 300, 3600, 'username checks');
    } else {
      await this.limiter.consume(`username-check-ip:${caller.ip ?? 'unknown'}`, 120, 3600, 'username checks');
    }
    return this.usernameStatus(username, caller.userId);
  }

  /** The availability answer without rate limiting; `callerId`'s own username counts as available. */
  async usernameStatus(username: string, callerId?: string): Promise<UsernameAvailabilityResultDto> {
    if (!USERNAME_PATTERN.test(username)) return { available: false, reason: 'invalid' };
    if (RESERVED_USERNAMES.has(username)) return { available: false, reason: 'reserved' };
    const owner = await this.users.findOne({ where: { username }, select: { id: true } });
    if (owner && owner.id !== callerId) return { available: false, reason: 'taken' };
    return { available: true, reason: null };
  }

  /**
   * Gives an account without a username the one it chose at sign-up. Returns false, changing
   * nothing, when the account already has one or someone else took the name in the meantime.
   * A blank display name becomes the username, since friends' markers show the display name.
   */
  async claimUsername(userId: string, username: string): Promise<boolean> {
    if ((await this.usernameStatus(username, userId)).available === false) return false;
    try {
      const result = await this.users.update({ id: userId, username: IsNull() }, { username });
      if ((result.affected ?? 0) === 0) return false;
      await this.users.update({ id: userId, displayName: '' }, { displayName: username });
      return true;
    } catch (err) {
      if (isUniqueViolation(err, 'users_username_key')) return false;
      throw err;
    }
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
