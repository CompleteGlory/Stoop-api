import { ApiError } from '../common/api-error.js';
import { parseBBox } from './bbox.js';

describe('parseBBox', () => {
  it('parses minLng,minLat,maxLng,maxLat', () => {
    expect(parseBBox('31.1,29.9,31.4,30.2')).toEqual({ minLng: 31.1, minLat: 29.9, maxLng: 31.4, maxLat: 30.2 });
    expect(parseBBox(' -0.2 , 51.4 , 0.1 , 51.6 ')).toEqual({ minLng: -0.2, minLat: 51.4, maxLng: 0.1, maxLat: 51.6 });
  });

  it.each([
    [undefined],
    [''],
    ['1,2,3'],
    ['1,2,3,4,5'],
    ['a,b,c,d'],
    ['1,,3,4'],
    ['31,30,30,31'], // min lng above max lng
    ['30,31,31,30'], // min lat above max lat
    ['0,0,0,1'], // empty width
    ['-181,0,0,1'],
    ['0,-91,1,0'],
    ['0,0,181,1'],
    ['0,0,1,91'],
    ['0,0,5.5,1'], // wider than 5 degrees
    ['0,0,1,5.5'],
    ['Infinity,0,1,1'],
  ])('rejects %j', (raw) => {
    expect(() => parseBBox(raw)).toThrow(ApiError);
    try {
      parseBBox(raw);
    } catch (err) {
      expect((err as ApiError).code).toBe('invalid_bbox');
      expect((err as ApiError).getStatus()).toBe(400);
    }
  });

  it('allows a span of exactly 5 degrees', () => {
    expect(() => parseBBox('0,0,5,5')).not.toThrow();
  });
});
