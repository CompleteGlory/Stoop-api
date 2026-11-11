import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { ApiError } from '../common/api-error.js';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';

export interface AppleIdentity {
  /** Apple's stable, app-scoped user id. */
  sub: string;
  email?: string;
}

/** Abstract so tests (and local development) can swap the network call out. */
export abstract class AppleVerifier {
  abstract verify(identityToken: string, rawNonce?: string): Promise<AppleIdentity>;
}

const APPLE_ISSUER = 'https://appleid.apple.com';

@Injectable()
export class JoseAppleVerifier extends AppleVerifier {
  // jose caches the keys and re-fetches when it meets an unknown `kid`
  private readonly keys = createRemoteJWKSet(new URL(`${APPLE_ISSUER}/auth/keys`));

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {
    super();
  }

  async verify(identityToken: string, rawNonce?: string): Promise<AppleIdentity> {
    let payload;
    try {
      ({ payload } = await jwtVerify(identityToken, this.keys, {
        issuer: APPLE_ISSUER,
        audience: this.config.apple.bundleId,
      }));
    } catch {
      throw ApiError.unauthorized('The Apple identity token is not valid');
    }
    if (!payload.sub) throw ApiError.unauthorized('The Apple identity token has no subject');

    if (rawNonce) {
      // iOS sends Apple the SHA-256 of the nonce; Apple echoes it back in the token
      const hashed = createHash('sha256').update(rawNonce).digest('hex');
      if (payload.nonce !== hashed && payload.nonce !== rawNonce) {
        throw ApiError.unauthorized('The nonce does not match the Apple identity token');
      }
    }
    return { sub: payload.sub, email: typeof payload.email === 'string' ? payload.email : undefined };
  }
}
