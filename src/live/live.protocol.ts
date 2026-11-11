/**
 * Wire format of the /live WebSocket. Every frame is JSON: { "t": type, "d": data }.
 *
 * client -> server   loc    { lat, lng, accuracy, heading, ts }
 *                    ghost  { on }
 * server -> client   hello  { userId, ghost, friends: [{ userId, lat, lng, accuracy, heading, ts }], serverTime }
 *                    loc    { userId, lat, lng, accuracy, heading, ts }
 *                    gone   { userId }
 *                    ghost  { on }      (confirms a ghost change)
 *                    error  { code, message }
 */
export interface LocPayload {
  lat: number;
  lng: number;
  /** Horizontal accuracy in metres. */
  accuracy: number;
  /** Degrees clockwise from north, or null when unknown. */
  heading: number | null;
  /** Milliseconds since the epoch. */
  ts: number;
}

export const MAX_ACCURACY_M = 100;
/** A client clock further than this from ours is not trusted; the server time is used instead. */
const MAX_CLOCK_SKEW_MS = 60_000;

export type Parsed<T> = { ok: true; value: T } | { ok: false; code: string; message: string };

const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

export function parseLoc(raw: unknown, now: number): Parsed<LocPayload> {
  const fail = (code: string, message: string): Parsed<LocPayload> => ({ ok: false, code, message });
  if (typeof raw !== 'object' || raw === null) return fail('invalid_loc', 'loc needs an object');
  const d = raw as Record<string, unknown>;

  if (!isNumber(d.lat) || d.lat < -90 || d.lat > 90) return fail('invalid_loc', 'lat must be between -90 and 90');
  if (!isNumber(d.lng) || d.lng < -180 || d.lng > 180) return fail('invalid_loc', 'lng must be between -180 and 180');
  if (!isNumber(d.accuracy) || d.accuracy < 0) return fail('invalid_loc', 'accuracy must be a number of metres');
  if (d.accuracy > MAX_ACCURACY_M) {
    return fail('accuracy_too_low', `accuracy worse than ${MAX_ACCURACY_M} m is not shared`);
  }

  // CoreLocation reports -1 when the course is unknown
  let heading: number | null = null;
  if (d.heading !== undefined && d.heading !== null) {
    if (!isNumber(d.heading) || d.heading >= 360) return fail('invalid_loc', 'heading must be below 360');
    heading = d.heading >= 0 ? d.heading : null;
  }

  const ts = isNumber(d.ts) && Math.abs(d.ts - now) <= MAX_CLOCK_SKEW_MS ? Math.round(d.ts) : now;
  return {
    ok: true,
    value: { lat: round6(d.lat), lng: round6(d.lng), accuracy: Math.round(d.accuracy), heading, ts },
  };
}

export function parseGhost(raw: unknown): Parsed<{ on: boolean }> {
  if (typeof raw === 'object' && raw !== null && typeof (raw as any).on === 'boolean') {
    return { ok: true, value: { on: (raw as any).on } };
  }
  return { ok: false, code: 'invalid_ghost', message: 'ghost needs { "on": true | false }' };
}

/** Turns a raw frame into the { event, data } pair Nest's WsAdapter routes on. Bad frames are dropped. */
export function parseFrame(data: unknown): { event: string; data: unknown } | undefined {
  try {
    const text = Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
    const frame = JSON.parse(text);
    if (typeof frame?.t === 'string') return { event: frame.t, data: frame.d };
  } catch {
    // not JSON
  }
  return undefined;
}

export const locKey = (userId: string) => `loc:${userId}`;
