import { ApiError } from './api-error.js';

export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 50;

export function clampLimit(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_PAGE_SIZE;
  return Math.min(Math.floor(n), MAX_PAGE_SIZE);
}

/**
 * Keyset cursors are opaque to clients. `ts` is the database's own text form
 * of the timestamp: a JS Date would cut microseconds and make pages overlap.
 */
export interface Cursor {
  ts: string;
  id: string;
}

export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function decodeCursor(raw: string | undefined): Cursor | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (
      typeof parsed?.ts === 'string' &&
      !Number.isNaN(Date.parse(parsed.ts)) &&
      typeof parsed?.id === 'string' &&
      UUID.test(parsed.id)
    ) {
      return { ts: parsed.ts, id: parsed.id };
    }
  } catch {
    // fall through
  }
  throw ApiError.badRequest('invalid_cursor', 'The cursor is not valid');
}
