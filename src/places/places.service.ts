import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { ApiError } from '../common/api-error.js';
import { RateLimiter } from '../common/rate-limiter.service.js';
import type { BBox } from './bbox.js';
import type { ResolvePlaceDto } from './places.dto.js';

export interface PlaceDto {
  id: string;
  appleId: string | null;
  name: string;
  category: string | null;
  latitude: number;
  longitude: number;
  avgRating: number;
  ratingCount: number;
}

export interface MyRatingDto {
  id: string;
  stars: number;
  comment: string | null;
  updatedAt: string;
}

const PLACE_COLUMNS = `
  p.id, p.apple_id, p.name, p.category,
  ST_Y(p.location::geometry) AS latitude,
  ST_X(p.location::geometry) AS longitude,
  p.avg_rating, p.rating_count`;

export function toPlaceDto(row: any): PlaceDto {
  return {
    id: row.id,
    appleId: row.apple_id,
    name: row.name,
    category: row.category,
    latitude: row.latitude,
    longitude: row.longitude,
    avgRating: Math.round(row.avg_rating * 100) / 100,
    ratingCount: row.rating_count,
  };
}

/** Places within this many metres with the same name are treated as one place when there is no Apple id. */
const SAME_PLACE_RADIUS_M = 30;
export const MAX_PLACES_PER_QUERY = 200;

@Injectable()
export class PlacesService {
  constructor(
    private readonly db: DataSource,
    private readonly limiter: RateLimiter,
  ) {}

  /** Places inside the box, most-rated first, at most 200. */
  async inBBox(box: BBox): Promise<PlaceDto[]> {
    const rows = await this.db.query(
      `SELECT ${PLACE_COLUMNS}
         FROM places p
        WHERE p.location && ST_MakeEnvelope($1, $2, $3, $4, 4326)::geography
        ORDER BY p.rating_count DESC, p.id
        LIMIT ${MAX_PLACES_PER_QUERY}`,
      [box.minLng, box.minLat, box.maxLng, box.maxLat],
    );
    return rows.map(toPlaceDto);
  }

  /**
   * Finds the place for something the person picked on the map, creating it
   * the first time anyone rates there. An existing place is never changed by
   * a client, so nobody can rename or move another person's place.
   */
  async resolve(userId: string, dto: ResolvePlaceDto): Promise<PlaceDto> {
    await this.limiter.consume(`place-resolve:${userId}`, 120, 3600, 'place lookups');
    const point = `ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography`;

    if (dto.appleId) {
      // DO UPDATE with the same value only so RETURNING also gives the row that already existed
      const rows = await this.db.query(
        `WITH upserted AS (
           INSERT INTO places (apple_id, name, category, location)
           VALUES ($3, $4, $5, ${point})
           ON CONFLICT (apple_id) DO UPDATE SET apple_id = EXCLUDED.apple_id
           RETURNING *
         )
         SELECT ${PLACE_COLUMNS} FROM upserted p`,
        [dto.longitude, dto.latitude, dto.appleId, dto.name, dto.category ?? null],
      );
      return toPlaceDto(rows[0]);
    }

    const existing = await this.db.query(
      `SELECT ${PLACE_COLUMNS}
         FROM places p
        WHERE p.apple_id IS NULL
          AND lower(p.name) = lower($3)
          AND ST_DWithin(p.location, ${point}, ${SAME_PLACE_RADIUS_M})
        ORDER BY p.rating_count DESC
        LIMIT 1`,
      [dto.longitude, dto.latitude, dto.name],
    );
    if (existing[0]) return toPlaceDto(existing[0]);

    const created = await this.db.query(
      `WITH inserted AS (
         INSERT INTO places (name, category, location)
         VALUES ($3, $4, ${point})
         RETURNING *
       )
       SELECT ${PLACE_COLUMNS} FROM inserted p`,
      [dto.longitude, dto.latitude, dto.name, dto.category ?? null],
    );
    return toPlaceDto(created[0]);
  }

  async get(placeId: string, viewerId: string): Promise<PlaceDto & { myRating: MyRatingDto | null }> {
    const rows = await this.db.query(`SELECT ${PLACE_COLUMNS} FROM places p WHERE p.id = $1`, [placeId]);
    if (!rows[0]) throw ApiError.notFound('Place');

    const mine = await this.db.query(
      `SELECT id, stars, comment, updated_at FROM ratings WHERE place_id = $1 AND user_id = $2`,
      [placeId, viewerId],
    );
    return {
      ...toPlaceDto(rows[0]),
      myRating: mine[0]
        ? {
            id: mine[0].id,
            stars: mine[0].stars,
            comment: mine[0].comment,
            updatedAt: new Date(mine[0].updated_at).toISOString(),
          }
        : null,
    };
  }
}
