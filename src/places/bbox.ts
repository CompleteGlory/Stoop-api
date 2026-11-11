import { ApiError } from '../common/api-error.js';

export interface BBox {
  minLng: number;
  minLat: number;
  maxLng: number;
  maxLat: number;
}

/** The map never needs more than this many degrees at once; larger boxes are almost certainly a bug. */
export const MAX_BBOX_SPAN_DEG = 5;

/** Parses `minLng,minLat,maxLng,maxLat`. */
export function parseBBox(raw: unknown): BBox {
  const bad = (message: string) => ApiError.badRequest('invalid_bbox', message);
  if (typeof raw !== 'string') throw bad('bbox is required: minLng,minLat,maxLng,maxLat');
  const parts = raw.split(',');
  if (parts.length !== 4) throw bad('bbox needs four numbers: minLng,minLat,maxLng,maxLat');
  const nums = parts.map((p) => (p.trim() === '' ? Number.NaN : Number(p)));
  if (nums.some((n) => !Number.isFinite(n))) throw bad('bbox values must be numbers');
  const [minLng, minLat, maxLng, maxLat] = nums;

  if (minLat < -90 || maxLat > 90 || minLng < -180 || maxLng > 180) {
    throw bad('bbox is outside the valid longitude/latitude range');
  }
  if (minLng >= maxLng || minLat >= maxLat) {
    throw bad('bbox minimums must be smaller than its maximums');
  }
  if (maxLng - minLng > MAX_BBOX_SPAN_DEG || maxLat - minLat > MAX_BBOX_SPAN_DEG) {
    throw bad(`bbox may span at most ${MAX_BBOX_SPAN_DEG} degrees`);
  }
  return { minLng, minLat, maxLng, maxLat };
}
