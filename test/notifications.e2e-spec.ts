import type { INestApplication } from '@nestjs/common';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { RedisService } from '../src/redis/redis.service.js';
import { apns, befriend, createTestApp, resetState, signUp, type TestUser } from './helpers.js';
import { here, LiveClient } from './live-client.js';

const token = (n: number) => n.toString(16).padStart(2, '0').repeat(32);
const settle = () => new Promise((resolve) => setTimeout(resolve, 80));
/** Where the tests stand; `here` from the live tests also carries a heading, which REST refuses. */
const home = { lat: here.lat, lng: here.lng, accuracy: here.accuracy };
/** About 220 m north of `here`: inside the 500 m radius. */
const close = { lat: here.lat + 0.002, lng: here.lng, accuracy: 65 };
/** About 2.2 km north: outside it. */
const far = { lat: here.lat + 0.02, lng: here.lng, accuracy: 65 };

describe('push notifications', () => {
  let app: INestApplication;
  let port: number;
  const api = () => request(app.getHttpServer());
  const open: LiveClient[] = [];

  async function withDevice(name: string, n: number): Promise<TestUser & { device: string }> {
    const user = await signUp(app, name);
    await api().put(`/me/devices/${token(n)}`).set(user.auth).send({ environment: 'sandbox' }).expect(204);
    return { ...user, device: token(n) };
  }
  const alertsOn = (u: TestUser) => api().patch('/me').set(u.auth).send({ nearbyAlerts: true }).expect(200);
  const report = (u: TestUser, at: { lat: number; lng: number; accuracy: number }) =>
    api().post('/me/position').set(u.auth).send(at);
  /** Lets the next report run the nearby check again (it runs at most once a minute per person). */
  const allowCheck = (u: TestUser) => app.get(RedisService).client.del(`nearby-check:${u.id}`);

  beforeAll(async () => {
    process.env.LIVE_MIN_LOC_INTERVAL_MS = '0';
    app = await createTestApp();
    delete process.env.LIVE_MIN_LOC_INTERVAL_MS;
    await app.listen(0, '127.0.0.1');
    port = (app.getHttpServer().address() as AddressInfo).port;
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(async () => {
    await resetState(app);
    apns.reset();
  });
  afterEach(async () => {
    await Promise.all(open.splice(0).map((c) => c.close()));
  });

  describe('devices', () => {
    it('registers, moves a token to the account that signs in last, and unregisters', async () => {
      const a = await withDevice('pusha', 1);
      const b = await signUp(app, 'pushb');
      await api().put(`/me/devices/${token(1).toUpperCase()}`).set(b.auth).send({ environment: 'production' }).expect(204);

      const rows = await app.get(DataSource).query(`SELECT user_id, environment FROM push_devices`);
      expect(rows).toEqual([{ user_id: b.id, environment: 'production' }]);

      // someone else's token is left alone
      await api().delete(`/me/devices/${token(1)}`).set(a.auth).expect(204);
      expect(await app.get(DataSource).query(`SELECT 1 FROM push_devices`)).toHaveLength(1);
      await api().delete(`/me/devices/${token(1)}`).set(b.auth).expect(204);
      await api().delete(`/me/devices/${token(1)}`).set(b.auth).expect(204);
      expect(await app.get(DataSource).query(`SELECT 1 FROM push_devices`)).toHaveLength(0);
    });

    it('rejects malformed tokens and environments', async () => {
      const a = await signUp(app, 'pushc');
      const bad = await api().put('/me/devices/not-a-token').set(a.auth).send({ environment: 'sandbox' }).expect(400);
      expect(bad.body.error.code).toBe('invalid_device_token');
      await api().put(`/me/devices/${token(2)}`).set(a.auth).send({ environment: 'staging' }).expect(400);
      await api().put(`/me/devices/${token(2)}`).send({ environment: 'sandbox' }).expect(401);
    });

    it('forgets a token Apple says is dead', async () => {
      const a = await withDevice('pushd', 3);
      const b = await signUp(app, 'pushe');
      apns.dead.add(a.device);
      await api().post('/friends/requests').set(b.auth).send({ userId: a.id }).expect(200);
      await settle();
      expect(await app.get(DataSource).query(`SELECT 1 FROM push_devices`)).toHaveLength(0);
    });

    it('removes devices when the account is deleted', async () => {
      const a = await withDevice('pushf', 4);
      await api().delete('/me').set(a.auth).expect(204);
      expect(await app.get(DataSource).query(`SELECT 1 FROM push_devices`)).toHaveLength(0);
    });
  });

  describe('friend requests', () => {
    it('pushes the request to the addressee and the acceptance to the requester', async () => {
      const a = await withDevice('alice', 5);
      const b = await withDevice('bob', 6);
      await api().patch('/me').set(a.auth).send({ displayName: 'Alice A' }).expect(200);

      const sent = await api().post('/friends/requests').set(a.auth).send({ userId: b.id }).expect(200);
      await settle();
      const [request] = apns.to(b.device, 'friend-request');
      expect(request.payload).toEqual({
        aps: {
          alert: { 'title-loc-key': 'Friend request', 'loc-key': '%@ wants to be friends', 'loc-args': ['Alice A'] },
          sound: 'default',
          'thread-id': 'friends',
        },
        kind: 'friend-request',
        userId: a.id,
      });
      expect(apns.to(a.device)).toEqual([]);

      await api().post(`/friends/requests/${sent.body.id}/accept`).set(b.auth).expect(204);
      await settle();
      const [accepted] = apns.to(a.device, 'friend-accepted');
      expect(accepted.payload).toMatchObject({ kind: 'friend-accepted', userId: b.id });
      expect((accepted.payload.aps as any).alert['loc-args']).toEqual(['bob']);
    });

    it('pushes the acceptance when both people add each other', async () => {
      const a = await withDevice('carl', 7);
      const b = await withDevice('dina', 8);
      await api().post('/friends/requests').set(a.auth).send({ userId: b.id }).expect(200);
      await api().post('/friends/requests').set(b.auth).send({ userId: a.id }).expect(200);
      await settle();
      expect(apns.to(b.device, 'friend-request')).toHaveLength(1);
      expect(apns.to(a.device, 'friend-accepted')).toHaveLength(1);
      expect(apns.to(a.device, 'friend-request')).toHaveLength(0);
    });

    it('sends nothing while APNs is not configured', async () => {
      apns.enabled = false;
      const a = await withDevice('erin', 9);
      const b = await withDevice('fady', 10);
      await api().post('/friends/requests').set(a.auth).send({ userId: b.id }).expect(200);
      await settle();
      expect(apns.sent).toEqual([]);
    });
  });

  describe('nearby friends', () => {
    async function friendsWithAlerts() {
      const a = await withDevice('nina', 11);
      const b = await withDevice('omar', 12);
      await befriend(app, a, b);
      await alertsOn(a);
      await alertsOn(b);
      await settle();
      apns.reset();
      return { a, b };
    }

    it('reports nearbyAlerts on /me and refuses positions while it is off', async () => {
      const a = await signUp(app, 'pushg');
      expect((await api().get('/me').set(a.auth).expect(200)).body.nearbyAlerts).toBe(false);
      const off = await report(a, close).expect(409);
      expect(off.body.error.code).toBe('nearby_alerts_off');
      await alertsOn(a);
      await report(a, close).expect(204);
      const coarse = await report(a, { ...close, accuracy: 3000 }).expect(422);
      expect(coarse.body.error.code).toBe('accuracy_too_low');
      await report(a, { lat: 91, lng: 0, accuracy: 10 }).expect(400);
    });

    it('alerts both friends once when their background positions are close', async () => {
      const { a, b } = await friendsWithAlerts();
      await report(a, home).expect(204);
      await settle();
      expect(apns.sent).toEqual([]);

      await report(b, close).expect(204);
      await settle();
      expect(apns.to(a.device, 'nearby').map((m) => m.payload.userId)).toEqual([b.id]);
      expect(apns.to(b.device, 'nearby').map((m) => m.payload.userId)).toEqual([a.id]);
      expect(apns.to(a.device, 'nearby')[0].payload.aps).toMatchObject({ 'thread-id': 'nearby' });

      // the cooldown keeps the same pair quiet
      await allowCheck(b);
      await report(b, home).expect(204);
      await settle();
      expect(apns.sent).toHaveLength(2);
    });

    it('stores the background position coarsely and only for a while', async () => {
      const { a } = await friendsWithAlerts();
      await report(a, { lat: 30.044449, lng: 31.235712, accuracy: 30 }).expect(204);
      const redis = app.get(RedisService).client;
      expect(JSON.parse((await redis.get(`near:${a.id}`))!)).toMatchObject({ lat: 30.044, lng: 31.236 });
      const ttl = await redis.ttl(`near:${a.id}`);
      expect(ttl).toBeGreaterThan(1700);
      expect(ttl).toBeLessThanOrEqual(1800);
      const rows = await app.get(DataSource).query(`SELECT * FROM users WHERE id = $1`, [a.id]);
      expect(JSON.stringify(rows)).not.toContain('30.04');
    });

    it('stays quiet for friends who are far away', async () => {
      const { a, b } = await friendsWithAlerts();
      await report(a, home).expect(204);
      await report(b, far).expect(204);
      await settle();
      expect(apns.sent).toEqual([]);
    });

    it('only alerts the side that switched alerts on', async () => {
      const a = await withDevice('pia', 13);
      const b = await withDevice('quinn', 14);
      await befriend(app, a, b);
      await alertsOn(a);
      await settle();
      apns.reset();

      // b has the app open (live), a reports from the background
      const { client } = await LiveClient.connectReady(port, b.accessToken);
      open.push(client);
      client.send('loc', { ...here, ts: Date.now() });
      await settle();
      await report(a, close).expect(204);
      await settle();
      expect(apns.to(a.device, 'nearby').map((m) => m.payload.userId)).toEqual([b.id]);
      expect(apns.to(b.device)).toEqual([]);
    });

    it('ignores people in ghost mode, strangers and blocked friends', async () => {
      const { a, b } = await friendsWithAlerts();
      const stranger = await withDevice('rami', 15);
      await alertsOn(stranger);
      await report(stranger, home).expect(204);

      await api().patch('/me').set(b.auth).send({ ghostMode: true }).expect(200);
      await settle();
      await report(b, home).expect(204); // accepted but ignored
      expect(await app.get(RedisService).client.get(`near:${b.id}`)).toBeNull();
      await report(a, close).expect(204);
      await settle();
      expect(apns.sent).toEqual([]);

      await api().patch('/me').set(b.auth).send({ ghostMode: false }).expect(200);
      await api().post('/blocks').set(a.auth).send({ userId: b.id }).expect(204);
      await allowCheck(b);
      await report(b, home).expect(204);
      await allowCheck(a);
      await report(a, close).expect(204);
      await settle();
      expect(apns.sent).toEqual([]);
    });

    it('forgets the background position when alerts are switched off', async () => {
      const { a } = await friendsWithAlerts();
      await report(a, home).expect(204);
      await api().patch('/me').set(a.auth).send({ nearbyAlerts: false }).expect(200);
      await settle();
      expect(await app.get(RedisService).client.get(`near:${a.id}`)).toBeNull();
    });

    it('checks live positions from the socket too', async () => {
      const { a, b } = await friendsWithAlerts();
      await report(b, close).expect(204);
      const { client } = await LiveClient.connectReady(port, a.accessToken);
      open.push(client);
      client.send('loc', { ...here, ts: Date.now() });
      await settle();
      expect(apns.to(a.device, 'nearby')).toHaveLength(1);
      expect(apns.to(b.device, 'nearby')).toHaveLength(1);
    });
  });
});
