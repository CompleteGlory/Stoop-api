import { Inject, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { ApiError } from '../common/api-error.js';
import { isUniqueViolation } from '../common/db-errors.js';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import { User } from '../db/entities/user.entity.js';
import { UsersService, type SelfUserDto } from '../users/users.service.js';
import { AppleVerifier } from './apple-verifier.js';
import { TokensService } from './tokens.service.js';

export interface AuthResponse {
  accessToken: string;
  refreshToken: string;
  /** Seconds until `accessToken` expires. */
  expiresIn: number;
  /** True until the person has picked a username. */
  needsOnboarding: boolean;
  user: SelfUserDto;
}

@Injectable()
export class AuthService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @InjectRepository(User) private readonly users: Repository<User>,
    private readonly apple: AppleVerifier,
    private readonly tokens: TokensService,
    private readonly usersService: UsersService,
  ) {}

  async signInWithApple(input: {
    identityToken: string;
    nonce?: string;
    fullName?: string;
  }): Promise<AuthResponse> {
    const identity = await this.apple.verify(input.identityToken, input.nonce);
    const user = await this.findOrCreate(identity.sub, input.fullName ?? '');
    return this.respond(user);
  }

  /** Development only: signs in as `username`, creating the account when needed. */
  async devLogin(username: string): Promise<AuthResponse> {
    if (!this.config.devAuthEnabled) throw ApiError.notFound('Route');
    const sub = `dev:${username}`;
    let user = await this.users.findOne({ where: { appleSub: sub, deletedAt: IsNull() } });
    if (!user) {
      user = await this.findOrCreate(sub, username);
      await this.users.update({ id: user.id }, { username });
      user.username = username;
    }
    return this.respond(user);
  }

  async refresh(refreshToken: string): Promise<AuthResponse> {
    const rotated = await this.tokens.rotateRefreshToken(refreshToken);
    const user = await this.users.findOne({ where: { id: rotated.userId, deletedAt: IsNull() } });
    if (!user) throw ApiError.unauthorized('This account is no longer active');
    return {
      accessToken: await this.tokens.signAccessToken(user.id),
      refreshToken: rotated.refreshToken,
      expiresIn: this.config.jwt.accessTtlSec,
      needsOnboarding: !user.username,
      user: this.usersService.toSelf(user),
    };
  }

  private async findOrCreate(appleSub: string, fullName: string): Promise<User> {
    const existing = await this.users.findOne({ where: { appleSub, deletedAt: IsNull() } });
    if (existing) return existing;
    try {
      const created = this.users.create({ appleSub, displayName: fullName.slice(0, 40) });
      return await this.users.save(created);
    } catch (err) {
      // two first sign-ins racing: the other one won
      if (isUniqueViolation(err)) {
        const winner = await this.users.findOne({ where: { appleSub, deletedAt: IsNull() } });
        if (winner) return winner;
      }
      throw err;
    }
  }

  private async respond(user: User): Promise<AuthResponse> {
    return {
      accessToken: await this.tokens.signAccessToken(user.id),
      refreshToken: await this.tokens.issueRefreshToken(user.id),
      expiresIn: this.config.jwt.accessTtlSec,
      needsOnboarding: !user.username,
      user: this.usersService.toSelf(user),
    };
  }
}
