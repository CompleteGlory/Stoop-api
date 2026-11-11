import { locKey, parseFrame, parseGhost, parseLoc } from './live.protocol.js';

const now = 1_800_000_000_000;
const ok = { lat: 30.0444, lng: 31.2357, accuracy: 12, heading: 90, ts: now };

describe('parseLoc', () => {
  it('accepts a normal update and rounds to 6 decimals', () => {
    const r = parseLoc({ ...ok, lat: 30.04441234567, lng: 31.23571234567, accuracy: 12.4 }, now);
    expect(r).toEqual({
      ok: true,
      value: { lat: 30.044412, lng: 31.235712, accuracy: 12, heading: 90, ts: now },
    });
  });

  it.each([
    ['latitude above 90', { lat: 90.0001 }],
    ['latitude below -90', { lat: -91 }],
    ['longitude above 180', { lng: 180.5 }],
    ['non-numeric latitude', { lat: '30' }],
    ['NaN longitude', { lng: Number.NaN }],
    ['missing accuracy', { accuracy: undefined }],
    ['negative accuracy', { accuracy: -1 }],
    ['heading of 360 or more', { heading: 360 }],
    ['non-numeric heading', { heading: 'north' }],
  ])('rejects %s', (_name, patch) => {
    const r = parseLoc({ ...ok, ...patch }, now);
    expect(r.ok).toBe(false);
  });

  it('rejects positions less accurate than 100 m with its own code, and accepts exactly 100', () => {
    expect(parseLoc({ ...ok, accuracy: 100.5 }, now)).toMatchObject({ ok: false, code: 'accuracy_too_low' });
    expect(parseLoc({ ...ok, accuracy: 100 }, now).ok).toBe(true);
  });

  it('treats a missing, null or negative heading as unknown', () => {
    for (const heading of [undefined, null, -1]) {
      expect(parseLoc({ ...ok, heading }, now)).toMatchObject({ ok: true, value: { heading: null } });
    }
  });

  it('replaces a timestamp that is missing or far from the server clock', () => {
    expect(parseLoc({ ...ok, ts: undefined }, now)).toMatchObject({ value: { ts: now } });
    expect(parseLoc({ ...ok, ts: now - 61_000 }, now)).toMatchObject({ value: { ts: now } });
    expect(parseLoc({ ...ok, ts: now + 61_000 }, now)).toMatchObject({ value: { ts: now } });
    expect(parseLoc({ ...ok, ts: now - 5_000 }, now)).toMatchObject({ value: { ts: now - 5_000 } });
  });

  it.each([[null], [undefined], ['x'], [42], [[]]])('rejects %j as a whole payload', (payload) => {
    expect(parseLoc(payload, now).ok).toBe(false);
  });
});

describe('parseGhost', () => {
  it('needs a boolean', () => {
    expect(parseGhost({ on: true })).toEqual({ ok: true, value: { on: true } });
    expect(parseGhost({ on: false })).toEqual({ ok: true, value: { on: false } });
    for (const bad of [{ on: 'true' }, { on: 1 }, {}, null, 'on']) {
      expect(parseGhost(bad).ok).toBe(false);
    }
  });
});

describe('parseFrame', () => {
  it('reads { t, d } frames from strings and buffers', () => {
    expect(parseFrame('{"t":"loc","d":{"lat":1}}')).toEqual({ event: 'loc', data: { lat: 1 } });
    expect(parseFrame(Buffer.from('{"t":"ghost","d":{"on":true}}'))).toEqual({
      event: 'ghost',
      data: { on: true },
    });
  });

  it('drops anything else instead of throwing', () => {
    for (const bad of ['', 'nope', '{"d":1}', '{"t":5}', 'null', '[]']) {
      expect(parseFrame(bad)).toBeUndefined();
    }
  });
});

describe('locKey', () => {
  it('namespaces keys by user', () => {
    expect(locKey('abc')).toBe('loc:abc');
  });
});
