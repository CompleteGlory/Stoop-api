import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { jwtVerify, SignJWT } from 'jose';
import { IsNull, Repository } from 'typeorm';
import { ApiError } from '../common/api-error.js';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import { RefreshToken } from '../db/entities/refresh-token.entity.js';
import { RedisService } from '../redis/redis.service.js';

const AUDIENCE = 'place-rating-app';

export const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

@Injectable()
export class TokensService {
  private readonly key: Uint8Array;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @InjectRepository(RefreshToken) private readonly refreshTokens: Repository<RefreshToken>,
    private readonly redis: RedisService,
  ) {
    this.key = new TextEncoder().encode(config.jwt.secret);
  }

  signAccessToken(userId: string): Promise<string> {
    return new SignJWT({})
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(userId)
      .setIssuer(this.config.jwt.issuer)
      .setAudience(AUDIENCE)
      .setIssuedAt()
      .setExpirationTime(`${this.config.jwt.accessTtlSec}s`)
      .sign(this.key);
  }

  /** Returns the user id, or throws a 401. Also rejects tokens of users deleted in the last access-token lifetime. */
  async verifyAccessToken(token: string): Promise<string> {
    let sub: string | undefined;
    try {
      const { payload } = await jwtVerify(token, this.key, {
        issuer: this.config.jwt.issuer,
        audience: AUDIENCE,
        algorithms: ['HS256'],
      });
      sub = payload.sub;
    } catch {
      throw ApiError.unauthorized('The access token is invalid or expired');
    }
    if (!sub) throw ApiError.unauthorized('The access token has no subject');
    if (await this.redis.client.exists(this.revokedKey(sub))) {
      throw ApiError.unauthorized('This account is no longer active');
    }
    return sub;
  }

  /** Makes already-issued access tokens of a user fail until they would have expired anyway. */
  async revokeAccessTokens(userId: string): Promise<void> {
    await this.redis.client.set(
      this.revokedKey(userId),
      '1',
      'EX',
      this.config.jwt.accessTtlSec + 60,
    );
  }

  private revokedKey(userId: string) {
    return `revoked:user:${userId}`;
  }

  async issueRefreshToken(userId: string, familyId: string = randomUUID()): Promise<string> {
    const raw = randomBytes(32).toString('base64url');
    await this.refreshTokens.insert({
      userId,
      familyId,
      tokenHash: sha256(raw),
      expiresAt: new Date(Date.now() + this.config.jwt.refreshTtlSec * 1000),
    });
    return raw;
  }

  /**
   * Exchanges a refresh token for a new one in the same family. A token that
   * was already used is a sign of theft: the whole family is revoked.
   */
  async rotateRefreshToken(raw: string): Promise<{ userId: string; refreshToken: string }> {
    const invalid = () => ApiError.unauthorized('The refresh token is invalid or expired');
    const row = await this.refreshTokens.findOne({ where: { tokenHash: sha256(raw) } });
    if (!row) throw invalid();

    if (row.revokedAt) {
      await this.revokeFamily(row.familyId);
      throw invalid();
    }
    if (row.expiresAt.getTime() <= Date.now()) throw invalid();

    // claim it atomically so two parallel refreshes cannot both succeed
    const claimed = await this.refreshTokens.update(
      { id: row.id, revokedAt: IsNull() },
      { revokedAt: new Date() },
    );
    if (claimed.affected !== 1) throw invalid();

    return { userId: row.userId, refreshToken: await this.issueRefreshToken(row.userId, row.familyId) };
  }

  async revokeByToken(raw: string): Promise<void> {
    const row = await this.refreshTokens.findOne({ where: { tokenHash: sha256(raw) } });
    if (row) await this.revokeFamily(row.familyId);
  }

  async revokeFamily(familyId: string): Promise<void> {
    await this.refreshTokens.update({ familyId, revokedAt: IsNull() }, { revokedAt: new Date() });
  }

  async revokeAllForUser(userId: string): Promise<void> {
    await this.refreshTokens.update({ userId, revokedAt: IsNull() }, { revokedAt: new Date() });
  }
}
