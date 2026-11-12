import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { importPKCS8, SignJWT } from 'jose';
import type { Subscription } from 'rxjs';
import { DomainEvents } from '../common/domain-events.js';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';

const APPLE = 'https://appleid.apple.com';

/**
 * Apple's token endpoints for Sign in with Apple: swap the one-time authorization code for a refresh
 * token at sign-in, and revoke that token when the account is deleted (App Review requires it).
 * Abstract so tests need no network. Nothing here ever logs a token or a code.
 */
export abstract class AppleTokenClient {
  /** False until the Sign in with Apple key is configured; then sign-in and deletion skip Apple. */
  abstract readonly enabled: boolean;
  /** The refresh token for this authorization code (valid 5 minutes, single use). */
  abstract exchange(authorizationCode: string): Promise<string>;
  abstract revoke(refreshToken: string): Promise<void>;
}

@Injectable()
export class HttpAppleTokenClient extends AppleTokenClient {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {
    super();
  }

  get enabled(): boolean {
    return this.config.apple.signInKey !== null;
  }

  async exchange(authorizationCode: string): Promise<string> {
    const body = await this.post('/auth/token', {
      code: authorizationCode,
      grant_type: 'authorization_code',
    });
    const token = (body as { refresh_token?: unknown }).refresh_token;
    if (typeof token !== 'string' || !token) throw new Error('Apple returned no refresh token');
    return token;
  }

  async revoke(refreshToken: string): Promise<void> {
    await this.post('/auth/revoke', { token: refreshToken, token_type_hint: 'refresh_token' });
  }

  /** The short-lived client secret Apple asks for: an ES256 JWT signed with the developer key. */
  async clientSecret(now = new Date()): Promise<string> {
    const key = this.config.apple.signInKey;
    if (!key) throw new Error('Sign in with Apple key is not configured');
    const privateKey = await importPKCS8(key.privateKey, 'ES256');
    const issuedAt = Math.floor(now.getTime() / 1000);
    return new SignJWT({})
      .setProtectedHeader({ alg: 'ES256', kid: key.keyId })
      .setIssuer(key.teamId)
      .setSubject(this.config.apple.bundleId)
      .setAudience(APPLE)
      .setIssuedAt(issuedAt)
      .setExpirationTime(issuedAt + 300)
      .sign(privateKey);
  }

  private async post(path: string, fields: Record<string, string>): Promise<unknown> {
    const form = new URLSearchParams({
      client_id: this.config.apple.bundleId,
      client_secret: await this.clientSecret(),
      ...fields,
    });
    const response = await fetch(`${APPLE}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form,
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`Apple ${path} answered ${response.status}`);
    const text = await response.text();
    return text ? JSON.parse(text) : {};
  }
}

/** Revokes a deleted account's Apple token in the background. Failures are logged, never retried here. */
@Injectable()
export class AppleRevoker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AppleRevoker.name);
  private subscription?: Subscription;

  constructor(
    private readonly events: DomainEvents,
    private readonly apple: AppleTokenClient,
  ) {}

  onModuleInit() {
    this.subscription = this.events.events$.subscribe((event) => {
      if (event.type !== 'apple-token-revoke' || !this.apple.enabled) return;
      this.apple.revoke(event.refreshToken).catch((err: unknown) => {
        this.logger.warn(`Could not revoke a Sign in with Apple token: ${err instanceof Error ? err.message : 'unknown error'}`);
      });
    });
  }

  onModuleDestroy() {
    this.subscription?.unsubscribe();
  }
}
