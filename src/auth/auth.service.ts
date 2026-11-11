import { Inject, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { ApiError } from '../common/api-error.js';
import { isUniqueViolation } from '../common/db-errors.js';
import { RateLimiter } from '../common/rate-limiter.service.js';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import { User } from '../db/entities/user.entity.js';
import { Mailer } from '../mail/mailer.js';
import { UsersService, type SelfUserDto } from '../users/users.service.js';
import { AppleVerifier } from './apple-verifier.js';
import { EmailCodesService } from './email-codes.service.js';
import { GoogleVerifier } from './google-verifier.js';
import { DUMMY_HASH_PROMISE, hashPassword, verifyPassword } from './passwords.js';
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

/** Which sign-in method found the account, and what it knows about the person. */
interface Identity {
  column: 'appleSub' | 'googleSub';
  sub: string;
  /** Lowercase; only set when the provider says it is verified and real (not a relay address). */
  verifiedEmail?: string;
  name: string;
}

@Injectable()
export class AuthService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @InjectRepository(User) private readonly users: Repository<User>,
    private readonly apple: AppleVerifier,
    private readonly google: GoogleVerifier,
    private readonly tokens: TokensService,
    private readonly usersService: UsersService,
    private readonly codes: EmailCodesService,
    private readonly mailer: Mailer,
    private readonly limiter: RateLimiter,
  ) {}

  // MARK: Apple and Google

  async signInWithApple(input: { identityToken: string; nonce?: string; fullName?: string }): Promise<AuthResponse> {
    const identity = await this.apple.verify(input.identityToken, input.nonce);
    const linkable = identity.email && identity.emailVerified && !identity.isPrivateEmail;
    const user = await this.findOrCreate({
      column: 'appleSub',
      sub: identity.sub,
      verifiedEmail: linkable ? identity.email : undefined,
      name: input.fullName ?? '',
    });
    return this.respond(user);
  }

  async signInWithGoogle(idToken: string): Promise<AuthResponse> {
    if (this.config.google.clientIds.length === 0) throw ApiError.notFound('Route');
    const identity = await this.google.verify(idToken);
    const user = await this.findOrCreate({
      column: 'googleSub',
      sub: identity.sub,
      verifiedEmail: identity.emailVerified ? identity.email : undefined,
      name: identity.name ?? '',
    });
    return this.respond(user);
  }

  /**
   * The account for this provider id; otherwise the account that owns the same verified email,
   * which gets this provider attached; otherwise a new account.
   */
  private async findOrCreate(identity: Identity): Promise<User> {
    const where = { [identity.column]: identity.sub, deletedAt: IsNull() };
    const existing = await this.users.findOne({ where });
    if (existing) return existing;

    if (identity.verifiedEmail) {
      const byEmail = await this.users.findOne({ where: { email: identity.verifiedEmail, deletedAt: IsNull() } });
      if (byEmail && !byEmail[identity.column]) {
        await this.users.update(
          { id: byEmail.id },
          { [identity.column]: identity.sub, emailVerifiedAt: byEmail.emailVerifiedAt ?? new Date() },
        );
        byEmail[identity.column] = identity.sub;
        return byEmail;
      }
    }

    try {
      return await this.users.save(
        this.users.create({
          [identity.column]: identity.sub,
          email: identity.verifiedEmail ?? null,
          emailVerifiedAt: identity.verifiedEmail ? new Date() : null,
          displayName: identity.name.slice(0, 40),
        }),
      );
    } catch (err) {
      // two first sign-ins racing: the other one won
      if (isUniqueViolation(err)) {
        const winner = await this.users.findOne({ where });
        if (winner) return winner;
      }
      throw err;
    }
  }

  // MARK: email and password

  private assertEmailEnabled() {
    if (!this.config.email.enabled) throw ApiError.notFound('Route');
  }

  /** Always the same answer, so nobody can find out which addresses have accounts. */
  async emailSignUp(email: string, password: string): Promise<void> {
    this.assertEmailEnabled();
    await this.limiter.consume(`email-send:${email}`, 5, 3600, 'emails to this address');
    const code = await this.codes.issue(email, 'verify', await hashPassword(password));
    await this.sendCode(email, code, 'verify');
  }

  async emailResend(email: string): Promise<void> {
    this.assertEmailEnabled();
    await this.limiter.consume(`email-send:${email}`, 5, 3600, 'emails to this address');
    const passwordHash = await this.codes.pendingPassword(email);
    if (!passwordHash) return;
    const code = await this.codes.issue(email, 'verify', passwordHash);
    await this.sendCode(email, code, 'verify');
  }

  /** Confirms the address and signs in: a new account, or the password is added to the account with this email. */
  async emailVerify(email: string, code: string): Promise<AuthResponse> {
    this.assertEmailEnabled();
    await this.limiter.consume(`email-code:${email}`, 10, 900, 'code attempts');
    const { passwordHash } = await this.codes.consume(email, 'verify', code);
    let user = await this.users.findOne({ where: { email, deletedAt: IsNull() } });
    if (user) {
      await this.users.update({ id: user.id }, { passwordHash, emailVerifiedAt: user.emailVerifiedAt ?? new Date() });
    } else {
      user = await this.users.save(this.users.create({ email, emailVerifiedAt: new Date(), passwordHash }));
    }
    return this.respond(user);
  }

  async emailSignIn(email: string, password: string): Promise<AuthResponse> {
    this.assertEmailEnabled();
    await this.limiter.consume(`email-login:${email}`, 10, 900, 'sign-in attempts for this address');
    const user = await this.users.findOne({ where: { email, deletedAt: IsNull() } });
    if (user?.passwordHash && (await verifyPassword(password, user.passwordHash))) return this.respond(user);
    if (!user?.passwordHash) {
      // take as long as a real check, so timing does not reveal which addresses exist
      await verifyPassword(password, await DUMMY_HASH_PROMISE);
      const pending = await this.codes.pendingPassword(email);
      if (pending && (await verifyPassword(password, pending))) {
        throw ApiError.forbidden('email_not_verified', 'Confirm your email with the code we sent');
      }
    }
    throw new ApiError(401, 'invalid_credentials', 'The email or password is wrong');
  }

  /** Always the same answer; only an existing account gets a code. */
  async passwordForgot(email: string): Promise<void> {
    this.assertEmailEnabled();
    await this.limiter.consume(`email-send:${email}`, 5, 3600, 'emails to this address');
    const user = await this.users.findOne({ where: { email, deletedAt: IsNull() } });
    if (!user) return;
    const code = await this.codes.issue(email, 'reset');
    await this.sendCode(email, code, 'reset');
  }

  /** Sets a new password, signs out every other session, and signs in. */
  async passwordReset(email: string, code: string, newPassword: string): Promise<AuthResponse> {
    this.assertEmailEnabled();
    await this.limiter.consume(`email-code:${email}`, 10, 900, 'code attempts');
    await this.codes.consume(email, 'reset', code);
    const user = await this.users.findOne({ where: { email, deletedAt: IsNull() } });
    if (!user) throw ApiError.badRequest('invalid_code', 'That code is wrong or has expired');
    await this.users.update(
      { id: user.id },
      { passwordHash: await hashPassword(newPassword), emailVerifiedAt: user.emailVerifiedAt ?? new Date() },
    );
    await this.tokens.revokeAllForUser(user.id);
    return this.respond(user);
  }

  private async sendCode(email: string, code: string, purpose: 'verify' | 'reset') {
    const subject = purpose === 'verify' ? `Your Stoop code: ${code}` : `Reset your Stoop password: ${code}`;
    const english =
      purpose === 'verify'
        ? `Enter this code in Stoop to confirm your email:`
        : `Enter this code in Stoop to choose a new password:`;
    const arabic =
      purpose === 'verify' ? `أدخل هذا الرمز في Stoop لتأكيد بريدك الإلكتروني:` : `أدخل هذا الرمز في Stoop لاختيار كلمة مرور جديدة:`;
    await this.mailer.send({
      to: email,
      subject,
      text: `${english}\n\n${code}\n\nIt expires in 15 minutes. If you didn't ask for it, ignore this email.\n\n${arabic}\n\n${code}`,
    });
  }

  // MARK: development and refresh

  /** Development only: signs in as `username`, creating the account when needed. */
  async devLogin(username: string): Promise<AuthResponse> {
    if (!this.config.devAuthEnabled) throw ApiError.notFound('Route');
    const sub = `dev:${username}`;
    let user = await this.users.findOne({ where: { appleSub: sub, deletedAt: IsNull() } });
    if (!user) {
      user = await this.findOrCreate({ column: 'appleSub', sub, name: username });
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

  private async respond(user: User): Promise<AuthResponse> {
    const fresh = (await this.users.findOne({ where: { id: user.id } })) ?? user;
    return {
      accessToken: await this.tokens.signAccessToken(fresh.id),
      refreshToken: await this.tokens.issueRefreshToken(fresh.id),
      expiresIn: this.config.jwt.accessTtlSec,
      needsOnboarding: !fresh.username,
      user: this.usersService.toSelf(fresh),
    };
  }
}
