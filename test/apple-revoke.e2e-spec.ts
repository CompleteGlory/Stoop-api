import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { appleTokens, createTestApp, resetState } from './helpers.js';

describe('revoking Sign in with Apple on account deletion', () => {
  let app: INestApplication;
  const api = () => request(app.getHttpServer());
  const storedToken = async (userId: string) =>
    (await app.get(DataSource).query(`SELECT apple_refresh_token FROM users WHERE id = $1`, [userId]))[0]
      ?.apple_refresh_token ?? null;
  const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

  beforeAll(async () => {
    app = await createTestApp();
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(async () => {
    await resetState(app);
    appleTokens.revoked.length = 0;
    appleTokens.enabled = true;
  });

  it('keeps the Apple token from sign-in and revokes it when the account is deleted', async () => {
    const res = await api()
      .post('/auth/apple')
      .send({ identityToken: 'fake-apple-token-for-r1', authorizationCode: 'code-abc' })
      .expect(200);
    expect(res.body.user).not.toHaveProperty('appleRefreshToken');
    expect(await storedToken(res.body.user.id)).toBe('refresh-abc');

    const auth = { Authorization: `Bearer ${res.body.accessToken}` };
    await api().patch('/me').set(auth).send({ username: 'r1user' }).expect(200);
    await api().delete('/me').set(auth).expect(204);
    await settle();

    expect(appleTokens.revoked).toEqual(['refresh-abc']);
    expect(await storedToken(res.body.user.id)).toBeNull();
  });

  it('still signs in when Apple refuses the code, and has nothing to revoke', async () => {
    const res = await api()
      .post('/auth/apple')
      .send({ identityToken: 'fake-apple-token-for-r2', authorizationCode: 'bad-code' })
      .expect(200);
    expect(await storedToken(res.body.user.id)).toBeNull();
    await api().delete('/me').set({ Authorization: `Bearer ${res.body.accessToken}` }).expect(204);
    await settle();
    expect(appleTokens.revoked).toEqual([]);
  });

  it('does nothing with Apple while the key is not configured', async () => {
    appleTokens.enabled = false;
    const res = await api()
      .post('/auth/apple')
      .send({ identityToken: 'fake-apple-token-for-r3', authorizationCode: 'code-xyz' })
      .expect(200);
    expect(await storedToken(res.body.user.id)).toBeNull();
  });

  it('accepts sign-ins without a code, as older app versions send', async () => {
    await api().post('/auth/apple').send({ identityToken: 'fake-apple-token-for-r4' }).expect(200);
  });
});
