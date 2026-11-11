import { Injectable, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module.js';
import { setupApp } from '../src/app.setup.js';
import { AppleVerifier, type AppleIdentity } from '../src/auth/apple-verifier.js';
import { GoogleVerifier, type GoogleIdentity } from '../src/auth/google-verifier.js';
import { Mailer, type Email } from '../src/mail/mailer.js';
import { ApiError } from '../src/common/api-error.js';
import { RedisService } from '../src/redis/redis.service.js';

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

export async function createTestApp(): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(AppleVerifier)
    .useClass(FakeAppleVerifier)
    .overrideProvider(GoogleVerifier)
    .useClass(FakeGoogleVerifier)
    .overrideProvider(Mailer)
    .useValue(mailbox)
    .compile();
  const app = setupApp(moduleRef.createNestApplication());
  await app.init();
  return app;
}

/** Empties every table and Redis, so each test starts from nothing. */
export async function resetState(app: INestApplication) {
  await app.get(DataSource).query('TRUNCATE users, places RESTART IDENTITY CASCADE');
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
