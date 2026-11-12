const EARTH_RADIUS_M = 6_371_000;
const rad = (deg: number) => (deg * Math.PI) / 180;

export interface Point {
  lat: number;
  lng: number;
}

/** Great-circle distance in metres (haversine); plenty accurate for "within a few hundred metres". */
export function distanceM(a: Point, b: Point): number {
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** About 110 m of latitude: background positions are kept only this coarse. */
export const coarse = (n: number) => Math.round(n * 1000) / 1000;
