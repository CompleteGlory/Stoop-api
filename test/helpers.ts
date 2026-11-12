import { Injectable, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module.js';
import { setupApp } from '../src/app.setup.js';
import { AppleVerifier, type AppleIdentity } from '../src/auth/apple-verifier.js';
import { AppleTokenClient } from '../src/auth/apple-tokens.js';
import { GoogleVerifier, type GoogleIdentity } from '../src/auth/google-verifier.js';
import { Mailer, type Email } from '../src/mail/mailer.js';
import { ApiError } from '../src/common/api-error.js';
import { RedisService } from '../src/redis/redis.service.js';
import { ApnsClient, type PushMessage, type PushResult, type PushTarget } from '../src/notifications/apns.client.js';

/**
 * Treats the identity token as the Apple `sub`, so tests need no network and no Apple keys.
 * `fake-apple-token-for-<sub>|<email>` adds a verified email; `|<email>|private` marks it as a relay address.
 */
@Injectable()
export class FakeAppleVerifier extends AppleVerifier {
  async verify(identityToken: string): Promise<AppleIdentity> {
    if (!identityToken.startsWith('fake-apple-token-for-')) throw new Error('not a fake token');
    const [sub, email, flag] = identityToken.slice('fake-apple-token-for-'.length).split('|');
    return { sub, email, emailVerified: Boolean(email), isPrivateEmail: flag === 'private' };
  }
}

/** `fake-google-token-for-<sub>|<email>|<verified|unverified>`. */
@Injectable()
export class FakeGoogleVerifier extends GoogleVerifier {
  async verify(idToken: string): Promise<GoogleIdentity> {
    if (!idToken.startsWith('fake-google-token-for-')) throw ApiError.unauthorized('The Google ID token is not valid');
    const [sub, email, verified] = idToken.slice('fake-google-token-for-'.length).split('|');
    return { sub, email, emailVerified: verified !== 'unverified', name: `Google ${sub}` };
  }
}

/** Swaps `code-<x>` for `refresh-<x>` and records what was revoked. `bad-code` fails. */
export class FakeAppleTokenClient extends AppleTokenClient {
  enabled = true;
  readonly revoked: string[] = [];

  async exchange(authorizationCode: string): Promise<string> {
    if (authorizationCode === 'bad-code') throw new Error('Apple said no');
    return authorizationCode.replace(/^code-/, 'refresh-');
  }

  async revoke(refreshToken: string): Promise<void> {
    this.revoked.push(refreshToken);
  }
}

export const appleTokens = new FakeAppleTokenClient();

/** Keeps sent emails so tests can read the codes. */
export class CapturingMailer extends Mailer {
  readonly sent: Email[] = [];

  async send(email: Email): Promise<void> {
    this.sent.push(email);
  }

  /** The 6-digit code in the latest email to `to`. */
  codeFor(to: string): string {
    const email = [...this.sent].reverse().find((e) => e.to === to);
    const code = email?.text.match(/\b(\d{6})\b/)?.[1];
    if (!code) throw new Error(`no code was emailed to ${to}`);
    return code;
  }
}

export const mailbox = new CapturingMailer();

/** Records pushes instead of sending them. Tokens listed in `dead` answer like Apple does for removed apps. */
export class FakeApnsClient extends ApnsClient {
  enabled = true;
  readonly sent: (PushMessage & { token: string })[] = [];
  readonly dead = new Set<string>();

  async send(target: PushTarget, message: PushMessage): Promise<PushResult> {
    if (this.dead.has(target.token)) return 'unregistered';
    this.sent.push({ ...message, token: target.token });
    return 'sent';
  }

  /** Pushes to `token` of this kind, oldest first. */
  to(token: string, kind?: string) {
    return this.sent.filter((m) => m.token === token && (!kind || m.payload.kind === kind));
  }

  reset() {
    this.sent.length = 0;
    this.dead.clear();
    this.enabled = true;
  }
}

export const apns = new FakeApnsClient();

export async function createTestApp(): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(AppleVerifier)
    .useClass(FakeAppleVerifier)
    .overrideProvider(GoogleVerifier)
    .useClass(FakeGoogleVerifier)
    .overrideProvider(Mailer)
    .useValue(mailbox)
    .overrideProvider(AppleTokenClient)
    .useValue(appleTokens)
    .overrideProvider(ApnsClient)
    .useValue(apns)
    .compile();
  const app = setupApp(moduleRef.createNestApplication());
  await app.init();
  return app;
}

/** Empties every table and Redis, so each test starts from nothing. */
export async function resetState(app: INestApplication) {
  // background work from the previous test (the nearby check after a live position, a friend-list
  // refresh) can still be reading these tables; Postgres then cancels one side as a deadlock
  for (let attempt = 1; ; attempt++) {
    try {
      await app.get(DataSource).query('TRUNCATE users, places RESTART IDENTITY CASCADE');
      break;
    } catch (err) {
      if ((err as { code?: string }).code !== '40P01' || attempt === 3) throw err;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  await app.get(RedisService).client.flushdb();
}

export interface TestUser {
  id: string;
  username: string;
  accessToken: string;
  refreshToken: string;
  auth: { Authorization: string };
}

/** Signs a person in with the fake Apple token and finishes onboarding. */
export async function signUp(app: INestApplication, username: string): Promise<TestUser> {
  const server = app.getHttpServer();
  const res = await request(server)
    .post('/auth/apple')
    .send({ identityToken: `fake-apple-token-for-${username}` })
    .expect(200);
  const auth = { Authorization: `Bearer ${res.body.accessToken}` };
  await request(server).patch('/me').set(auth).send({ username, displayName: username }).expect(200);
  return {
    id: res.body.user.id,
    username,
    accessToken: res.body.accessToken,
    refreshToken: res.body.refreshToken,
    auth,
  };
}

/** Makes `a` and `b` friends. */
export async function befriend(app: INestApplication, a: TestUser, b: TestUser) {
  const server = app.getHttpServer();
  const sent = await request(server).post('/friends/requests').set(a.auth).send({ userId: b.id }).expect(200);
  await request(server).post(`/friends/requests/${sent.body.id}/accept`).set(b.auth).expect(204);
}

export const downtown = { latitude: 30.0444, longitude: 31.2357 };
