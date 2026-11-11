import * as collection from '@dicebear/collection';
import { ApiError } from '../common/api-error.js';

/**
 * The DiceBear styles that draw a person someone can customise. The app renders avatars itself
 * from `{ style, options }` with the same DiceBear version (9.4.3), so the server only checks that
 * every option exists in that style's own schema.
 */
export const CHARACTER_STYLES = [
  'adventurer', 'avataaars', 'bigEars', 'bigSmile', 'croodles', 'dylan', 'lorelei',
  'micah', 'miniavs', 'notionists', 'openPeeps', 'personas', 'pixelArt', 'toonHead',
] as const;

export type CharacterStyle = (typeof CHARACTER_STYLES)[number];

export interface CharacterDto {
  style: CharacterStyle;
  /** Option name → an allowed value, a 6-digit hex colour, or `none` for an optional part. */
  options: Record<string, string>;
}

/** Options that describe the picture rather than the person, so a client may not set them. */
const NOT_ALLOWED = new Set([
  'seed', 'flip', 'rotate', 'scale', 'radius', 'size', 'translateX', 'translateY', 'clip',
  'randomizeIds', 'backgroundColor', 'backgroundType', 'backgroundRotation',
]);
const COLOR = /^[0-9a-f]{6}$/;
const MAX_OPTIONS = 40;

interface SchemaProperty {
  type?: string;
  items?: { enum?: string[]; pattern?: string };
}

function propertiesOf(style: CharacterStyle): Record<string, SchemaProperty> {
  const schema = (collection as unknown as Record<string, { schema?: { properties?: object } }>)[style]?.schema;
  return (schema?.properties ?? {}) as Record<string, SchemaProperty>;
}

const invalid = (message: string) => ApiError.badRequest('invalid_avatar', message);

/** Returns a normalised copy of `input`, or throws `400 invalid_avatar`. */
export function validateCharacter(input: unknown): CharacterDto {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw invalid('avatar must be an object with style and options');
  }
  const { style, options, ...rest } = input as Record<string, unknown>;
  if (Object.keys(rest).length > 0) throw invalid(`Unknown avatar fields: ${Object.keys(rest).join(', ')}`);
  if (typeof style !== 'string' || !(CHARACTER_STYLES as readonly string[]).includes(style)) {
    throw invalid(`style must be one of: ${CHARACTER_STYLES.join(', ')}`);
  }
  if (typeof options !== 'object' || options === null || Array.isArray(options)) {
    throw invalid('options must be an object');
  }
  const entries = Object.entries(options as Record<string, unknown>);
  if (entries.length > MAX_OPTIONS) throw invalid(`At most ${MAX_OPTIONS} options`);

  const properties = propertiesOf(style as CharacterStyle);
  const normalised: Record<string, string> = {};
  for (const [name, raw] of entries) {
    const property = properties[name];
    if (!property || property.type !== 'array' || NOT_ALLOWED.has(name) || name.endsWith('Probability')) {
      throw invalid(`${style} has no option "${name}"`);
    }
    if (typeof raw !== 'string') throw invalid(`${name} must be a string`);
    const allowed = property.items?.enum;
    if (allowed) {
      const optional = properties[`${name}Probability`] !== undefined;
      if (!allowed.includes(raw) && !(optional && raw === 'none')) {
        throw invalid(`"${raw}" is not a ${name} of ${style}`);
      }
      normalised[name] = raw;
    } else if (property.items?.pattern) {
      const color = raw.toLowerCase();
      if (!COLOR.test(color)) throw invalid(`${name} must be a 6-digit hex colour`);
      normalised[name] = color;
    } else {
      throw invalid(`${style} has no option "${name}"`);
    }
  }
  return { style: style as CharacterStyle, options: normalised };
}
