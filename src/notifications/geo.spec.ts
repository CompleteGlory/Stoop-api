import { coarse, distanceM } from './geo.js';

describe('distanceM', () => {
  it('is zero for the same point and symmetric', () => {
    const p = { lat: 30.0444, lng: 31.2357 };
    expect(distanceM(p, p)).toBe(0);
    const q = { lat: 30.05, lng: 31.24 };
    expect(distanceM(p, q)).toBeCloseTo(distanceM(q, p), 6);
  });

  it('matches known distances', () => {
    // one thousandth of a degree of latitude is about 111 m everywhere
    expect(distanceM({ lat: 30, lng: 31 }, { lat: 30.001, lng: 31 })).toBeCloseTo(111.2, 0);
    // Cairo to Alexandria is about 180 km as the crow flies
    const km = distanceM({ lat: 30.0444, lng: 31.2357 }, { lat: 31.2001, lng: 29.9187 }) / 1000;
    expect(km).toBeGreaterThan(175);
    expect(km).toBeLessThan(185);
  });

  it('works across the antimeridian', () => {
    expect(distanceM({ lat: 0, lng: 179.9995 }, { lat: 0, lng: -179.9995 })).toBeLessThan(120);
  });
});

describe('coarse', () => {
  it('keeps three decimals', () => {
    expect(coarse(30.044449)).toBe(30.044);
    expect(coarse(-31.23571)).toBe(-31.236);
  });
});
