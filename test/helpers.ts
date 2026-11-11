import { Injectable, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module.js';
import { setupApp } from '../src/app.setup.js';
import { AppleVerifier, type AppleIdentity } from '../src/auth/apple-verifier.js';
import { RedisService } from '../src/redis/redis.service.js';

/** Treats the identity token as the Apple `sub`, so tests need no network and no Apple keys. */
@Injectable()
export class FakeAppleVerifier extends AppleVerifier {
  async verify(identityToken: string): Promise<AppleIdentity> {
    if (!identityToken.startsWith('fake-apple-token-for-')) throw new Error('not a fake token');
    return { sub: identityToken.slice('fake-apple-token-for-'.length) };
  }
}

export async function createTestApp(): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(AppleVerifier)
    .useClass(FakeAppleVerifier)
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
