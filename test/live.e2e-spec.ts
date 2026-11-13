import type { INestApplication } from '@nestjs/common';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { RedisService } from '../src/redis/redis.service.js';
import { LiveService } from '../src/live/live.service.js';
import { befriend, createTestApp, resetState, signUp, type TestUser } from './helpers.js';
import { here, LiveClient } from './live-client.js';

async function start(env: Record<string, string>) {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  const app = await createTestApp();
  await app.listen(0, '127.0.0.1');
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return { app, port: (app.getHttpServer().address() as AddressInfo).port };
}

describe('live location socket', () => {
  let app: INestApplication;
  let port: number;
  const api = () => request(app.getHttpServer());
  const open: LiveClient[] = [];

  async function connect(user: TestUser) {
    const { client, hello } = await LiveClient.connectReady(port, user.accessToken);
    open.push(client);
    return { client, hello };
  }
  const redisKey = (u: TestUser) => `loc:${u.id}`;

  beforeAll(async () => {
    ({ app, port } = await start({ LIVE_MIN_LOC_INTERVAL_MS: '0' }));
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(async () => {
    await resetState(app);
  });
  afterEach(async () => {
    await Promise.all(open.splice(0).map((c) => c.close()));
  });

  it('refuses the upgrade without a valid access token', async () => {
    await expect(LiveClient.connect(port, 'nonsense')).rejects.toThrow('HTTP 401');
    const raw = await import('ws');
    const noHeader = new raw.default(`ws://127.0.0.1:${port}/live`);
    const status = await new Promise((resolve) => {
      noHeader.once('unexpected-response', (_req, res) => resolve(res.statusCode));
      noHeader.once('error', () => undefined);
    });
    expect(status).toBe(401);
  });

  it('refuses the upgrade until a username is chosen', async () => {
    const signIn = await api()
      .post('/auth/apple')
      .send({ identityToken: 'fake-apple-token-for-newcomer' })
      .expect(200);
    await expect(LiveClient.connect(port, signIn.body.accessToken)).rejects.toThrow('HTTP 403');

    await api()
      .patch('/me')
      .set({ Authorization: `Bearer ${signIn.body.accessToken}` })
      .send({ username: 'newcomer' })
      .expect(200);
    const { client } = await LiveClient.connectReady(port, signIn.body.accessToken);
    open.push(client);
  });

  it('says hello with the ghost flag and the last known position of friends only', async () => {
    const alice = await signUp(app, 'alice');
    const bob = await signUp(app, 'bobby');
    const stranger = await signUp(app, 'stranger');
    await befriend(app, alice, bob);

    const b = await connect(bob);
    expect(b.hello).toMatchObject({ userId: bob.id, ghost: false, friends: [] });
    b.client.send('loc', here);
    await new Promise((r) => setTimeout(r, 150));

    const s = await connect(stranger);
    s.client.send('loc', { ...here, lat: 31 });
    await new Promise((r) => setTimeout(r, 150));

    const a = await connect(alice);
    expect(a.hello.friends).toEqual([
      expect.objectContaining({ userId: bob.id, lat: here.lat, lng: here.lng, accuracy: 12, heading: 90 }),
    ]);
  });

  it('pushes positions to friends only, keeps them in Redis for 60 s and nowhere else', async () => {
    const alice = await signUp(app, 'alice');
    const bob = await signUp(app, 'bobby');
    const stranger = await signUp(app, 'stranger');
    await befriend(app, alice, bob);
    const a = await connect(alice);
    const b = await connect(bob);
    const s = await connect(stranger);

    a.client.send('loc', here);
    const got = await b.client.next('loc');
    expect(got.d).toMatchObject({ userId: alice.id, lat: here.lat, lng: here.lng, accuracy: 12, heading: 90 });
    expect(got.d.ts).toBeGreaterThan(Date.now() - 5000);

    await s.client.expectNone('loc');
    await a.client.expectNone('loc'); // you do not get your own position back

    const redis = app.get(RedisService).client;
    const stored = JSON.parse((await redis.get(redisKey(alice)))!);
    expect(stored).toMatchObject({ lat: here.lat, lng: here.lng });
    const ttl = await redis.ttl(redisKey(alice));
    expect(ttl).toBeGreaterThan(50);
    expect(ttl).toBeLessThanOrEqual(60);

    // Postgres has no table that could hold it: only a person's profile and their ratings live there
    const tables: { table_name: string }[] = await app
      .get(DataSource)
      .query(`SELECT table_name FROM information_schema.columns WHERE column_name IN ('lat','lng','latitude','longitude') AND table_schema = 'public'`);
    expect(tables.map((t) => t.table_name)).not.toContain('users');
  });

  it('rejects bad positions with an error frame and treats heading -1 as unknown', async () => {
    const alice = await signUp(app, 'alice');
    const bob = await signUp(app, 'bobby');
    await befriend(app, alice, bob);
    const a = await connect(alice);
    const b = await connect(bob);

    a.client.send('loc', { ...here, lat: 91 });
    expect((await a.client.next('error')).d.code).toBe('invalid_loc');
    a.client.send('loc', { ...here, accuracy: 150 });
    expect((await a.client.next('error')).d.code).toBe('accuracy_too_low');
    a.client.send('loc', 'hello');
    expect((await a.client.next('error')).d.code).toBe('invalid_loc');
    await b.client.expectNone('loc');

    a.client.send('loc', { ...here, heading: -1 });
    expect((await b.client.next('loc')).d.heading).toBeNull();
  });

  it('ignores garbage frames and unknown messages without dropping the connection', async () => {
    const alice = await signUp(app, 'alice');
    const bob = await signUp(app, 'bobby');
    await befriend(app, alice, bob);
    const a = await connect(alice);
    const b = await connect(bob);

    a.client.ws.send('not json at all');
    a.client.ws.send(JSON.stringify({ nope: true }));
    a.client.send('teleport', { x: 1 });
    a.client.send('loc', here);
    expect((await b.client.next('loc')).d.userId).toBe(alice.id);
  });

  it('closes sockets that send oversized frames or flood the server', async () => {
    const alice = await signUp(app, 'alice');
    const big = await connect(alice);
    big.client.ws.send(JSON.stringify({ t: 'loc', d: { pad: 'x'.repeat(5000) } }));
    expect((await big.client.closed).code).toBe(1009);

    const bob = await signUp(app, 'bobby');
    const flood = await connect(bob);
    for (let i = 0; i < 80; i++) flood.client.send('loc', here);
    expect((await flood.client.closed).code).toBe(4429);
  });

  describe('ghost mode', () => {
    it('hides a person at once, stays on across reconnects and can be switched off', async () => {
      const alice = await signUp(app, 'alice');
      const bob = await signUp(app, 'bobby');
      await befriend(app, alice, bob);
      const a = await connect(alice);
      const b = await connect(bob);

      a.client.send('loc', here);
      await b.client.next('loc');

      a.client.send('ghost', { on: true });
      expect((await a.client.next('ghost')).d).toEqual({ on: true });
      expect((await b.client.next('gone')).d.userId).toBe(alice.id);
      expect(await app.get(RedisService).client.exists(redisKey(alice))).toBe(0);

      a.client.send('loc', { ...here, lat: 30.1 });
      await b.client.expectNone('loc');
      expect(await app.get(RedisService).client.exists(redisKey(alice))).toBe(0);

      // it is saved on the profile, so a new connection starts hidden
      const me = await api().get('/me').set(alice.auth).expect(200);
      expect(me.body.ghostMode).toBe(true);
      await a.client.close();
      const again = await connect(alice);
      expect(again.hello.ghost).toBe(true);

      again.client.send('ghost', { on: false });
      await again.client.next('ghost');
      again.client.send('loc', here);
      expect((await b.client.next('loc')).d.userId).toBe(alice.id);
    });

    it('also applies when switched from the REST API', async () => {
      const alice = await signUp(app, 'alice');
      const bob = await signUp(app, 'bobby');
      await befriend(app, alice, bob);
      const a = await connect(alice);
      const b = await connect(bob);
      a.client.send('loc', here);
      await b.client.next('loc');

      await api().patch('/me').set(alice.auth).send({ ghostMode: true }).expect(200);
      expect((await a.client.next('ghost')).d.on).toBe(true);
      expect((await b.client.next('gone')).d.userId).toBe(alice.id);
    });

    it('validates the message', async () => {
      const alice = await signUp(app, 'alice');
      const a = await connect(alice);
      a.client.send('ghost', { on: 'yes' });
      expect((await a.client.next('error')).d.code).toBe('invalid_ghost');
    });
  });

  describe('presence', () => {
    it('tells friends a person is gone when they disconnect and removes the stored position', async () => {
      const alice = await signUp(app, 'alice');
      const bob = await signUp(app, 'bobby');
      await befriend(app, alice, bob);
      const a = await connect(alice);
      const b = await connect(bob);
      a.client.send('loc', here);
      await b.client.next('loc');

      await a.client.close();
      expect((await b.client.next('gone')).d.userId).toBe(alice.id);
      expect(await app.get(RedisService).client.exists(redisKey(alice))).toBe(0);
    });

    it('keeps one connection per person: the newer one replaces the older', async () => {
      const alice = await signUp(app, 'alice');
      const bob = await signUp(app, 'bobby');
      await befriend(app, alice, bob);
      const b = await connect(bob);
      const first = await connect(alice);
      first.client.send('loc', here);
      await b.client.next('loc');

      const second = await connect(alice);
      expect((await first.client.closed).code).toBe(4409);
      await b.client.expectNone('gone'); // friends keep the last position; it was not a real disconnect

      second.client.send('loc', { ...here, lat: 30.2 });
      expect((await b.client.next('loc')).d.lat).toBe(30.2);
      expect(app.get(LiveService).connectionCount).toBe(2);
    });
  });

  describe('changes to friendships', () => {
    it('tells both open apps to reload their friends lists when a request is sent or cancelled', async () => {
      const alice = await signUp(app, 'alice');
      const bob = await signUp(app, 'bobby');
      const a = await connect(alice);
      const b = await connect(bob);

      await api().post('/friends/requests').set(alice.auth).send({ userId: bob.id }).expect(200);
      await b.client.next('friends');
      await a.client.next('friends');

      // alice changes her mind: bob's incoming request must disappear without a restart
      await api().delete(`/friends/${bob.id}`).set(alice.auth).expect(204);
      await b.client.next('friends');
      await a.client.next('friends');
      const list = await api().get('/friends').set(bob.auth).expect(200);
      expect(list.body.incoming).toEqual([]);
    });

    it('shows new friends their positions right away', async () => {
      const alice = await signUp(app, 'alice');
      const bob = await signUp(app, 'bobby');
      const a = await connect(alice);
      const b = await connect(bob);
      a.client.send('loc', here);
      b.client.send('loc', { ...here, lat: 30.3 });
      await new Promise((r) => setTimeout(r, 150));
      await a.client.expectNone('loc');

      await befriend(app, alice, bob);
      expect((await a.client.next('loc')).d).toMatchObject({ userId: bob.id, lat: 30.3 });
      expect((await b.client.next('loc')).d).toMatchObject({ userId: alice.id, lat: here.lat });
    });

    it('removes people from each other’s maps when they stop being friends', async () => {
      const alice = await signUp(app, 'alice');
      const bob = await signUp(app, 'bobby');
      await befriend(app, alice, bob);
      const a = await connect(alice);
      const b = await connect(bob);
      a.client.send('loc', here);
      await b.client.next('loc');

      await api().delete(`/friends/${bob.id}`).set(alice.auth).expect(204);
      expect((await a.client.next('gone')).d.userId).toBe(bob.id);
      expect((await b.client.next('gone')).d.userId).toBe(alice.id);

      a.client.send('loc', { ...here, lat: 30.4 });
      await b.client.expectNone('loc');
    });

    it('stops sharing when one blocks the other', async () => {
      const alice = await signUp(app, 'alice');
      const bob = await signUp(app, 'bobby');
      await befriend(app, alice, bob);
      const a = await connect(alice);
      const b = await connect(bob);
      b.client.send('loc', here);
      await a.client.next('loc');

      await api().post('/blocks').set(alice.auth).send({ userId: bob.id }).expect(204);
      expect((await a.client.next('gone')).d.userId).toBe(bob.id);
      expect((await b.client.next('gone')).d.userId).toBe(alice.id);
      b.client.send('loc', { ...here, lat: 30.5 });
      await a.client.expectNone('loc');
    });

    it('closes the socket and tells friends when an account is deleted', async () => {
      const alice = await signUp(app, 'alice');
      const bob = await signUp(app, 'bobby');
      await befriend(app, alice, bob);
      const a = await connect(alice);
      const b = await connect(bob);
      a.client.send('loc', here);
      await b.client.next('loc');

      await api().delete('/me').set(alice.auth).expect(204);
      expect((await a.client.closed).code).toBe(4403);
      expect((await b.client.next('gone')).d.userId).toBe(alice.id);
      expect(await app.get(RedisService).client.exists(redisKey(alice))).toBe(0);
    });
  });
});

describe('live location socket: throttling and dead connections', () => {
  let app: INestApplication;
  let port: number;
  const open: LiveClient[] = [];

  beforeAll(async () => {
    ({ app, port } = await start({ LIVE_MIN_LOC_INTERVAL_MS: '400', LIVE_PING_INTERVAL_MS: '150' }));
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(async () => {
    await resetState(app);
  });
  afterEach(async () => {
    await Promise.all(open.splice(0).map((c) => c.close()));
  });

  it('drops updates that come faster than the minimum interval', async () => {
    const alice = await signUp(app, 'alice');
    const bob = await signUp(app, 'bobby');
    await befriend(app, alice, bob);
    const a = await LiveClient.connectReady(port, alice.accessToken);
    const b = await LiveClient.connectReady(port, bob.accessToken);
    open.push(a.client, b.client);

    a.client.send('loc', { ...here, lat: 30.01 });
    a.client.send('loc', { ...here, lat: 30.02 }); // too soon: dropped
    expect((await b.client.next('loc')).d.lat).toBe(30.01);
    await b.client.expectNone('loc', () => true, 200);

    await new Promise((r) => setTimeout(r, 300));
    a.client.send('loc', { ...here, lat: 30.03 });
    expect((await b.client.next('loc')).d.lat).toBe(30.03);
  });

  it('closes a connection that stops answering pings and tells friends', async () => {
    const alice = await signUp(app, 'alice');
    const bob = await signUp(app, 'bobby');
    await befriend(app, alice, bob);
    const b = await LiveClient.connectReady(port, bob.accessToken);
    const a = await LiveClient.connectReady(port, alice.accessToken, { autoPong: false });
    open.push(a.client, b.client);

    a.client.send('loc', here);
    await b.client.next('loc');

    await a.client.closed; // terminated by the server after it missed a ping
    expect((await b.client.next('gone')).d.userId).toBe(alice.id);
  });
});
