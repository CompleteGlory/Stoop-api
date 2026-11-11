import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { createTestApp, mailbox, resetState } from './helpers.js';

describe('email, Google and linked sign-in', () => {
  let app: INestApplication;
  const api = () => request(app.getHttpServer());

  beforeAll(async () => {
    app = await createTestApp();
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(async () => {
    await resetState(app);
    mailbox.sent.length = 0;
  });

  async function signUpByEmail(email: string, password = 'correct horse') {
    await api().post('/auth/email/signup').send({ email, password }).expect(202);
    const res = await api().post('/auth/email/verify').send({ email, code: mailbox.codeFor(email) }).expect(200);
    return res.body;
  }

  it('signs up with a code, then signs in with the password', async () => {
    await api().post('/auth/email/signup').send({ email: ' Nia@Example.com ', password: 'correct horse' }).expect(202);
    expect(mailbox.sent).toHaveLength(1);
    expect(mailbox.sent[0].to).toBe('nia@example.com');

    // not confirmed yet: the right password says so, a wrong one does not
    const early = await api().post('/auth/email/signin').send({ email: 'nia@example.com', password: 'correct horse' }).expect(403);
    expect(early.body.error.code).toBe('email_not_verified');
    const wrong = await api().post('/auth/email/signin').send({ email: 'nia@example.com', password: 'wrong horse' }).expect(401);
    expect(wrong.body.error.code).toBe('invalid_credentials');

    const verified = await api()
      .post('/auth/email/verify')
      .send({ email: 'nia@example.com', code: mailbox.codeFor('nia@example.com') })
      .expect(200);
    expect(verified.body.needsOnboarding).toBe(true);
    expect(verified.body.user).not.toHaveProperty('passwordHash');

    const signedIn = await api().post('/auth/email/signin').send({ email: 'NIA@example.com', password: 'correct horse' }).expect(200);
    expect(signedIn.body.user.id).toBe(verified.body.user.id);
    const bad = await api().post('/auth/email/signin').send({ email: 'nia@example.com', password: 'correct cow' }).expect(401);
    expect(bad.body.error.code).toBe('invalid_credentials');
  });

  it('gives the account the username chosen at sign-up, kept through a resend', async () => {
    await api().post('/auth/email/signup').send({ email: 'c@example.com', password: 'password1', username: ' Cleo.R ' }).expect(202);
    await api().post('/auth/email/resend').send({ email: 'c@example.com' }).expect(202);
    const res = await api().post('/auth/email/verify').send({ email: 'c@example.com', code: mailbox.codeFor('c@example.com') }).expect(200);
    expect(res.body.needsOnboarding).toBe(false);
    expect(res.body.user.username).toBe('cleo.r');
    expect(res.body.user.displayName).toBe('cleo.r');
  });

  it('refuses a taken, reserved or malformed username at sign-up, before sending anything', async () => {
    const first = await signUpByEmail('d@example.com');
    await api().patch('/me').set({ Authorization: `Bearer ${first.accessToken}` }).send({ username: 'dana' }).expect(200);
    const taken = await api().post('/auth/email/signup').send({ email: 'e@example.com', password: 'password1', username: 'dana' }).expect(409);
    expect(taken.body.error.code).toBe('username_taken');
    const reserved = await api().post('/auth/email/signup').send({ email: 'e@example.com', password: 'password1', username: 'admin' }).expect(422);
    expect(reserved.body.error.code).toBe('username_reserved');
    await api().post('/auth/email/signup').send({ email: 'e@example.com', password: 'password1', username: 'a b' }).expect(400);
    expect(mailbox.sent.filter((m) => m.to === 'e@example.com')).toHaveLength(0);
  });

  it('falls back to the username step when the name was taken before the code was entered', async () => {
    await api().post('/auth/email/signup').send({ email: 'f@example.com', password: 'password1', username: 'fern' }).expect(202);
    const other = await signUpByEmail('g@example.com');
    await api().patch('/me').set({ Authorization: `Bearer ${other.accessToken}` }).send({ username: 'fern' }).expect(200);
    const res = await api().post('/auth/email/verify').send({ email: 'f@example.com', code: mailbox.codeFor('f@example.com') }).expect(200);
    expect(res.body.needsOnboarding).toBe(true);
    expect(res.body.user.username).toBeNull();
  });

  it('keeps the existing username when the email already has an account', async () => {
    const first = await signUpByEmail('h@example.com');
    await api().patch('/me').set({ Authorization: `Bearer ${first.accessToken}` }).send({ username: 'hana' }).expect(200);
    await api().post('/auth/email/signup').send({ email: 'h@example.com', password: 'password2', username: 'other.name' }).expect(202);
    const res = await api().post('/auth/email/verify').send({ email: 'h@example.com', code: mailbox.codeFor('h@example.com') }).expect(200);
    expect(res.body.user.username).toBe('hana');
  });

  it('kills a code after 5 wrong tries, and resend issues a new one', async () => {
    await api().post('/auth/email/signup').send({ email: 'a@example.com', password: 'password1' }).expect(202);
    const right = mailbox.codeFor('a@example.com');
    const wrongCode = right === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i++) {
      const res = await api().post('/auth/email/verify').send({ email: 'a@example.com', code: wrongCode }).expect(400);
      expect(res.body.error.code).toBe('invalid_code');
    }
    await api().post('/auth/email/verify').send({ email: 'a@example.com', code: right }).expect(400);

    await api().post('/auth/email/resend').send({ email: 'a@example.com' }).expect(202);
    await api().post('/auth/email/verify').send({ email: 'a@example.com', code: mailbox.codeFor('a@example.com') }).expect(200);
  });

  it('answers the same for unknown addresses, and sends nothing to them', async () => {
    await api().post('/auth/password/forgot').send({ email: 'nobody@example.com' }).expect(202);
    await api().post('/auth/email/resend').send({ email: 'nobody@example.com' }).expect(202);
    expect(mailbox.sent).toHaveLength(0);
    const res = await api().post('/auth/email/signin').send({ email: 'nobody@example.com', password: 'whatever1' }).expect(401);
    expect(res.body.error.code).toBe('invalid_credentials');
  });

  it('resets a forgotten password and signs out other sessions', async () => {
    const first = await signUpByEmail('b@example.com', 'old password');
    await api().post('/auth/password/forgot').send({ email: 'b@example.com' }).expect(202);
    const reset = await api()
      .post('/auth/password/reset')
      .send({ email: 'b@example.com', code: mailbox.codeFor('b@example.com'), newPassword: 'new password' })
      .expect(200);
    expect(reset.body.user.id).toBe(first.user.id);

    await api().post('/auth/refresh').send({ refreshToken: first.refreshToken }).expect(401);
    await api().post('/auth/email/signin').send({ email: 'b@example.com', password: 'old password' }).expect(401);
    await api().post('/auth/email/signin').send({ email: 'b@example.com', password: 'new password' }).expect(200);
  });

  it('rejects bad emails, short passwords and malformed codes', async () => {
    for (const body of [
      { email: 'not-an-email', password: 'password1' },
      { email: 'c@example.com', password: 'short' },
      { email: 'c@example.com', password: 'x'.repeat(129) },
    ]) {
      const res = await api().post('/auth/email/signup').send(body).expect(400);
      expect(res.body.error.code).toBe('validation_failed');
    }
    await api().post('/auth/email/verify').send({ email: 'c@example.com', code: '12ab56' }).expect(400);
  });

  it('signs in with Google, creating the account once', async () => {
    const first = await api().post('/auth/google').send({ idToken: 'fake-google-token-for-g1|g1@example.com' }).expect(200);
    expect(first.body.user.displayName).toBe('Google g1');
    const again = await api().post('/auth/google').send({ idToken: 'fake-google-token-for-g1|g1@example.com' }).expect(200);
    expect(again.body.user.id).toBe(first.body.user.id);
    const bad = await api().post('/auth/google').send({ idToken: 'not-a-google-token-at-all-really' }).expect(401);
    expect(bad.body.error.code).toBe('unauthorized');
  });

  it('links Google, Apple and email to one account through a verified email', async () => {
    const byEmail = await signUpByEmail('same@example.com');
    const google = await api().post('/auth/google').send({ idToken: 'fake-google-token-for-g2|same@example.com' }).expect(200);
    expect(google.body.user.id).toBe(byEmail.user.id);
    const apple = await api().post('/auth/apple').send({ identityToken: 'fake-apple-token-for-a2|same@example.com' }).expect(200);
    expect(apple.body.user.id).toBe(byEmail.user.id);

    // an unverified Google email or an Apple relay address never links
    const unverified = await api()
      .post('/auth/google')
      .send({ idToken: 'fake-google-token-for-g3|same@example.com|unverified' })
      .expect(200);
    expect(unverified.body.user.id).not.toBe(byEmail.user.id);
    const relay = await api()
      .post('/auth/apple')
      .send({ identityToken: 'fake-apple-token-for-a3|same@example.com|private' })
      .expect(200);
    expect(relay.body.user.id).not.toBe(byEmail.user.id);
  });

  it('adds a password to an Apple account that owns the email', async () => {
    const apple = await api().post('/auth/apple').send({ identityToken: 'fake-apple-token-for-a4|d@example.com' }).expect(200);
    const byEmail = await signUpByEmail('d@example.com');
    expect(byEmail.user.id).toBe(apple.body.user.id);
  });

  it('forgets the email, password and Google link when the account is deleted', async () => {
    const google = await api().post('/auth/google').send({ idToken: 'fake-google-token-for-g5|e@example.com' }).expect(200);
    await api().patch('/me').set({ Authorization: `Bearer ${google.body.accessToken}` }).send({ username: 'erin' }).expect(200);
    await api().delete('/me').set({ Authorization: `Bearer ${google.body.accessToken}` }).expect(204);

    const [row] = await app.get(DataSource).query(`SELECT email, google_sub, password_hash FROM users WHERE id = $1`, [google.body.user.id]);
    expect(row).toEqual({ email: null, google_sub: null, password_hash: null });
    const fresh = await api().post('/auth/google').send({ idToken: 'fake-google-token-for-g5|e@example.com' }).expect(200);
    expect(fresh.body.user.id).not.toBe(google.body.user.id);
  });
});
