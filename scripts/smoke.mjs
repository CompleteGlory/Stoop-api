#!/usr/bin/env node
/**
 * Black-box check of a RUNNING Place Rating API: every REST route and the /live socket, with the
 * success cases and the failure cases (bad input, missing auth, rate limits, other people's data).
 *
 *   npm run start:dev                 # in one terminal (needs DEV_AUTH_ENABLED=true in .env)
 *   node scripts/smoke.mjs            # in another; or: node scripts/smoke.mjs http://localhost:3000
 *
 * It creates its own throw-away people (usernames start with "s<random>_") and places ("Smoke <random> ...")
 * and removes them again at the end, so it can be run as often as you like. A full run takes about
 * two minutes, most of it waiting out the server's 2 s limit on location updates and the ping timeout.
 * Options: --skip-slow   skip the slow checks: the dead-connection (ping timeout) check, ~45 s, and
 *                         the refresh-token grace window, ~31 s.
 * The result is printed and also written to scripts/smoke-report.txt.
 */
import { createHmac, randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import sharp from 'sharp';
import WebSocket from 'ws';

try {
  process.loadEnvFile(new URL('../.env', import.meta.url));
} catch {
  // no .env: only the defaults and command line are used
}

const args = process.argv.slice(2);
const SKIP_SLOW = args.includes('--skip-slow');
const BASE = (
  args.find((a) => !a.startsWith('--')) ??
  process.env.API_URL ??
  `http://localhost:${process.env.PORT ?? 3000}`
).replace(/\/+$/, '');
const WS_URL = BASE.replace(/^http/, 'ws') + '/live';
const MIN_LOC_MS = Number(process.env.LIVE_MIN_LOC_INTERVAL_MS ?? 2000);
const PING_MS = Number(process.env.LIVE_PING_INTERVAL_MS ?? 20000);
const RUN = randomBytes(3).toString('hex');
// Every check gets its own `scope`, so it works with brand-new people and places. Otherwise rate limits,
// friendships and ratings from earlier checks would leak into later ones (the e2e suite empties the database
// between tests; a live server cannot be emptied).
let scope = '00';
let scopeCounter = 0;
const nextScope = () => (++scopeCounter).toString(36).padStart(2, '0');
// usernames are 3-20 chars: "s" + run (6) + scope (2) + "_" leaves 10 for the name
const nm = (name) => `s${RUN}${scope}_${name}`;
const placeName = (tag) => `Smoke ${RUN} ${scope} ${tag}`;
const appleId = (tag) => `smoke-${RUN}${scope}-${tag}`;
const downtown = { latitude: 30.0444, longitude: 31.2357 };
const here = { lat: 30.0444, lng: 31.2357, accuracy: 12, heading: 90 };
const NO_SUCH_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- tiny test runner

const useColor = process.stdout.isTTY;
const paint = (code, s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
const lines = [];
const results = [];
let currentSection = '';

function out(text = '') {
  console.log(text);
  lines.push(text.replace(/\x1b\[[0-9;]*m/g, ''));
}
function section(title) {
  currentSection = title;
  out('');
  out(paint(1, title));
}
async function test(name, fn) {
  scope = nextScope();
  const started = Date.now();
  try {
    await fn();
    results.push({ section: currentSection, name, ok: true });
    out(`  ${paint(32, '✓')} ${name} ${paint(2, `(${Date.now() - started} ms)`)}`);
  } catch (err) {
    const message = err instanceof Failure ? err.message : `${err?.stack ?? err}`;
    results.push({ section: currentSection, name, ok: false, message });
    out(`  ${paint(31, '✗')} ${name}`);
    for (const l of message.split('\n')) out(`      ${paint(31, l)}`);
  }
}

class Failure extends Error {}
const fail = (message) => {
  throw new Failure(message);
};
const ok = (condition, message) => {
  if (!condition) fail(message);
};
const same = (actual, expected, label) => {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) fail(`${label}: expected ${e}, got ${a}`);
};
const near = (actual, expected, eps, label) => {
  if (typeof actual !== 'number' || Math.abs(actual - expected) > eps) {
    fail(`${label}: expected about ${expected}, got ${JSON.stringify(actual)}`);
  }
};
const status = (res, code, label = 'request') => {
  if (res.status !== code) fail(`${label}: expected HTTP ${code}, got ${res.status} ${JSON.stringify(res.body)}`);
  return res;
};
/** The API's error envelope: HTTP status plus `{ error: { code, message } }`. */
const failsWith = (res, httpStatus, code, label = 'request') => {
  status(res, httpStatus, label);
  const body = res.body?.error;
  ok(body && typeof body.message === 'string', `${label}: body is not the { error: { code, message } } envelope: ${JSON.stringify(res.body)}`);
  if (code) same(body.code, code, `${label}: error code`);
  return res;
};

// ---------------------------------------------------------------- HTTP helpers

async function call(method, path, { token, body, query, headers } = {}) {
  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, String(v));
  const res = await fetch(url, {
    method,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = text;
  }
  return { status: res.status, body: json, headers: res.headers };
}
const get = (path, token, query) => call('GET', path, { token, query });
const post = (path, token, body) => call('POST', path, { token, body });
const put = (path, token, body) => call('PUT', path, { token, body });
const patch = (path, token, body) => call('PATCH', path, { token, body });
const del = (path, token) => call('DELETE', path, { token });

const people = [];
/** Creates (or finds) an account through the development sign-in. */
async function signIn(name) {
  const res = status(await post('/auth/dev', undefined, { username: nm(name) }), 200, `dev sign-in as ${name}`);
  const person = {
    id: res.body.user.id,
    name,
    username: nm(name),
    token: res.body.accessToken,
    refresh: res.body.refreshToken,
  };
  people.push(person);
  return person;
}
async function befriend(a, b) {
  const sent = status(await post('/friends/requests', a.token, { userId: b.id }), 200, 'friend request');
  status(await post(`/friends/requests/${sent.body.id}/accept`, b.token), 204, 'accept');
}
async function placeFor(user, tag = 'p1', extra = {}) {
  const res = status(
    await post('/places/resolve', user.token, { appleId: appleId(tag), name: placeName(tag), ...downtown, ...extra }),
    200,
    'resolve place',
  );
  return res.body.id;
}

// ---------------------------------------------------------------- live socket helper

class Live {
  constructor(ws, person) {
    this.ws = ws;
    this.person = person;
    this.inbox = [];
    this.waiters = [];
    this.lastLocAt = 0;
    this.closed = new Promise((resolve) => ws.on('close', (code, reason) => resolve({ code, reason: reason.toString() })));
    ws.on('message', (data) => {
      const frame = JSON.parse(data.toString('utf8'));
      const waiter = this.waiters.find((w) => w.match(frame));
      if (waiter) {
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        waiter.resolve(frame);
      } else {
        this.inbox.push(frame);
      }
    });
  }

  static open(person, options = {}) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(WS_URL, { headers: { Authorization: `Bearer ${person.token}` }, ...options });
      const client = new Live(ws, person);
      ws.once('open', () => resolve(client));
      ws.once('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
      ws.once('error', reject);
    });
  }
  static async connect(person, options) {
    const client = await Live.open(person, options);
    const hello = await client.next('hello');
    return { client, hello: hello.d };
  }

  send(t, d) {
    this.ws.send(JSON.stringify({ t, d }));
  }
  /** Sends a position, first waiting out the server's minimum gap between two updates from one person. */
  async loc(payload = here) {
    const wait = this.lastLocAt + MIN_LOC_MS + 150 - Date.now();
    if (wait > 0) await sleep(wait);
    this.lastLocAt = Date.now();
    this.send('loc', payload);
  }
  next(t, where = () => true, timeoutMs = 4000) {
    const match = (f) => f.t === t && where(f.d);
    const queued = this.inbox.findIndex(match);
    if (queued >= 0) return Promise.resolve(this.inbox.splice(queued, 1)[0]);
    return new Promise((resolve, reject) => {
      const waiter = { match, resolve };
      this.waiters.push(waiter);
      setTimeout(() => {
        const i = this.waiters.indexOf(waiter);
        if (i >= 0) {
          this.waiters.splice(i, 1);
          reject(new Failure(`${this.person.name}: no "${t}" frame within ${timeoutMs} ms (inbox: ${JSON.stringify(this.inbox)})`));
        }
      }, timeoutMs);
    });
  }
  async expectNone(t, where = () => true, ms = 400) {
    await sleep(ms);
    const found = this.inbox.filter((f) => f.t === t && where(f.d));
    if (found.length) fail(`${this.person.name} should not have received "${t}" but got ${JSON.stringify(found)}`);
  }
  close() {
    if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) this.ws.close();
    return this.closed;
  }
}
const openSockets = [];
async function connect(person, options) {
  const result = await Live.connect(person, options);
  openSockets.push(result.client);
  return result;
}
async function closeSockets() {
  await Promise.all(openSockets.splice(0).map((c) => c.close().catch(() => undefined)));
}
async function liveTest(name, fn) {
  await test(name, async () => {
    try {
      await fn();
    } finally {
      await closeSockets();
    }
  });
}

// ---------------------------------------------------------------- optional direct access (extra checks and clean-up)

let redis = null;
async function openRedis() {
  try {
    const { default: Redis } = await import('ioredis');
    const client = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      retryStrategy: () => null,
    });
    client.on('error', () => undefined);
    await client.connect();
    await client.ping();
    return client;
  } catch {
    return null;
  }
}
/** Checks that need Redis run only when it can be reached with REDIS_URL from .env. */
async function withRedis(fn) {
  if (redis) await fn(redis);
}

// ---------------------------------------------------------------- the checks

async function preflight() {
  let health;
  try {
    health = await get('/health');
  } catch (err) {
    out(paint(31, `Cannot reach the API at ${BASE} (${err.cause?.code ?? err.message}). Start it with "npm run start:dev" first, or pass its URL.`));
    process.exit(2);
  }
  if (health.status !== 200) {
    out(paint(31, `GET /health answered ${health.status} ${JSON.stringify(health.body)}; Postgres or Redis is not reachable from the API.`));
    process.exit(2);
  }
  const probe = await post('/auth/dev', undefined, { username: nm('probe') });
  if (probe.status === 404) {
    out(paint(31, 'POST /auth/dev is closed. Set DEV_AUTH_ENABLED=true in .env (and restart the API) so this script can sign in without Apple.'));
    process.exit(2);
  }
  if (probe.status === 200) people.push({ id: probe.body.user.id, name: 'probe', username: nm('probe'), token: probe.body.accessToken });
}

async function healthAndErrors() {
  section('Health, auth guard and error format');

  await test('GET /health reports Postgres and Redis as up', async () => {
    const res = status(await get('/health'), 200);
    same(res.body, { status: 'ok', db: 'up', redis: 'up' }, 'body');
  });
  await test('no token -> 401 in the error envelope', async () => {
    failsWith(await get('/me'), 401, 'unauthorized');
  });
  await test('unknown route -> 404 not_found', async () => {
    failsWith(await get('/nope'), 404, 'not_found');
  });
  await test('garbage bearer token -> 401', async () => {
    failsWith(await get('/me', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.abc'), 401, 'unauthorized');
    failsWith(await get('/me', 'not-even-a-jwt'), 401, 'unauthorized');
  });
  await test('a correctly shaped token signed with another secret -> 401', async () => {
    const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const head = b64({ alg: 'HS256', typ: 'JWT' });
    const payload = b64({ sub: NO_SUCH_ID, iss: 'place-rating-api', exp: Math.floor(Date.now() / 1000) + 600 });
    const sig = createHmac('sha256', 'some-other-secret-some-other-secret-1234').update(`${head}.${payload}`).digest('base64url');
    failsWith(await get('/me', `${head}.${payload}.${sig}`), 401, 'unauthorized');
  });
  await test('wrong body type -> 400 validation_failed', async () => {
    failsWith(await post('/auth/apple', undefined, { identityToken: 1 }), 400, 'validation_failed');
  });
  await test('unknown properties are rejected, not ignored', async () => {
    const alice = await signIn('alice');
    failsWith(await patch('/me', alice.token, { isAdmin: true }), 400, 'validation_failed');
  });
}

async function authAndProfile() {
  section('Sign-in, tokens and profile');

  await test('dev sign-in creates the account, returns tokens, and signing in again finds the same one', async () => {
    const first = status(await post('/auth/dev', undefined, { username: nm('newbie') }), 200);
    ok(first.body.accessToken && first.body.refreshToken, 'missing tokens');
    same(first.body.expiresIn, 900, 'expiresIn');
    same(first.body.user.username, nm('newbie'), 'username');
    same(first.body.user.ghostMode, false, 'ghostMode');
    same(first.body.user.avatar, null, 'no character yet');
    people.push({ id: first.body.user.id, name: 'newbie', username: nm('newbie'), token: first.body.accessToken });
    const again = status(await post('/auth/dev', undefined, { username: nm('newbie') }), 200);
    same(again.body.user.id, first.body.user.id, 'same person');
  });
  await test('dev sign-in rejects bad usernames -> 400', async () => {
    failsWith(await post('/auth/dev', undefined, { username: 'a b!' }), 400, 'validation_failed');
    failsWith(await post('/auth/dev', undefined, { username: 'ab' }), 400, 'validation_failed');
    failsWith(await post('/auth/dev', undefined, {}), 400, 'validation_failed');
  });
  await test('Apple sign-in refuses a token that is not from Apple -> 401', async () => {
    const res = await post('/auth/apple', undefined, { identityToken: 'this-is-not-an-apple-identity-token' });
    failsWith(res, 401, undefined);
  });
  await test('Apple sign-in refuses a too-short token -> 400', async () => {
    failsWith(await post('/auth/apple', undefined, { identityToken: 'short' }), 400, 'validation_failed');
  });
  await test('GET /me returns the profile', async () => {
    const alice = await signIn('alice');
    const me = status(await get('/me', alice.token), 200);
    same(me.body.username, alice.username, 'username');
    same(me.body.id, alice.id, 'id');
  });
  await test('usernames: taken -> 409, invalid -> 400, reserved -> 422, valid change -> 200', async () => {
    const alice = await signIn('alice');
    const bob = await signIn('bobby');
    failsWith(await patch('/me', bob.token, { username: alice.username.toUpperCase() }), 409, 'username_taken');
    failsWith(await patch('/me', bob.token, { username: 'a b!' }), 400, 'validation_failed');
    failsWith(await patch('/me', bob.token, { username: 'ab' }), 400, 'validation_failed');
    failsWith(await patch('/me', bob.token, { username: 'admin' }), 422, 'username_reserved');
    const renamed = status(await patch('/me', bob.token, { username: nm('bobby2').toUpperCase() }), 200);
    same(renamed.body.username, nm('bobby2'), 'lower-cased username');
    bob.username = nm('bobby2');
  });
  await test('display name and ghost mode: valid -> 200, invalid -> 400', async () => {
    const alice = await signIn('alice');
    const named = status(await patch('/me', alice.token, { displayName: '  Alice A  ' }), 200);
    same(named.body.displayName, 'Alice A', 'trimmed display name');
    failsWith(await patch('/me', alice.token, { displayName: 'x'.repeat(41) }), 400, 'validation_failed');
    failsWith(await patch('/me', alice.token, { displayName: '' }), 400, 'validation_failed');
    same(status(await patch('/me', alice.token, { ghostMode: true }), 200).body.ghostMode, true, 'ghost on');
    same(status(await patch('/me', alice.token, { ghostMode: false }), 200).body.ghostMode, false, 'ghost off');
    failsWith(await patch('/me', alice.token, { ghostMode: 'yes' }), 400, 'validation_failed');
  });
  await test('DiceBear characters: real options -> 200, anything else -> 400 invalid_avatar', async () => {
    const alice = await signIn('alice');
    const character = { style: 'avataaars', options: { top: 'shortFlat', hairColor: '111111', facialHair: 'none' } };
    same(status(await patch('/me', alice.token, { avatar: character }), 200).body.avatar, character, 'avatar');
    failsWith(await patch('/me', alice.token, { avatar: { style: 'identicon', options: {} } }), 400, 'invalid_avatar', 'not a character style');
    failsWith(await patch('/me', alice.token, { avatar: { style: 'avataaars', options: { top: 'dragonHair' } } }), 400, 'invalid_avatar', 'unknown value');
    failsWith(await patch('/me', alice.token, { avatar: { style: 'avataaars', options: { wings: 'big' } } }), 400, 'invalid_avatar', 'unknown option');
    failsWith(await patch('/me', alice.token, { avatarPreset: 'owl' }), 400, 'validation_failed', 'old preset field');
  });
  await test('refresh tokens rotate; a retry within 30 s (lost response) still works', async () => {
    const alice = await signIn('alice');
    const first = status(await post('/auth/refresh', undefined, { refreshToken: alice.refresh }), 200);
    ok(first.body.refreshToken !== alice.refresh, 'refresh token was not rotated');
    status(await get('/me', first.body.accessToken), 200, 'new access token works');
    const retry = status(await post('/auth/refresh', undefined, { refreshToken: alice.refresh }), 200, 'retry within the grace window');
    status(await post('/auth/refresh', undefined, { refreshToken: retry.body.refreshToken }), 200, 'newest token keeps working');
  });
  if (SKIP_SLOW) {
    out('  - skipped: replaying a refresh token after the 30 s grace window revokes the session (--skip-slow)');
  } else {
    await test('replaying an old refresh token after the 30 s grace window revokes the whole session family', async () => {
      const alice = await signIn('alice');
      const next = status(await post('/auth/refresh', undefined, { refreshToken: alice.refresh }), 200);
      await new Promise((resolve) => setTimeout(resolve, 31_000));
      failsWith(await post('/auth/refresh', undefined, { refreshToken: alice.refresh }), 401, undefined, 'replay of old token');
      failsWith(await post('/auth/refresh', undefined, { refreshToken: next.body.refreshToken }), 401, undefined, 'family revoked');
    });
  }
  await test('refresh with an unknown token -> 401, with a malformed one -> 400', async () => {
    failsWith(await post('/auth/refresh', undefined, { refreshToken: randomBytes(32).toString('base64url') }), 401, undefined);
    failsWith(await post('/auth/refresh', undefined, { refreshToken: 'short' }), 400, 'validation_failed');
    failsWith(await post('/auth/refresh', undefined, {}), 400, 'validation_failed');
  });
  await test('logout revokes the refresh token', async () => {
    const alice = await signIn('alice');
    status(await post('/auth/logout', undefined, { refreshToken: alice.refresh }), 204);
    failsWith(await post('/auth/refresh', undefined, { refreshToken: alice.refresh }), 401, undefined);
  });
}

async function places() {
  section('Places');

  await test('the same Apple place resolves to one row and clients cannot rename it', async () => {
    const alice = await signIn('alice');
    const body = { appleId: appleId('cafe'), name: placeName('Cafe Riche'), category: 'Cafe', ...downtown };
    const a = status(await post('/places/resolve', alice.token, body), 200);
    const b = status(await post('/places/resolve', alice.token, { ...body, name: 'Renamed By A Client', latitude: 31 }), 200);
    same(b.body.id, a.body.id, 'same place id');
    same(b.body.name, placeName('Cafe Riche'), 'name stays');
    same(a.body.ratingCount, 0, 'ratingCount');
    same(a.body.avgRating, 0, 'avgRating');
    same(a.body.appleId, body.appleId, 'appleId');
    near(a.body.latitude, downtown.latitude, 1e-5, 'latitude');
    near(a.body.longitude, downtown.longitude, 1e-5, 'longitude');
  });
  await test('places without an Apple id merge when the name matches and they are within 30 m', async () => {
    const alice = await signIn('alice');
    const make = async (name, dLat = 0) =>
      status(await post('/places/resolve', alice.token, { name, latitude: downtown.latitude + dLat, longitude: downtown.longitude }), 200).body;
    const base = await make(placeName('Corner Shop'));
    const close = await make(placeName('corner shop'), 0.0001); // ~11 m
    const far = await make(placeName('Corner Shop'), 0.01); // ~1.1 km
    const other = await make(placeName('Other Shop'));
    same(close.id, base.id, 'within 30 m with the same name');
    ok(far.id !== base.id, 'a place 1 km away must be a new row');
    ok(other.id !== base.id, 'a different name must be a new row');
  });
  await test('resolve validates its input -> 400', async () => {
    const alice = await signIn('alice');
    failsWith(await post('/places/resolve', alice.token, { name: '', ...downtown }), 400, 'validation_failed');
    failsWith(await post('/places/resolve', alice.token, { name: 'x', latitude: 95, longitude: 0 }), 400, 'validation_failed');
    failsWith(await post('/places/resolve', alice.token, { name: 'x', latitude: 0, longitude: 190 }), 400, 'validation_failed');
    failsWith(await post('/places/resolve', alice.token, { name: 'x' }), 400, 'validation_failed');
    failsWith(await post('/places/resolve', alice.token, { name: 'x'.repeat(121), ...downtown }), 400, 'validation_failed');
    failsWith(await post('/places/resolve', undefined, { name: 'x', ...downtown }), 401, 'unauthorized');
  });
  await test('GET /places returns only places inside the bounding box', async () => {
    const alice = await signIn('alice');
    const resolve = async (tag, latitude, longitude) =>
      status(await post('/places/resolve', alice.token, { appleId: appleId(`bbox-${tag}`), name: placeName(`bbox ${tag}`), latitude, longitude }), 200);
    await resolve('cairo', 30.05, 31.23);
    await resolve('giza', 30.01, 31.21);
    await resolve('london', 51.5, -0.12);
    const res = status(await get('/places', alice.token, { bbox: '30.9,29.9,31.5,30.2' }), 200);
    const mine = res.body.items.map((p) => p.appleId).filter((id) => id?.startsWith(appleId('bbox-'))).sort();
    same(mine, [appleId('bbox-cairo'), appleId('bbox-giza')], 'places in the box');
  });
  await test('GET /places rejects a missing or malformed bbox -> 400 invalid_bbox', async () => {
    const alice = await signIn('alice');
    for (const bbox of ['', 'a,b,c,d', '1,2,3', '31,30,30,31', '0,0,40,40', '-200,0,0,10']) {
      failsWith(await get('/places', alice.token, { bbox }), 400, 'invalid_bbox', `bbox "${bbox}"`);
    }
    failsWith(await get('/places', alice.token), 400, 'invalid_bbox', 'no bbox');
  });
  await test('unknown place -> 404, malformed id -> 400 invalid_id, no token -> 401', async () => {
    const alice = await signIn('alice');
    failsWith(await get(`/places/${NO_SUCH_ID}`, alice.token), 404, 'not_found');
    failsWith(await get('/places/not-a-uuid', alice.token), 400, 'invalid_id');
    failsWith(await get(`/places/${NO_SUCH_ID}`), 401, 'unauthorized');
  });
}

async function ratings() {
  section('Ratings');

  await test('everyone’s ratings are averaged and each person has one rating (idempotent)', async () => {
    const alice = await signIn('alice');
    const bob = await signIn('bobby');
    const placeId = await placeFor(alice);
    const rate = (u, stars, comment) => put(`/places/${placeId}/rating`, u.token, { stars, comment });

    const first = status(await rate(alice, 5, 'Great coffee'), 200);
    near(first.body.place.avgRating, 5, 1e-9, 'avg after first');
    same(first.body.place.ratingCount, 1, 'count after first');
    same(first.body.rating.comment, 'Great coffee', 'comment');

    const again = status(await rate(alice, 5, 'Great coffee'), 200);
    same(again.body.rating.id, first.body.rating.id, 'same rating row');
    same(again.body.rating.updatedAt, first.body.rating.updatedAt, 'timestamp untouched by an identical write');
    same(again.body.place.ratingCount, 1, 'count after repeat');

    const second = status(await rate(bob, 2), 200);
    near(second.body.place.avgRating, 3.5, 1e-9, 'avg of 5 and 2');
    same(second.body.place.ratingCount, 2, 'count');

    const changed = status(await rate(alice, 3, null), 200);
    near(changed.body.place.avgRating, 2.5, 1e-9, 'avg of 3 and 2');
    same(changed.body.place.ratingCount, 2, 'count after change');
    same(changed.body.rating.comment, null, 'comment cleared');

    const detail = status(await get(`/places/${placeId}`, alice.token), 200);
    near(detail.body.avgRating, 2.5, 1e-9, 'detail avg');
    same(detail.body.myRating.stars, 3, 'myRating');
  });
  await test('stars and comment are validated; unknown place -> 404', async () => {
    const alice = await signIn('alice');
    const placeId = await placeFor(alice);
    const rate = (body) => put(`/places/${placeId}/rating`, alice.token, body);
    for (const stars of [0, 6, 3.5, '4', null]) failsWith(await rate({ stars }), 400, 'validation_failed', `stars ${JSON.stringify(stars)}`);
    failsWith(await rate({}), 400, 'validation_failed', 'no stars');
    failsWith(await rate({ stars: 4, comment: 'x'.repeat(281) }), 400, 'validation_failed', '281-char comment');
    status(await rate({ stars: 4, comment: 'x'.repeat(280) }), 200, '280-char comment');
    failsWith(await put(`/places/${NO_SUCH_ID}/rating`, alice.token, { stars: 4 }), 404, 'not_found');
    failsWith(await put('/places/nope/rating', alice.token, { stars: 4 }), 400, 'invalid_id');
    failsWith(await put(`/places/${placeId}/rating`, undefined, { stars: 4 }), 401, 'unauthorized');
  });
  await test('deleting a rating is idempotent and updates the average', async () => {
    const alice = await signIn('alice');
    const bob = await signIn('bobby');
    const placeId = await placeFor(alice);
    status(await put(`/places/${placeId}/rating`, alice.token, { stars: 5 }), 200);
    status(await put(`/places/${placeId}/rating`, bob.token, { stars: 1 }), 200);
    status(await del(`/places/${placeId}/rating`, alice.token), 204);
    status(await del(`/places/${placeId}/rating`, alice.token), 204, 'second delete');
    let detail = status(await get(`/places/${placeId}`, bob.token), 200).body;
    near(detail.avgRating, 1, 1e-9, 'avg');
    same(detail.ratingCount, 1, 'count');
    status(await del(`/places/${placeId}/rating`, bob.token), 204);
    detail = status(await get(`/places/${placeId}`, bob.token), 200).body;
    same(detail.ratingCount, 0, 'count when empty');
    same(detail.avgRating, 0, 'avg when empty');
    same(detail.myRating, null, 'myRating when empty');
  });
  await test('the average stays right when six people rate at the same moment', async () => {
    const owner = await signIn('owner');
    const placeId = await placeFor(owner);
    const raters = await Promise.all(['rater1', 'rater2', 'rater3', 'rater4', 'rater5', 'rater6'].map(signIn));
    const answers = await Promise.all(raters.map((u, i) => put(`/places/${placeId}/rating`, u.token, { stars: (i % 5) + 1 })));
    for (const a of answers) status(a, 200);
    const detail = status(await get(`/places/${placeId}`, owner.token), 200).body;
    same(detail.ratingCount, 6, 'count'); // stars 1,2,3,4,5,1
    near(detail.avgRating, 16 / 6, 0.01, 'average');
  });
  await test('ratings list: newest first, cursor pages, blocked people hidden, bad cursor -> 400', async () => {
    const viewer = await signIn('viewer');
    const placeId = await placeFor(viewer);
    const users = [];
    for (const n of ['user1', 'user2', 'user3', 'user4', 'user5']) {
      const u = await signIn(n);
      users.push(u);
      status(await put(`/places/${placeId}/rating`, u.token, { stars: 4, comment: `by ${n}` }), 200);
      await sleep(15);
    }
    const names = (res) => res.body.items.map((r) => r.user.username);
    const page1 = status(await get(`/places/${placeId}/ratings`, viewer.token, { limit: 2 }), 200);
    same(names(page1), [nm('user5'), nm('user4')], 'page 1');
    ok(typeof page1.body.nextCursor === 'string', 'page 1 must have a cursor');
    const page2 = status(await get(`/places/${placeId}/ratings`, viewer.token, { limit: 2, cursor: page1.body.nextCursor }), 200);
    same(names(page2), [nm('user3'), nm('user2')], 'page 2');
    const page3 = status(await get(`/places/${placeId}/ratings`, viewer.token, { limit: 2, cursor: page2.body.nextCursor }), 200);
    same(names(page3), [nm('user1')], 'page 3');
    same(page3.body.nextCursor, null, 'last page cursor');

    status(await post('/blocks', viewer.token, { userId: users[4].id }), 204);
    const after = status(await get(`/places/${placeId}/ratings`, viewer.token), 200);
    same(names(after), [nm('user4'), nm('user3'), nm('user2'), nm('user1')], 'without the blocked person');
    failsWith(await get(`/places/${placeId}/ratings`, viewer.token, { cursor: 'garbage' }), 400, 'invalid_cursor');
  });
  await test('rating writes are limited to 30 per hour -> 429 rate_limited', async () => {
    const alice = await signIn('alice');
    const placeId = await placeFor(alice);
    for (let i = 0; i < 30; i++) status(await put(`/places/${placeId}/rating`, alice.token, { stars: (i % 5) + 1 }), 200, `write ${i + 1}`);
    failsWith(await put(`/places/${placeId}/rating`, alice.token, { stars: 3 }), 429, 'rate_limited', 'write 31');
  });
}

async function social() {
  section('Search, friends and blocks');

  await test('search finds people by username prefix (3+ chars), never yourself; % and _ are literal', async () => {
    const alice = await signIn('alice');
    await signIn('alicia');
    await signIn('bob_bldr');
    await signIn('bobxbldr');

    const res = status(await get('/users/search', alice.token, { q: nm('ali') }), 200);
    same(res.body.items.map((u) => u.username), [nm('alicia')], 'matches (alice herself excluded)');
    same(res.body.items[0].friendStatus, 'none', 'friendStatus');
    ok('avatar' in res.body.items[0], 'avatar field');

    failsWith(await get('/users/search', alice.token, { q: 'al' }), 400, 'validation_failed', 'two characters');
    failsWith(await get('/users/search', alice.token), 400, 'validation_failed', 'no q');
    failsWith(await get('/users/search', undefined, { q: 'alice' }), 401, 'unauthorized', 'no token');

    same(status(await get('/users/search', alice.token, { q: '%%%' }), 200).body.items, [], '%%% is not a wildcard');
    const underscore = status(await get('/users/search', alice.token, { q: nm('bob_') }), 200);
    same(underscore.body.items.map((u) => u.username), [nm('bob_bldr')], '"_" is not a wildcard');
  });
  await test('request -> pending -> accept -> remove, with the right friendStatus along the way', async () => {
    const alice = await signIn('alice');
    const bob = await signIn('bobby');

    const sent = status(await post('/friends/requests', alice.token, { userId: bob.id }), 200);
    same(sent.body.status, 'pending', 'status');
    const twice = status(await post('/friends/requests', alice.token, { userId: bob.id }), 200, 'asking twice');
    same(twice.body.id, sent.body.id, 'same request');

    same(status(await get('/users/search', alice.token, { q: nm('bob') }), 200).body.items[0].friendStatus, 'request_sent', 'seen by alice');
    same(status(await get('/users/search', bob.token, { q: nm('ali') }), 200).body.items[0].friendStatus, 'request_received', 'seen by bobby');

    const bobView = status(await get('/friends', bob.token), 200).body;
    same(bobView.incoming.length, 1, 'bobby has one incoming');
    same(bobView.incoming[0].user.username, alice.username, 'from alice');
    same(status(await get('/friends', alice.token), 200).body.outgoing.length, 1, 'alice has one outgoing');

    failsWith(await post(`/friends/requests/${sent.body.id}/accept`, alice.token), 404, 'not_found', 'sender cannot accept');
    status(await post(`/friends/requests/${sent.body.id}/accept`, bob.token), 204, 'addressee accepts');

    const friends = status(await get('/friends', alice.token), 200).body;
    same(friends.friends.map((f) => f.user.username), [bob.username], 'friends');
    same(friends.incoming, [], 'no more incoming');
    failsWith(await post('/friends/requests', alice.token, { userId: bob.id }), 409, undefined, 'already friends');

    status(await del(`/friends/${bob.id}`, alice.token), 204);
    status(await del(`/friends/${bob.id}`, alice.token), 204, 'second removal');
    same(status(await get('/friends', bob.token), 200).body.friends, [], 'bobby has no friends left');
  });
  await test('two crossing requests become a friendship', async () => {
    const alice = await signIn('alice');
    const bob = await signIn('bobby');
    status(await post('/friends/requests', alice.token, { userId: bob.id }), 200);
    const back = status(await post('/friends/requests', bob.token, { userId: alice.id }), 200);
    same(back.body.status, 'accepted', 'status');
    same(status(await get('/friends', alice.token), 200).body.friends.length, 1, 'friends');
  });
  await test('a declined request can be cancelled by either side', async () => {
    const alice = await signIn('alice');
    const bob = await signIn('bobby');
    status(await post('/friends/requests', alice.token, { userId: bob.id }), 200);
    status(await del(`/friends/${alice.id}`, bob.token), 204, 'bobby declines');
    const view = status(await get('/friends', bob.token), 200).body;
    same(view.incoming, [], 'nothing incoming after declining');
  });
  await test('silly requests: yourself -> 400, unknown person -> 404, bad id -> 400, no token -> 401', async () => {
    const alice = await signIn('alice');
    failsWith(await post('/friends/requests', alice.token, { userId: alice.id }), 400, undefined, 'yourself');
    failsWith(await post('/friends/requests', alice.token, { userId: NO_SUCH_ID }), 404, 'not_found', 'unknown person');
    failsWith(await post('/friends/requests', alice.token, { userId: 'nope' }), 400, 'validation_failed', 'bad id');
    failsWith(await post('/friends/requests', undefined, { userId: NO_SUCH_ID }), 401, 'unauthorized', 'no token');
    failsWith(await post(`/friends/requests/${NO_SUCH_ID}/accept`, alice.token), 404, 'not_found', 'unknown request');
  });
  await test('blocking ends the friendship, hides both people from search, and can be undone', async () => {
    const alice = await signIn('alice');
    const bob = await signIn('bobby');
    await befriend(alice, bob);

    status(await post('/blocks', alice.token, { userId: bob.id }), 204);
    status(await post('/blocks', alice.token, { userId: bob.id }), 204, 'blocking twice');
    same(status(await get('/friends', alice.token), 200).body.friends, [], 'friendship gone');
    same(status(await get('/blocks', alice.token), 200).body.items.map((u) => u.username), [bob.username], 'block list');

    same(status(await get('/users/search', alice.token, { q: nm('bob') }), 200).body.items, [], 'alice cannot find bobby');
    same(status(await get('/users/search', bob.token, { q: nm('ali') }), 200).body.items, [], 'bobby cannot find alice');
    failsWith(await post('/friends/requests', bob.token, { userId: alice.id }), 404, 'not_found', 'bobby cannot add alice');
    failsWith(await post('/blocks', alice.token, { userId: alice.id }), 400, undefined, 'blocking yourself');
    failsWith(await post('/blocks', alice.token, { userId: NO_SUCH_ID }), 404, 'not_found', 'blocking nobody');

    status(await del(`/blocks/${bob.id}`, alice.token), 204);
    same(status(await get('/users/search', alice.token, { q: nm('bob') }), 200).body.items.length, 1, 'findable again');
    same(status(await get('/friends', alice.token), 200).body.friends, [], 'friendship does not come back by itself');
  });
  await test('username searches are limited to 60 per hour -> 429 rate_limited', async () => {
    const alice = await signIn('alice');
    for (let i = 0; i < 60; i++) status(await get('/users/search', alice.token, { q: 'zzz' }), 200, `search ${i + 1}`);
    failsWith(await get('/users/search', alice.token, { q: 'zzz' }), 429, 'rate_limited', 'search 61');
  });
  await test('friend requests are limited to 20 per day -> 429 rate_limited', async () => {
    const alice = await signIn('alice');
    const targets = [];
    for (let i = 0; i < 21; i++) targets.push(await signIn(`t${i}`));
    for (let i = 0; i < 20; i++) status(await post('/friends/requests', alice.token, { userId: targets[i].id }), 200, `request ${i + 1}`);
    failsWith(await post('/friends/requests', alice.token, { userId: targets[20].id }), 429, 'rate_limited', 'request 21');
  });
}

async function reports() {
  section('Reports');

  await test('reports about users and ratings are stored as open', async () => {
    const alice = await signIn('alice');
    const bob = await signIn('bobby');
    const placeId = await placeFor(bob, 'report');
    const rated = status(await put(`/places/${placeId}/rating`, bob.token, { stars: 1, comment: 'rude' }), 200);

    const user = status(await post('/reports', alice.token, { targetType: 'user', targetId: bob.id, reason: 'abuse', details: 'harassing me' }), 201);
    same(user.body.status, 'open', 'status');
    failsWith(await post('/reports', alice.token, { targetType: 'avatar', targetId: bob.id, reason: 'inappropriate' }), 400, 'validation_failed', 'avatar reports are gone');
    status(await post('/reports', alice.token, { targetType: 'rating', targetId: rated.body.rating.id, reason: 'spam' }), 201, 'rating report');
  });
  await test('reports about yourself, your own rating, an unknown rating or with bad fields are refused', async () => {
    const alice = await signIn('alice');
    const bob = await signIn('bobby');
    const placeId = await placeFor(bob, 'report2');
    const rated = status(await put(`/places/${placeId}/rating`, bob.token, { stars: 1 }), 200);

    failsWith(await post('/reports', alice.token, { targetType: 'user', targetId: alice.id, reason: 'spam' }), 400, undefined, 'yourself');
    failsWith(await post('/reports', bob.token, { targetType: 'rating', targetId: rated.body.rating.id, reason: 'spam' }), 400, undefined, 'own rating');
    failsWith(await post('/reports', alice.token, { targetType: 'user', targetId: bob.id, reason: 'because' }), 400, 'validation_failed', 'unknown reason');
    failsWith(await post('/reports', alice.token, { targetType: 'comment', targetId: bob.id, reason: 'spam' }), 400, 'validation_failed', 'unknown target type');
    failsWith(await post('/reports', alice.token, { targetType: 'user', targetId: bob.id, reason: 'spam', details: 'x'.repeat(501) }), 400, 'validation_failed', 'long details');
    failsWith(await post('/reports', alice.token, { targetType: 'rating', targetId: NO_SUCH_ID, reason: 'spam' }), 404, 'not_found', 'unknown rating');
    failsWith(await post('/reports', undefined, { targetType: 'user', targetId: bob.id, reason: 'spam' }), 401, 'unauthorized', 'no token');
  });
  await test('reports are limited to 20 per day -> 429 rate_limited', async () => {
    const alice = await signIn('alice');
    const bob = await signIn('bobby');
    for (let i = 0; i < 20; i++) status(await post('/reports', alice.token, { targetType: 'user', targetId: bob.id, reason: 'spam' }), 201, `report ${i + 1}`);
    failsWith(await post('/reports', alice.token, { targetType: 'user', targetId: bob.id, reason: 'spam' }), 429, 'rate_limited', 'report 21');
  });
}

async function photos() {
  section('Place photos (presigned S3 upload)');

  const picture = async (width, height, format = 'jpeg') => {
    const image = sharp({ create: { width, height, channels: 3, background: { r: 200, g: 40, b: 90 } } });
    return format === 'jpeg' ? image.jpeg().withExif({ IFD0: { Make: 'SecretCam' } }).toBuffer() : image.png().toBuffer();
  };
  const upload = async (user, placeId, bytes, contentType = 'image/jpeg') => {
    const presign = status(await post(`/places/${placeId}/photos/upload-url`, user.token, { contentType, contentLength: bytes.length }), 200, 'upload-url');
    const stored = await fetch(presign.body.uploadUrl, {
      method: presign.body.method,
      headers: presign.body.headers,
      body: new Uint8Array(bytes),
      signal: AbortSignal.timeout(20_000),
    });
    if (stored.status !== 200) fail(`PUT to the bucket answered ${stored.status}: ${await stored.text()}`);
    return presign.body.key;
  };
  const gone = async (url) => {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    return res.status === 404 || res.status === 403;
  };

  await test('upload -> create re-encodes to at most 1600 px plus a 400 px thumbnail, without metadata', async () => {
    const alice = await signIn('alice');
    const placeId = await placeFor(alice, 'photos');
    const original = await picture(2400, 1200);
    ok((await sharp(original).metadata()).exif !== undefined, 'test photo should carry EXIF');

    const key = await upload(alice, placeId, original);
    ok(key.startsWith(`uploads/${alice.id}/`), `unexpected key ${key}`);
    const photo = status(await post(`/places/${placeId}/photos`, alice.token, { kind: 'menu', key }), 201, 'create').body;
    same([photo.kind, photo.width, photo.height], ['menu', 1600, 800], 'kind and size');

    const served = await fetch(photo.url, { signal: AbortSignal.timeout(10_000) });
    same(served.status, 200, 'GET photo url');
    same(served.headers.get('content-type'), 'image/jpeg', 'content-type');
    const meta = await sharp(Buffer.from(await served.arrayBuffer())).metadata();
    same([meta.format, meta.width, meta.height], ['jpeg', 1600, 800], 'format and size');
    ok(meta.exif === undefined, 'EXIF metadata survived the re-encode');
    const thumb = await sharp(Buffer.from(await (await fetch(photo.thumbnailUrl)).arrayBuffer())).metadata();
    same([thumb.width, thumb.height], [400, 400], 'thumbnail size');

    failsWith(await post(`/places/${placeId}/photos`, alice.token, { kind: 'menu', key }), 404, 'not_found', 'creating from the same upload again');
  });
  await test('listing by kind, delete by the owner only, files removed', async () => {
    const alice = await signIn('alice');
    const bob = await signIn('bobby');
    const placeId = await placeFor(alice, 'photos2');
    const menu = status(await post(`/places/${placeId}/photos`, bob.token, { kind: 'menu', key: await upload(bob, placeId, await picture(300, 300, 'png'), 'image/png') }), 201).body;
    status(await post(`/places/${placeId}/photos`, bob.token, { kind: 'place', key: await upload(bob, placeId, await picture(300, 200)) }), 201);

    same(status(await get(`/places/${placeId}/photos`, alice.token, { kind: 'menu' }), 200).body.items.map((p) => p.id), [menu.id], 'menu photos');
    failsWith(await del(`/places/${placeId}/photos/${menu.id}`, alice.token), 404, 'not_found', 'someone else’s photo');
    status(await del(`/places/${placeId}/photos/${menu.id}`, bob.token), 204, 'own photo');
    ok(await gone(menu.url), 'deleted photo should no longer be served');
  });
  await test('not a picture -> 422 invalid_image; someone else’s upload -> 400 invalid_key; bad requests -> 400', async () => {
    const alice = await signIn('alice');
    const bob = await signIn('bobby');
    const placeId = await placeFor(alice, 'photos3');
    const notAnImage = await upload(alice, placeId, Buffer.from('definitely not a jpeg, just some text'));
    failsWith(await post(`/places/${placeId}/photos`, alice.token, { kind: 'place', key: notAnImage }), 422, 'invalid_image');
    const bobsKey = await upload(bob, placeId, await picture(100, 100));
    failsWith(await post(`/places/${placeId}/photos`, alice.token, { kind: 'place', key: bobsKey }), 400, 'invalid_key');
    failsWith(await post(`/places/${placeId}/photos`, alice.token, { kind: 'selfie', key: bobsKey }), 400, 'validation_failed', 'unknown kind');
    failsWith(await post(`/places/${placeId}/photos/upload-url`, alice.token, { contentType: 'image/gif', contentLength: 10 }), 400, 'validation_failed', 'gif');
    failsWith(await post(`/places/${placeId}/photos/upload-url`, alice.token, { contentType: 'image/jpeg', contentLength: 11 * 1024 * 1024 }), 400, 'validation_failed', '11 MB');
    failsWith(await post(`/places/${placeId}/photos/upload-url`, undefined, { contentType: 'image/jpeg', contentLength: 10 }), 401, 'unauthorized', 'no token');
  });
}

async function live() {
  section('Live location socket');
  const redisKey = (u) => `loc:${u.id}`;

  await liveTest('upgrade without a valid token is refused with HTTP 401', async () => {
    const alice = await signIn('alice');
    let error;
    await Live.open({ ...alice, token: 'nonsense' }).catch((e) => (error = e));
    ok(error?.message === 'HTTP 401', `expected HTTP 401 for a bad token, got ${error?.message}`);
    const status2 = await new Promise((resolve) => {
      const ws = new WebSocket(WS_URL);
      ws.once('unexpected-response', (_req, res) => resolve(res.statusCode));
      ws.once('error', () => undefined);
    });
    same(status2, 401, 'no Authorization header');
  });
  await liveTest('hello carries the ghost flag and the last known position of friends only', async () => {
    const alice = await signIn('alice');
    const bob = await signIn('bobby');
    const stranger = await signIn('stranger');
    await befriend(alice, bob);

    const b = await connect(bob);
    same([b.hello.userId, b.hello.ghost, b.hello.friends], [bob.id, false, []], 'bobby hello');
    ok(typeof b.hello.serverTime === 'number', 'hello needs serverTime');
    await b.client.loc();
    const s = await connect(stranger);
    await s.client.loc({ ...here, lat: 31 });
    await sleep(300);

    const a = await connect(alice);
    same(a.hello.friends.length, 1, 'alice sees one friend');
    const f = a.hello.friends[0];
    same([f.userId, f.lat, f.lng, f.accuracy, f.heading], [bob.id, here.lat, here.lng, 12, 90], 'bobby’s last position');
  });
  await liveTest('a position reaches friends only; it sits in Redis for 60 s and nowhere else', async () => {
    const alice = await signIn('alice');
    const bob = await signIn('bobby');
    const stranger = await signIn('stranger');
    await befriend(alice, bob);
    const a = await connect(alice);
    const b = await connect(bob);
    const s = await connect(stranger);

    await a.client.loc();
    const got = (await b.client.next('loc')).d;
    same([got.userId, got.lat, got.lng, got.accuracy, got.heading], [alice.id, here.lat, here.lng, 12, 90], 'frame');
    ok(Math.abs(got.ts - Date.now()) < 10_000, 'ts should be about now');
    await s.client.expectNone('loc');
    await a.client.expectNone('loc'); // you do not get your own position back

    await withRedis(async (r) => {
      const stored = JSON.parse(await r.get(redisKey(alice)));
      same([stored.lat, stored.lng], [here.lat, here.lng], 'stored position');
      const ttl = await r.ttl(redisKey(alice));
      ok(ttl > 45 && ttl <= 60, `Redis TTL should be about 60 s, got ${ttl}`);
    });
  });
  await liveTest('bad positions get an error frame, are not shared, and heading -1 becomes null', async () => {
    const alice = await signIn('alice');
    const bob = await signIn('bobby');
    await befriend(alice, bob);
    const a = await connect(alice);
    const b = await connect(bob);

    a.client.send('loc', { ...here, lat: 91 });
    same((await a.client.next('error')).d.code, 'invalid_loc', 'lat 91');
    a.client.send('loc', { ...here, lng: -181 });
    same((await a.client.next('error')).d.code, 'invalid_loc', 'lng -181');
    a.client.send('loc', { ...here, accuracy: 150 });
    same((await a.client.next('error')).d.code, 'accuracy_too_low', 'accuracy 150');
    a.client.send('loc', 'hello');
    same((await a.client.next('error')).d.code, 'invalid_loc', 'not an object');
    a.client.send('loc', { ...here, heading: 400 });
    same((await a.client.next('error')).d.code, 'invalid_loc', 'heading 400');
    await b.client.expectNone('loc');

    await a.client.loc({ ...here, heading: -1 });
    same((await b.client.next('loc')).d.heading, null, 'heading -1 -> null');
  });
  await liveTest('garbage frames and unknown messages are ignored; the connection stays open', async () => {
    const alice = await signIn('alice');
    const bob = await signIn('bobby');
    await befriend(alice, bob);
    const a = await connect(alice);
    const b = await connect(bob);
    a.client.ws.send('not json at all');
    a.client.ws.send(JSON.stringify({ nope: true }));
    a.client.send('teleport', { x: 1 });
    await a.client.loc();
    same((await b.client.next('loc')).d.userId, alice.id, 'still delivering');
  });
  await liveTest('updates closer together than the minimum gap are dropped', async () => {
    const alice = await signIn('alice');
    const bob = await signIn('bobby');
    await befriend(alice, bob);
    const a = await connect(alice);
    const b = await connect(bob);
    a.client.send('loc', { ...here, lat: 30.01 });
    a.client.send('loc', { ...here, lat: 30.02 }); // too soon: dropped silently
    same((await b.client.next('loc')).d.lat, 30.01, 'first update delivered');
    await b.client.expectNone('loc', () => true, 500);
    await sleep(MIN_LOC_MS + 200);
    a.client.send('loc', { ...here, lat: 30.03 });
    same((await b.client.next('loc')).d.lat, 30.03, 'update after the gap');
  });
  await liveTest('an oversized frame closes the socket with 1009', async () => {
    const alice = await signIn('alice');
    const { client } = await connect(alice);
    client.ws.send(JSON.stringify({ t: 'loc', d: { pad: 'x'.repeat(5000) } }));
    same((await client.closed).code, 1009, 'close code');
  });
  await liveTest('flooding closes the socket with 4429', async () => {
    const alice = await signIn('alice');
    const { client } = await connect(alice);
    for (let i = 0; i < 80; i++) client.send('loc', here);
    same((await client.closed).code, 4429, 'close code');
  });
  await liveTest('more than ten invalid messages close the socket with 4400', async () => {
    const alice = await signIn('alice');
    const { client } = await connect(alice);
    for (let i = 0; i < 14; i++) client.send('loc', { lat: 999 });
    same((await client.closed).code, 4400, 'close code');
  });

  await liveTest('ghost mode hides you at once, survives reconnects, and can be switched off', async () => {
    const alice = await signIn('alice');
    const bob = await signIn('bobby');
    await befriend(alice, bob);
    const a = await connect(alice);
    const b = await connect(bob);
    await a.client.loc();
    await b.client.next('loc');

    a.client.send('ghost', { on: true });
    same((await a.client.next('ghost')).d, { on: true }, 'confirmation');
    same((await b.client.next('gone')).d.userId, alice.id, 'friend told to remove the marker');
    await withRedis(async (r) => same(await r.exists(redisKey(alice)), 0, 'Redis key removed'));

    await a.client.loc({ ...here, lat: 30.1 });
    await b.client.expectNone('loc');
    await withRedis(async (r) => same(await r.exists(redisKey(alice)), 0, 'nothing stored while hidden'));
    same(status(await get('/me', alice.token), 200).body.ghostMode, true, 'saved on the profile');

    await a.client.close();
    const again = await connect(alice);
    same(again.hello.ghost, true, 'new connection starts hidden');
    again.client.send('ghost', { on: false });
    same((await again.client.next('ghost')).d, { on: false }, 'switched off');
    await again.client.loc();
    same((await b.client.next('loc')).d.userId, alice.id, 'visible again');
  });
  await liveTest('switching ghost mode through PATCH /me also applies to the open socket', async () => {
    const alice = await signIn('alice');
    const bob = await signIn('bobby');
    await befriend(alice, bob);
    const a = await connect(alice);
    const b = await connect(bob);
    await a.client.loc();
    await b.client.next('loc');
    status(await patch('/me', alice.token, { ghostMode: true }), 200);
    same((await a.client.next('ghost')).d.on, true, 'alice told');
    same((await b.client.next('gone')).d.userId, alice.id, 'friend told');
  });
  await liveTest('a malformed ghost message gets an invalid_ghost error', async () => {
    const alice = await signIn('alice');
    const { client } = await connect(alice);
    client.send('ghost', { on: 'yes' });
    same((await client.next('error')).d.code, 'invalid_ghost', 'code');
  });

  await liveTest('friends are told when you disconnect, and your stored position is removed', async () => {
    const alice = await signIn('alice');
    const bob = await signIn('bobby');
    await befriend(alice, bob);
    const a = await connect(alice);
    const b = await connect(bob);
    await a.client.loc();
    await b.client.next('loc');
    await a.client.close();
    same((await b.client.next('gone')).d.userId, alice.id, 'gone frame');
    await withRedis(async (r) => same(await r.exists(redisKey(alice)), 0, 'Redis key removed'));
  });
  await liveTest('one connection per person: a newer one replaces the older with 4409', async () => {
    const alice = await signIn('alice');
    const bob = await signIn('bobby');
    await befriend(alice, bob);
    const b = await connect(bob);
    const first = await connect(alice);
    await first.client.loc();
    await b.client.next('loc');
    const second = await connect(alice);
    same((await first.client.closed).code, 4409, 'close code of the old connection');
    await b.client.expectNone('gone'); // a replacement is not a disconnect
    await second.client.loc({ ...here, lat: 30.2 });
    same((await b.client.next('loc')).d.lat, 30.2, 'new connection delivers');
  });

  await liveTest('becoming friends shows both people each other’s position right away', async () => {
    const alice = await signIn('alice');
    const bob = await signIn('bobby');
    const a = await connect(alice);
    const b = await connect(bob);
    await a.client.loc();
    await b.client.loc({ ...here, lat: 30.3 });
    await sleep(300);
    await a.client.expectNone('loc');
    await befriend(alice, bob);
    const seenByA = (await a.client.next('loc')).d;
    same([seenByA.userId, seenByA.lat], [bob.id, 30.3], 'alice sees bobby');
    const seenByB = (await b.client.next('loc')).d;
    same([seenByB.userId, seenByB.lat], [alice.id, here.lat], 'bobby sees alice');
  });
  await liveTest('removing a friend removes both markers and stops sharing', async () => {
    const alice = await signIn('alice');
    const bob = await signIn('bobby');
    await befriend(alice, bob);
    const a = await connect(alice);
    const b = await connect(bob);
    await a.client.loc();
    await b.client.next('loc');
    status(await del(`/friends/${bob.id}`, alice.token), 204);
    same((await a.client.next('gone')).d.userId, bob.id, 'alice told');
    same((await b.client.next('gone')).d.userId, alice.id, 'bobby told');
    await a.client.loc({ ...here, lat: 30.4 });
    await b.client.expectNone('loc');
  });
  await liveTest('blocking stops sharing in both directions', async () => {
    const alice = await signIn('alice');
    const bob = await signIn('bobby');
    await befriend(alice, bob);
    const a = await connect(alice);
    const b = await connect(bob);
    await b.client.loc();
    await a.client.next('loc');
    status(await post('/blocks', alice.token, { userId: bob.id }), 204);
    same((await a.client.next('gone')).d.userId, bob.id, 'alice told');
    same((await b.client.next('gone')).d.userId, alice.id, 'bobby told');
    await b.client.loc({ ...here, lat: 30.5 });
    await a.client.expectNone('loc');
  });
  await liveTest('deleting an account closes its socket with 4403 and tells friends', async () => {
    const alice = await signIn('alice');
    const bob = await signIn('bobby');
    await befriend(alice, bob);
    const a = await connect(alice);
    const b = await connect(bob);
    await a.client.loc();
    await b.client.next('loc');
    status(await del('/me', alice.token), 204);
    same((await a.client.closed).code, 4403, 'close code');
    same((await b.client.next('gone')).d.userId, alice.id, 'friend told');
    await withRedis(async (r) => same(await r.exists(redisKey(alice)), 0, 'Redis key removed'));
  });

  if (SKIP_SLOW) {
    out('  - skipped: a connection that stops answering pings is closed (--skip-slow)');
  } else {
    await liveTest(`a connection that stops answering pings is closed by the server (waits up to ${Math.round((PING_MS * 2 + 5000) / 1000)} s)`, async () => {
      const alice = await signIn('alice');
      const bob = await signIn('bobby');
      await befriend(alice, bob);
      const b = await connect(bob);
      const a = await connect(alice, { autoPong: false });
      await a.client.loc();
      await b.client.next('loc');
      const closed = await Promise.race([a.client.closed, sleep(PING_MS * 2 + 5000).then(() => null)]);
      ok(closed, 'the server never closed the silent connection');
      same((await b.client.next('gone', () => true, 5000)).d.userId, alice.id, 'friend told');
    });
  }
}

// ---------------------------------------------------------------- the account deletion flow (REST)

async function deletion() {
  section('Deleting an account');
  await test('removes ratings, friendships and sessions, updates averages, and frees the username', async () => {
    const alice = await signIn('alice');
    const bob = await signIn('bobby');
    await befriend(alice, bob);
    const placeId = await placeFor(alice, 'del');
    status(await put(`/places/${placeId}/rating`, alice.token, { stars: 5 }), 200);
    status(await put(`/places/${placeId}/rating`, bob.token, { stars: 1 }), 200);

    status(await del('/me', alice.token), 204);
    failsWith(await get('/me', alice.token), 401, 'unauthorized', 'her access token stops working at once');
    failsWith(await post('/auth/refresh', undefined, { refreshToken: alice.refresh }), 401, undefined, 'her refresh token');

    const detail = status(await get(`/places/${placeId}`, bob.token), 200).body;
    same(detail.ratingCount, 1, 'count after her ratings are gone');
    near(detail.avgRating, 1, 1e-9, 'average after her ratings are gone');
    same(status(await get('/friends', bob.token), 200).body.friends, [], 'friendship gone');
    same(status(await get('/users/search', bob.token, { q: nm('ali') }), 200).body.items, [], 'no longer searchable');

    const again = await signIn('alice');
    ok(again.id !== alice.id, 'the same username must start a brand-new person');
  });
}

// ---------------------------------------------------------------- clean-up and summary

async function cleanUp() {
  section('Clean-up');
  let removedDirectly = false;
  if (process.env.DATABASE_URL) {
    try {
      const { default: pg } = await import('pg');
      const db = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined });
      await db.connect();
      try {
        const ids = [...new Set(people.map((p) => p.id))];
        const p = await db.query('DELETE FROM places WHERE name LIKE $1', [`Smoke ${RUN} %`]);
        // by id, so the anonymised rows left behind by the account-deletion checks go too
        const u = await db.query(`DELETE FROM users WHERE id = ANY($1::uuid[]) OR username LIKE $2`, [ids, `s${RUN}%`]);
        out(`  removed ${u.rowCount} test people and ${p.rowCount} test places from Postgres`);
        removedDirectly = true;
      } finally {
        await db.end();
      }
    } catch (err) {
      out(`  could not clean up through Postgres (${err.message}); falling back to the API`);
    }
  }
  if (!removedDirectly) {
    let removed = 0;
    for (const p of people) {
      if (!p.token) continue;
      const res = await del('/me', p.token).catch(() => undefined);
      if (res?.status === 204) removed++;
    }
    out(`  deleted ${removed} test accounts through the API (the test places stay; their names start with "Smoke ${RUN}")`);
  }
  if (redis) await redis.quit().catch(() => undefined);
}

function summary() {
  const failed = results.filter((r) => !r.ok);
  out('');
  out('─'.repeat(60));
  out(`${results.length - failed.length} of ${results.length} checks passed against ${BASE}`);
  if (failed.length) {
    out(paint(31, `${failed.length} failed:`));
    for (const f of failed) out(paint(31, `  ✗ [${f.section}] ${f.name}`));
  }
  out('');
  out('Not covered here: a successful Sign in with Apple (needs a real Apple token) and the closed /auth/dev route');
  out('(needs DEV_AUTH_ENABLED=false); both are covered by `npm run test:e2e`.');
  return failed.length;
}

const startedAt = Date.now();
out(`Place Rating API check against ${BASE}  (run ${RUN})`);
await preflight();
redis = await openRedis();
if (!redis) out(paint(2, 'Redis is not reachable with REDIS_URL from .env; the checks that look inside Redis are skipped.'));

await healthAndErrors();
await authAndProfile();
await places();
await ratings();
await social();
await reports();
await photos();
await deletion();
await live();
await cleanUp();

const failures = summary();
out(`Took ${Math.round((Date.now() - startedAt) / 1000)} s`);
try {
  writeFileSync(new URL('./smoke-report.txt', import.meta.url), lines.join('\n') + '\n');
} catch {
  // the report file is a convenience
}
process.exit(failures ? 1 : 0);
