import { Inject, Injectable } from '@nestjs/common';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { ApiError } from '../common/api-error.js';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';

export interface GoogleIdentity {
  /** Google's stable user id. */
  sub: string;
  email?: string;
  /** Only a verified email may link to an existing account. */
  emailVerified: boolean;
  name?: string;
}

/** Abstract so tests can swap the network call out. */
export abstract class GoogleVerifier {
  abstract verify(idToken: string): Promise<GoogleIdentity>;
}

/** Checks a Google ID token's signature, issuer, audience (our client ids) and expiry. */
@Injectable()
export class JoseGoogleVerifier extends GoogleVerifier {
  // jose caches Google's keys and re-fetches when it meets an unknown `kid`
  private readonly keys = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {
    super();
  }

  async verify(idToken: string): Promise<GoogleIdentity> {
    let payload;
    try {
      ({ payload } = await jwtVerify(idToken, this.keys, {
        issuer: ['https://accounts.google.com', 'accounts.google.com'],
        audience: this.config.google.clientIds,
      }));
    } catch {
      throw ApiError.unauthorized('The Google ID token is not valid');
    }
    if (!payload.sub) throw ApiError.unauthorized('The Google ID token has no subject');
    return {
      sub: payload.sub,
      email: typeof payload.email === 'string' ? payload.email.toLowerCase() : undefined,
      emailVerified: payload.email_verified === true || payload.email_verified === 'true',
      name: typeof payload.name === 'string' ? payload.name : undefined,
    };
  }
}
