import { ApiError } from '../common/api-error.js';
import { CHARACTER_STYLES, validateCharacter } from './character.js';
import * as collection from '@dicebear/collection';

const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (err) {
    return (err as ApiError).code;
  }
  return 'no error';
};

describe('validateCharacter', () => {
  it('accepts real options and normalises colours', () => {
    expect(
      validateCharacter({
        style: 'avataaars',
        options: { top: 'shortFlat', hairColor: '2C1B18', facialHair: 'none', clothing: 'hoodie' },
      }),
    ).toEqual({
      style: 'avataaars',
      options: { top: 'shortFlat', hairColor: '2c1b18', facialHair: 'none', clothing: 'hoodie' },
    });
  });

  it('knows every style it allows', () => {
    for (const style of CHARACTER_STYLES) {
      expect((collection as Record<string, { schema?: unknown }>)[style]?.schema).toBeDefined();
    }
  });

  it.each([
    ['a style that is not a character', { style: 'identicon', options: {} }],
    ['an unknown option', { style: 'avataaars', options: { wings: 'big' } }],
    ['a value the style does not have', { style: 'avataaars', options: { top: 'dragonHair' } }],
    ['none for a part that is always drawn', { style: 'avataaars', options: { eyes: 'none' } }],
    ['a colour that is not hex', { style: 'avataaars', options: { hairColor: 'black' } }],
    ['picture settings', { style: 'avataaars', options: { backgroundColor: 'ffffff' } }],
    ['probabilities', { style: 'avataaars', options: { facialHairProbability: '100' } }],
    ['extra fields', { style: 'avataaars', options: {}, url: 'https://x' }],
    ['a non-string value', { style: 'avataaars', options: { top: 3 } }],
    ['no object at all', 'avataaars'],
  ])('rejects %s', (_, input) => {
    expect(code(() => validateCharacter(input))).toBe('invalid_avatar');
  });
});
