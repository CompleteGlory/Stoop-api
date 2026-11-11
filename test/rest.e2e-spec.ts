import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { befriend, createTestApp, downtown, resetState, signUp } from './helpers.js';

describe('REST API (real Postgres + PostGIS and Redis)', () => {
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
  });

  describe('health and errors', () => {
    it('reports Postgres and Redis as up', async () => {
      const res = await api().get('/health').expect(200);
      expect(res.body).toEqual({ status: 'ok', db: 'up', redis: 'up' });
    });

    it('answers with the { error: { code, message } } envelope', async () => {
      const res = await api().get('/me').expect(401);
      expect(res.body).toEqual({ error: { code: 'unauthorized', message: expect.any(String) } });

      const missing = await api().get('/nope').expect(404);
      expect(missing.body.error.code).toBe('not_found');

      const invalid = await api().post('/auth/apple').send({ identityToken: 1 }).expect(400);
      expect(invalid.body.error.code).toBe('validation_failed');
    });

    it('rejects unknown properties instead of ignoring them', async () => {
      const alice = await signUp(app, 'alice');
      const res = await api().patch('/me').set(alice.auth).send({ isAdmin: true }).expect(400);
      expect(res.body.error.code).toBe('validation_failed');
    });

    it('keeps the dev sign-in closed unless it is switched on', async () => {
      await api().post('/auth/dev').send({ username: 'mallory' }).expect(404);
    });
  });

  describe('auth and profile', () => {
    it('creates an account on first Apple sign-in and asks for a username', async () => {
      const res = await api()
        .post('/auth/apple')
        .send({ identityToken: 'fake-apple-token-for-newcomer', fullName: '  Nia Newcomer ' })
        .expect(200);
      expect(res.body.needsOnboarding).toBe(true);
      expect(res.body.user).toMatchObject({ username: null, displayName: 'Nia Newcomer', ghostMode: false });
      // no character yet: the app asks for one after the username
      expect(res.body.user.avatar).toBeNull();
      expect(res.body.expiresIn).toBe(900);

      // signing in again finds the same account
      const again = await api()
        .post('/auth/apple')
        .send({ identityToken: 'fake-apple-token-for-newcomer' })
        .expect(200);
      expect(again.body.user.id).toBe(res.body.user.id);
    });

    it('sets and validates usernames', async () => {
      const alice = await signUp(app, 'alice');
      const bob = await signUp(app, 'bob');

      const taken = await api().patch('/me').set(bob.auth).send({ username: 'Alice' }).expect(409);
      expect(taken.body.error.code).toBe('username_taken');

      const bad = await api().patch('/me').set(bob.auth).send({ username: 'a b!' }).expect(400);
      expect(bad.body.error.code).toBe('validation_failed');

      const reserved = await api().patch('/me').set(bob.auth).send({ username: 'admin' }).expect(422);
      expect(reserved.body.error.code).toBe('username_reserved');

      const me = await api().get('/me').set(alice.auth).expect(200);
      expect(me.body.username).toBe('alice');
    });

    it('allows only /me until a username is chosen', async () => {
      const signIn = await api()
        .post('/auth/apple')
        .send({ identityToken: 'fake-apple-token-for-newcomer' })
        .expect(200);
      const auth = { Authorization: `Bearer ${signIn.body.accessToken}` };

      const blocked = [
        api().get('/friends'),
        api().get('/blocks'),
        api().get('/users/search?q=ali'),
        api().get('/places?bbox=31.2,30.0,31.3,30.1'),
        api().post('/places/resolve').send({ name: 'Cafe Riche', ...downtown }),
      ];
      for (const call of blocked) {
        const res = await call.set(auth).expect(403);
        expect(res.body.error.code).toBe('username_required');
      }

      await api().get('/me').set(auth).expect(200);
      await api().patch('/me').set(auth).send({ username: 'newcomer' }).expect(200);
      await api().get('/friends').set(auth).expect(200);

      const refreshed = await api()
        .post('/auth/refresh')
        .send({ refreshToken: signIn.body.refreshToken })
        .expect(200);
      expect(refreshed.body.needsOnboarding).toBe(false);
    });

    it('lets an account without a username delete itself', async () => {
      const signIn = await api()
        .post('/auth/apple')
        .send({ identityToken: 'fake-apple-token-for-newcomer' })
        .expect(200);
      await api().delete('/me').set({ Authorization: `Bearer ${signIn.body.accessToken}` }).expect(204);
    });

    it('never lets a username be cleared', async () => {
      const alice = await signUp(app, 'alice');
      const res = await api().patch('/me').set(alice.auth).send({ username: null }).expect(400);
      expect(res.body.error.code).toBe('validation_failed');

      const me = await api().get('/me').set(alice.auth).expect(200);
      expect(me.body.username).toBe('alice');
    });

    it('saves a DiceBear character and rejects options the style does not have', async () => {
      const alice = await signUp(app, 'alice');
      const character = { style: 'avataaars', options: { top: 'shortFlat', hairColor: '111111', facialHair: 'none' } };
      const ok = await api().patch('/me').set(alice.auth).send({ avatar: character }).expect(200);
      expect(ok.body.avatar).toEqual(character);
      expect((await api().get('/me').set(alice.auth).expect(200)).body.avatar).toEqual(character);

      for (const avatar of [
        { style: 'identicon', options: {} },
        { style: 'avataaars', options: { top: 'dragonHair' } },
        { style: 'avataaars', options: { wings: 'big' } },
      ]) {
        const bad = await api().patch('/me').set(alice.auth).send({ avatar }).expect(400);
        expect(bad.body.error.code).toBe('invalid_avatar');
      }
      const notAnObject = await api().patch('/me').set(alice.auth).send({ avatar: 'fox' }).expect(400);
      expect(notAnObject.body.error.code).toBe('validation_failed');
      // the old preset field is gone
      await api().patch('/me').set(alice.auth).send({ avatarPreset: 'owl' }).expect(400);
    });

    it('rotates refresh tokens and revokes the family when an old one is replayed', async () => {
      const alice = await signUp(app, 'alice');

      const first = await api().post('/auth/refresh').send({ refreshToken: alice.refreshToken }).expect(200);
      expect(first.body.refreshToken).not.toBe(alice.refreshToken);
      await api().get('/me').set({ Authorization: `Bearer ${first.body.accessToken}` }).expect(200);

      // once the grace window has passed, replaying the first token is treated as theft
      await app.get(DataSource).query(
        `UPDATE refresh_tokens SET revoked_at = now() - interval '1 minute' WHERE revoked_at IS NOT NULL`,
      );
      await api().post('/auth/refresh').send({ refreshToken: alice.refreshToken }).expect(401);
      await api().post('/auth/refresh').send({ refreshToken: first.body.refreshToken }).expect(401);
    });

    it('recovers a refresh whose response was lost, within the grace window', async () => {
      const alice = await signUp(app, 'alice');
      const lost = await api().post('/auth/refresh').send({ refreshToken: alice.refreshToken }).expect(200);

      // the client never saw `lost`, so it retries with the token it still has
      const retry = await api().post('/auth/refresh').send({ refreshToken: alice.refreshToken }).expect(200);
      expect(retry.body.refreshToken).not.toBe(lost.body.refreshToken);
      await api().get('/me').set({ Authorization: `Bearer ${retry.body.accessToken}` }).expect(200);

      // only the newest token stays alive, and using it keeps working
      await api().post('/auth/refresh').send({ refreshToken: retry.body.refreshToken }).expect(200);
    });

    it('does not let the grace window undo a logout', async () => {
      const alice = await signUp(app, 'alice');
      const next = await api().post('/auth/refresh').send({ refreshToken: alice.refreshToken }).expect(200);
      await api().post('/auth/logout').send({ refreshToken: next.body.refreshToken }).expect(204);
      await api().post('/auth/refresh').send({ refreshToken: alice.refreshToken }).expect(401);
    });

    it('reports whether a username is available, before onboarding too', async () => {
      await signUp(app, 'alice');
      const signIn = await api()
        .post('/auth/apple')
        .send({ identityToken: 'fake-apple-token-for-newcomer' })
        .expect(200);
      const auth = { Authorization: `Bearer ${signIn.body.accessToken}` };
      const check = async (username: string) =>
        (await api().get('/users/availability').query({ username }).set(auth).expect(200)).body;

      expect(await check('fresh.name')).toEqual({ available: true, reason: null });
      expect(await check('ALICE')).toEqual({ available: false, reason: 'taken' });
      expect(await check('admin')).toEqual({ available: false, reason: 'reserved' });
      expect(await check('a b!')).toEqual({ available: false, reason: 'invalid' });
    });

    it('treats your own username as available', async () => {
      const alice = await signUp(app, 'alice');
      const res = await api().get('/users/availability').query({ username: 'alice' }).set(alice.auth).expect(200);
      expect(res.body).toEqual({ available: true, reason: null });
    });

    it('requires a token and a username parameter to check availability', async () => {
      await api().get('/users/availability').query({ username: 'alice' }).expect(401);
      const alice = await signUp(app, 'alice');
      const res = await api().get('/users/availability').set(alice.auth).expect(400);
      expect(res.body.error.code).toBe('validation_failed');
    });

    it('logs out by revoking the refresh token', async () => {
      const alice = await signUp(app, 'alice');
      await api().post('/auth/logout').send({ refreshToken: alice.refreshToken }).expect(204);
      await api().post('/auth/refresh').send({ refreshToken: alice.refreshToken }).expect(401);
    });

    it('rejects a token signed with another secret', async () => {
      await api()
        .get('/me')
        .set({ Authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.abc' })
        .expect(401);
    });
  });

  describe('places', () => {
    it('resolves the same Apple place to one row', async () => {
      const alice = await signUp(app, 'alice');
      const body = { appleId: 'I63802885', name: 'Cafe Riche', category: 'Cafe', ...downtown };
      const a = await api().post('/places/resolve').set(alice.auth).send(body).expect(200);
      const b = await api()
        .post('/places/resolve')
        .set(alice.auth)
        .send({ ...body, name: 'Renamed By A Client', latitude: 31 })
        .expect(200);
      expect(b.body.id).toBe(a.body.id);
      expect(b.body.name).toBe('Cafe Riche'); // clients cannot rename an existing place
      expect(a.body).toMatchObject({ appleId: 'I63802885', ratingCount: 0, avgRating: 0 });
      expect(a.body.latitude).toBeCloseTo(downtown.latitude, 5);
      expect(a.body.longitude).toBeCloseTo(downtown.longitude, 5);
    });

    it('merges places without an Apple id that share a name and sit within 30 m', async () => {
      const alice = await signUp(app, 'alice');
      const make = (name: string, dLat = 0) =>
        api()
          .post('/places/resolve')
          .set(alice.auth)
          .send({ name, latitude: downtown.latitude + dLat, longitude: downtown.longitude })
          .expect(200);
      const a = await make('Corner Shop');
      const near = await make('corner shop', 0.0001); // ~11 m
      const far = await make('Corner Shop', 0.01); // ~1.1 km
      const other = await make('Other Shop');
      expect(near.body.id).toBe(a.body.id);
      expect(far.body.id).not.toBe(a.body.id);
      expect(other.body.id).not.toBe(a.body.id);
    });

    it('lists places inside a bounding box only', async () => {
      const alice = await signUp(app, 'alice');
      const resolve = (appleId: string, latitude: number, longitude: number) =>
        api().post('/places/resolve').set(alice.auth).send({ appleId, name: appleId, latitude, longitude }).expect(200);
      await resolve('in-cairo', 30.05, 31.23);
      await resolve('in-giza', 30.01, 31.21);
      await resolve('in-london', 51.5, -0.12);

      const box = '30.9,29.9,31.5,30.2';
      const res = await api().get('/places').query({ bbox: box }).set(alice.auth).expect(200);
      expect(res.body.items.map((p: any) => p.appleId).sort()).toEqual(['in-cairo', 'in-giza']);
    });

    it('validates the bounding box', async () => {
      const alice = await signUp(app, 'alice');
      for (const bbox of ['', 'a,b,c,d', '1,2,3', '31,30,30,31', '0,0,40,40', '-200,0,0,10']) {
        const res = await api().get('/places').query({ bbox }).set(alice.auth).expect(400);
        expect(res.body.error.code).toBe('invalid_bbox');
      }
      await api().get('/places').set(alice.auth).expect(400);
    });

    it('returns 404 for an unknown place and 400 for a malformed id', async () => {
      const alice = await signUp(app, 'alice');
      await api().get('/places/3f2504e0-4f89-41d3-9a0c-0305e82c3301').set(alice.auth).expect(404);
      const res = await api().get('/places/not-a-uuid').set(alice.auth).expect(400);
      expect(res.body.error.code).toBe('invalid_id');
    });
  });

  describe('ratings', () => {
    async function placeFor(user: { auth: { Authorization: string } }, appleId = 'p1') {
      const res = await api()
        .post('/places/resolve')
        .set(user.auth)
        .send({ appleId, name: `Place ${appleId}`, ...downtown })
        .expect(200);
      return res.body.id as string;
    }

    it('averages everyone’s ratings and is idempotent per person', async () => {
      const alice = await signUp(app, 'alice');
      const bob = await signUp(app, 'bob');
      const placeId = await placeFor(alice);

      const put = (u: typeof alice, stars: number, comment?: string | null) =>
        api().put(`/places/${placeId}/rating`).set(u.auth).send({ stars, comment });

      const first = await put(alice, 5, 'Great coffee').expect(200);
      expect(first.body.place).toMatchObject({ avgRating: 5, ratingCount: 1 });
      expect(first.body.rating).toMatchObject({ stars: 5, comment: 'Great coffee' });

      // the same request again changes nothing, including the timestamp
      const again = await put(alice, 5, 'Great coffee').expect(200);
      expect(again.body.rating.id).toBe(first.body.rating.id);
      expect(again.body.rating.updatedAt).toBe(first.body.rating.updatedAt);
      expect(again.body.place).toMatchObject({ avgRating: 5, ratingCount: 1 });

      const second = await put(bob, 2).expect(200);
      expect(second.body.place).toMatchObject({ avgRating: 3.5, ratingCount: 2 });

      // changing a rating replaces it instead of adding another
      const changed = await put(alice, 3, null).expect(200);
      expect(changed.body.place).toMatchObject({ avgRating: 2.5, ratingCount: 2 });
      expect(changed.body.rating.comment).toBeNull();

      const detail = await api().get(`/places/${placeId}`).set(alice.auth).expect(200);
      expect(detail.body).toMatchObject({ avgRating: 2.5, ratingCount: 2, myRating: { stars: 3 } });
    });

    it('validates stars and comment length', async () => {
      const alice = await signUp(app, 'alice');
      const placeId = await placeFor(alice);
      const put = (body: object) => api().put(`/places/${placeId}/rating`).set(alice.auth).send(body);
      await put({ stars: 0 }).expect(400);
      await put({ stars: 6 }).expect(400);
      await put({ stars: 3.5 }).expect(400);
      await put({ stars: 4, comment: 'x'.repeat(281) }).expect(400);
      await put({ stars: 4, comment: 'x'.repeat(280) }).expect(200);
      await api()
        .put('/places/3f2504e0-4f89-41d3-9a0c-0305e82c3301/rating')
        .set(alice.auth)
        .send({ stars: 4 })
        .expect(404);
    });

    it('deletes a rating idempotently and updates the aggregate', async () => {
      const alice = await signUp(app, 'alice');
      const bob = await signUp(app, 'bob');
      const placeId = await placeFor(alice);
      await api().put(`/places/${placeId}/rating`).set(alice.auth).send({ stars: 5 }).expect(200);
      await api().put(`/places/${placeId}/rating`).set(bob.auth).send({ stars: 1 }).expect(200);

      await api().delete(`/places/${placeId}/rating`).set(alice.auth).expect(204);
      await api().delete(`/places/${placeId}/rating`).set(alice.auth).expect(204);

      const detail = await api().get(`/places/${placeId}`).set(bob.auth).expect(200);
      expect(detail.body).toMatchObject({ avgRating: 1, ratingCount: 1 });

      await api().delete(`/places/${placeId}/rating`).set(bob.auth).expect(204);
      const empty = await api().get(`/places/${placeId}`).set(bob.auth).expect(200);
      expect(empty.body).toMatchObject({ avgRating: 0, ratingCount: 0, myRating: null });
    });

    it('keeps the aggregate right when many people rate at once', async () => {
      const placeOwner = await signUp(app, 'owner');
      const placeId = await placeFor(placeOwner);
      const raters = await Promise.all(['rater1', 'rater2', 'rater3', 'rater4', 'rater5', 'rater6'].map((n) => signUp(app, n)));
      await Promise.all(
        raters.map((u, i) =>
          api().put(`/places/${placeId}/rating`).set(u.auth).send({ stars: (i % 5) + 1 }).expect(200),
        ),
      );
      const detail = await api().get(`/places/${placeId}`).set(placeOwner.auth).expect(200);
      // stars: 1,2,3,4,5,1 -> 16 / 6
      expect(detail.body.ratingCount).toBe(6);
      expect(detail.body.avgRating).toBeCloseTo(16 / 6, 2);
    });

    it('lists ratings newest first with a cursor and hides blocked people', async () => {
      const viewer = await signUp(app, 'viewer');
      const placeId = await placeFor(viewer);
      const names = ['user1', 'user2', 'user3', 'user4', 'user5'];
      const users = [];
      for (const n of names) {
        const u = await signUp(app, n);
        users.push(u);
        await api().put(`/places/${placeId}/rating`).set(u.auth).send({ stars: 4, comment: `by ${n}` }).expect(200);
      }

      const page1 = await api().get(`/places/${placeId}/ratings`).query({ limit: 2 }).set(viewer.auth).expect(200);
      expect(page1.body.items.map((r: any) => r.user.username)).toEqual(['user5', 'user4']);
      expect(page1.body.nextCursor).toEqual(expect.any(String));

      const page2 = await api()
        .get(`/places/${placeId}/ratings`)
        .query({ limit: 2, cursor: page1.body.nextCursor })
        .set(viewer.auth)
        .expect(200);
      expect(page2.body.items.map((r: any) => r.user.username)).toEqual(['user3', 'user2']);

      const page3 = await api()
        .get(`/places/${placeId}/ratings`)
        .query({ limit: 2, cursor: page2.body.nextCursor })
        .set(viewer.auth)
        .expect(200);
      expect(page3.body.items.map((r: any) => r.user.username)).toEqual(['user1']);
      expect(page3.body.nextCursor).toBeNull();

      // blocking u5 removes their rating from the viewer's list
      await api().post('/blocks').set(viewer.auth).send({ userId: users[4].id }).expect(204);
      const afterBlock = await api().get(`/places/${placeId}/ratings`).set(viewer.auth).expect(200);
      expect(afterBlock.body.items.map((r: any) => r.user.username)).toEqual(['user4', 'user3', 'user2', 'user1']);

      const bad = await api().get(`/places/${placeId}/ratings`).query({ cursor: 'garbage' }).set(viewer.auth).expect(400);
      expect(bad.body.error.code).toBe('invalid_cursor');
    });

    it('limits rating writes to 30 per hour', async () => {
      const alice = await signUp(app, 'alice');
      const placeId = await placeFor(alice);
      for (let i = 0; i < 30; i++) {
        await api().put(`/places/${placeId}/rating`).set(alice.auth).send({ stars: (i % 5) + 1 }).expect(200);
      }
      const res = await api().put(`/places/${placeId}/rating`).set(alice.auth).send({ stars: 3 }).expect(429);
      expect(res.body.error.code).toBe('rate_limited');
    });
  });

  describe('friends, search and blocks', () => {
    it('finds people by username prefix, never yourself, and needs 3 characters', async () => {
      const alice = await signUp(app, 'alice');
      await signUp(app, 'alicia');
      await signUp(app, 'bob_the_builder');

      const res = await api().get('/users/search').query({ q: 'ali' }).set(alice.auth).expect(200);
      expect(res.body.items.map((u: any) => u.username)).toEqual(['alicia']);
      expect(res.body.items[0]).toMatchObject({ friendStatus: 'none', avatar: null });

      await api().get('/users/search').query({ q: 'al' }).set(alice.auth).expect(400);
      await api().get('/users/search').set(alice.auth).expect(400);

      // % and _ are plain characters, not wildcards
      const wild = await api().get('/users/search').query({ q: '%%%' }).set(alice.auth).expect(200);
      expect(wild.body.items).toEqual([]);
      const underscore = await api().get('/users/search').query({ q: 'bob_' }).set(alice.auth).expect(200);
      expect(underscore.body.items.map((u: any) => u.username)).toEqual(['bob_the_builder']);
    });

    it('runs the request, accept and remove flow', async () => {
      const alice = await signUp(app, 'alice');
      const bob = await signUp(app, 'bobby');

      const sent = await api().post('/friends/requests').set(alice.auth).send({ userId: bob.id }).expect(200);
      expect(sent.body.status).toBe('pending');
      // asking twice is harmless
      const twice = await api().post('/friends/requests').set(alice.auth).send({ userId: bob.id }).expect(200);
      expect(twice.body.id).toBe(sent.body.id);

      const search = await api().get('/users/search').query({ q: 'bob' }).set(alice.auth).expect(200);
      expect(search.body.items[0].friendStatus).toBe('request_sent');
      const searchBack = await api().get('/users/search').query({ q: 'ali' }).set(bob.auth).expect(200);
      expect(searchBack.body.items[0].friendStatus).toBe('request_received');

      const bobView = await api().get('/friends').set(bob.auth).expect(200);
      expect(bobView.body.incoming).toHaveLength(1);
      expect(bobView.body.incoming[0].user.username).toBe('alice');
      const aliceView = await api().get('/friends').set(alice.auth).expect(200);
      expect(aliceView.body.outgoing).toHaveLength(1);

      // only the addressee can accept
      await api().post(`/friends/requests/${sent.body.id}/accept`).set(alice.auth).expect(404);
      await api().post(`/friends/requests/${sent.body.id}/accept`).set(bob.auth).expect(204);

      const friends = await api().get('/friends').set(alice.auth).expect(200);
      expect(friends.body.friends.map((f: any) => f.user.username)).toEqual(['bobby']);
      expect(friends.body.incoming).toEqual([]);

      await api().post('/friends/requests').set(alice.auth).send({ userId: bob.id }).expect(409);

      await api().delete(`/friends/${bob.id}`).set(alice.auth).expect(204);
      await api().delete(`/friends/${bob.id}`).set(alice.auth).expect(204);
      const after = await api().get('/friends').set(bob.auth).expect(200);
      expect(after.body.friends).toEqual([]);
    });

    it('turns two crossing requests into a friendship', async () => {
      const alice = await signUp(app, 'alice');
      const bob = await signUp(app, 'bobby');
      await api().post('/friends/requests').set(alice.auth).send({ userId: bob.id }).expect(200);
      const back = await api().post('/friends/requests').set(bob.auth).send({ userId: alice.id }).expect(200);
      expect(back.body.status).toBe('accepted');
      const list = await api().get('/friends').set(alice.auth).expect(200);
      expect(list.body.friends).toHaveLength(1);
    });

    it('refuses silly requests', async () => {
      const alice = await signUp(app, 'alice');
      await api().post('/friends/requests').set(alice.auth).send({ userId: alice.id }).expect(400);
      await api()
        .post('/friends/requests')
        .set(alice.auth)
        .send({ userId: '3f2504e0-4f89-41d3-9a0c-0305e82c3301' })
        .expect(404);
      await api().post('/friends/requests').set(alice.auth).send({ userId: 'nope' }).expect(400);
    });

    it('blocks end friendships, hide people from search and can be undone', async () => {
      const alice = await signUp(app, 'alice');
      const bob = await signUp(app, 'bobby');
      await befriend(app, alice, bob);

      await api().post('/blocks').set(alice.auth).send({ userId: bob.id }).expect(204);
      await api().post('/blocks').set(alice.auth).send({ userId: bob.id }).expect(204); // idempotent

      const friends = await api().get('/friends').set(alice.auth).expect(200);
      expect(friends.body.friends).toEqual([]);
      const blocked = await api().get('/blocks').set(alice.auth).expect(200);
      expect(blocked.body.items.map((u: any) => u.username)).toEqual(['bobby']);

      // neither side can find or add the other
      const s1 = await api().get('/users/search').query({ q: 'bob' }).set(alice.auth).expect(200);
      const s2 = await api().get('/users/search').query({ q: 'ali' }).set(bob.auth).expect(200);
      expect(s1.body.items).toEqual([]);
      expect(s2.body.items).toEqual([]);
      await api().post('/friends/requests').set(bob.auth).send({ userId: alice.id }).expect(404);

      await api().delete(`/blocks/${bob.id}`).set(alice.auth).expect(204);
      const s3 = await api().get('/users/search').query({ q: 'bob' }).set(alice.auth).expect(200);
      expect(s3.body.items).toHaveLength(1);
      // the friendship does not come back by itself
      const after = await api().get('/friends').set(alice.auth).expect(200);
      expect(after.body.friends).toEqual([]);
    });

    it('limits username searches to 60 per hour', async () => {
      const alice = await signUp(app, 'alice');
      for (let i = 0; i < 60; i++) {
        await api().get('/users/search').query({ q: 'zzz' }).set(alice.auth).expect(200);
      }
      const res = await api().get('/users/search').query({ q: 'zzz' }).set(alice.auth).expect(429);
      expect(res.body.error.code).toBe('rate_limited');
    });
  });

  describe('reports', () => {
    it('accepts reports about users and ratings', async () => {
      const alice = await signUp(app, 'alice');
      const bob = await signUp(app, 'bobby');
      const place = await api()
        .post('/places/resolve')
        .set(bob.auth)
        .send({ appleId: 'rp', name: 'Report Place', ...downtown })
        .expect(200);
      const rated = await api().put(`/places/${place.body.id}/rating`).set(bob.auth).send({ stars: 1, comment: 'rude' }).expect(200);

      const user = await api()
        .post('/reports')
        .set(alice.auth)
        .send({ targetType: 'user', targetId: bob.id, reason: 'abuse', details: 'harassing me' })
        .expect(201);
      expect(user.body.status).toBe('open');
      // avatars are drawn from fixed options now, so there is nothing to report separately
      await api().post('/reports').set(alice.auth).send({ targetType: 'avatar', targetId: bob.id, reason: 'inappropriate' }).expect(400);
      await api().post('/reports').set(alice.auth).send({ targetType: 'rating', targetId: rated.body.rating.id, reason: 'spam' }).expect(201);

      await api().post('/reports').set(alice.auth).send({ targetType: 'user', targetId: alice.id, reason: 'spam' }).expect(400);
      await api().post('/reports').set(bob.auth).send({ targetType: 'rating', targetId: rated.body.rating.id, reason: 'spam' }).expect(400);
      await api().post('/reports').set(alice.auth).send({ targetType: 'user', targetId: bob.id, reason: 'because' }).expect(400);
      await api().post('/reports').set(alice.auth).send({ targetType: 'rating', targetId: '3f2504e0-4f89-41d3-9a0c-0305e82c3301', reason: 'spam' }).expect(404);
    });
  });

  describe('deleting an account', () => {
    it('removes ratings, friendships and sessions, updates averages and frees the username', async () => {
      const alice = await signUp(app, 'alice');
      const bob = await signUp(app, 'bobby');
      await befriend(app, alice, bob);
      const place = await api()
        .post('/places/resolve')
        .set(alice.auth)
        .send({ appleId: 'del', name: 'Delete Place', ...downtown })
        .expect(200);
      await api().put(`/places/${place.body.id}/rating`).set(alice.auth).send({ stars: 5 }).expect(200);
      await api().put(`/places/${place.body.id}/rating`).set(bob.auth).send({ stars: 1 }).expect(200);

      await api().delete('/me').set(alice.auth).expect(204);

      // her token stops working at once, not when it expires
      await api().get('/me').set(alice.auth).expect(401);
      await api().post('/auth/refresh').send({ refreshToken: alice.refreshToken }).expect(401);

      const detail = await api().get(`/places/${place.body.id}`).set(bob.auth).expect(200);
      expect(detail.body).toMatchObject({ avgRating: 1, ratingCount: 1 });
      const friends = await api().get('/friends').set(bob.auth).expect(200);
      expect(friends.body.friends).toEqual([]);
      const search = await api().get('/users/search').query({ q: 'ali' }).set(bob.auth).expect(200);
      expect(search.body.items).toEqual([]);

      // the Apple account can sign up again as a brand-new person and reuse the name
      const again = await signUp(app, 'alice');
      expect(again.id).not.toBe(alice.id);
    });
  });
});
