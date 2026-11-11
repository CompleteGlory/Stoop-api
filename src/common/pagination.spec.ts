import { clampLimit, decodeCursor, encodeCursor, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from './pagination.js';

describe('clampLimit', () => {
  it('defaults, floors and caps', () => {
    expect(clampLimit(undefined)).toBe(DEFAULT_PAGE_SIZE);
    expect(clampLimit('abc')).toBe(DEFAULT_PAGE_SIZE);
    expect(clampLimit('0')).toBe(DEFAULT_PAGE_SIZE);
    expect(clampLimit('-4')).toBe(DEFAULT_PAGE_SIZE);
    expect(clampLimit('7')).toBe(7);
    expect(clampLimit('7.9')).toBe(7);
    expect(clampLimit('9999')).toBe(MAX_PAGE_SIZE);
  });
});

describe('cursors', () => {
  const cursor = { ts: '2026-11-11 05:00:00.123456+00', id: '3f2504e0-4f89-41d3-9a0c-0305e82c3301' };

  it('round-trips, keeping the microseconds of the timestamp', () => {
    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
  });

  it('treats a missing cursor as the first page', () => {
    expect(decodeCursor(undefined)).toBeNull();
    expect(decodeCursor('')).toBeNull();
  });

  it.each([
    ['not base64 json', 'garbage'],
    ['json without fields', Buffer.from('{}').toString('base64url')],
    ['bad timestamp', Buffer.from(JSON.stringify({ ts: 'yesterday', id: cursor.id })).toString('base64url')],
    ['bad id', Buffer.from(JSON.stringify({ ts: cursor.ts, id: "1'; DROP TABLE users;--" })).toString('base64url')],
  ])('rejects %s', (_name, raw) => {
    expect(() => decodeCursor(raw)).toThrow(/cursor/i);
  });
});
