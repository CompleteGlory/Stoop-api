import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { ApiError } from '../common/api-error.js';
import { clampLimit, decodeCursor, encodeCursor } from '../common/pagination.js';
import { USER_COLUMNS, UserMapper, type PublicUserDto, type UserColumns } from '../common/mappers.js';
import { RateLimiter } from '../common/rate-limiter.service.js';
import { toPlaceDto, type PlaceDto } from '../places/places.service.js';
import { recomputePlaceAggregates } from './aggregates.js';

export interface RatingDto {
  id: string;
  stars: number;
  comment: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PlaceRatingDto extends RatingDto {
  user: PublicUserDto;
}

const iso = (value: unknown) => new Date(value as string).toISOString();

@Injectable()
export class RatingsService {
  constructor(
    private readonly db: DataSource,
    private readonly mapper: UserMapper,
    private readonly limiter: RateLimiter,
  ) {}

  /** Creates or replaces the caller's rating of a place. Sending the same body twice leaves the same state. */
  async put(
    userId: string,
    placeId: string,
    input: { stars: number; comment?: string | null },
  ): Promise<{ rating: RatingDto; place: PlaceDto }> {
    await this.limiter.consume(`rating-write:${userId}`, 30, 3600, 'rating changes');
    const comment = input.comment ? input.comment : null;

    return this.db.transaction(async (m) => {
      // locking the place row serialises writers, so the recomputed aggregate is always consistent
      const locked = await m.query(`SELECT id FROM places WHERE id = $1 FOR UPDATE`, [placeId]);
      if (locked.length === 0) throw ApiError.notFound('Place');

      await m.query(
        `INSERT INTO ratings (user_id, place_id, stars, comment)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (user_id, place_id) DO UPDATE
            SET stars = EXCLUDED.stars, comment = EXCLUDED.comment, updated_at = now()
          WHERE (ratings.stars, ratings.comment) IS DISTINCT FROM (EXCLUDED.stars, EXCLUDED.comment)`,
        [userId, placeId, input.stars, comment],
      );
      await recomputePlaceAggregates(m, [placeId]);

      const [rating] = await m.query(
        `SELECT id, stars, comment, created_at, updated_at FROM ratings WHERE user_id = $1 AND place_id = $2`,
        [userId, placeId],
      );
      const [place] = await m.query(
        `SELECT p.id, p.apple_id, p.name, p.category,
                ST_Y(p.location::geometry) AS latitude, ST_X(p.location::geometry) AS longitude,
                p.avg_rating, p.rating_count
           FROM places p WHERE p.id = $1`,
        [placeId],
      );
      return {
        rating: {
          id: rating.id,
          stars: rating.stars,
          comment: rating.comment,
          createdAt: iso(rating.created_at),
          updatedAt: iso(rating.updated_at),
        },
        place: toPlaceDto(place),
      };
    });
  }

  /** Removes the caller's rating. Deleting something that is not there is fine too. */
  async remove(userId: string, placeId: string): Promise<void> {
    await this.limiter.consume(`rating-write:${userId}`, 30, 3600, 'rating changes');
    await this.db.transaction(async (m) => {
      const locked = await m.query(`SELECT id FROM places WHERE id = $1 FOR UPDATE`, [placeId]);
      if (locked.length === 0) throw ApiError.notFound('Place');
      await m.query(`DELETE FROM ratings WHERE user_id = $1 AND place_id = $2`, [userId, placeId]);
      await recomputePlaceAggregates(m, [placeId]);
    });
  }

  /** Newest first, hiding ratings from people the viewer blocked or who blocked the viewer. */
  async listForPlace(placeId: string, viewerId: string, rawLimit?: unknown, rawCursor?: string) {
    const limit = clampLimit(rawLimit);
    const cursor = decodeCursor(rawCursor);

    const exists = await this.db.query(`SELECT 1 FROM places WHERE id = $1`, [placeId]);
    if (exists.length === 0) throw ApiError.notFound('Place');

    const params: unknown[] = [placeId, viewerId, limit + 1];
    let cursorSql = '';
    if (cursor) {
      params.push(cursor.ts, cursor.id);
      cursorSql = `AND (r.updated_at, r.id) < ($4::timestamptz, $5::uuid)`;
    }

    const rows: (UserColumns & {
      id: string;
      stars: number;
      comment: string | null;
      created_at: string;
      updated_at: string;
      cursor_ts: string;
    })[] = await this.db.query(
      `SELECT r.id, r.stars, r.comment, r.created_at, r.updated_at, r.updated_at::text AS cursor_ts,
              ${USER_COLUMNS}
         FROM ratings r
         JOIN users u ON u.id = r.user_id AND u.deleted_at IS NULL
        WHERE r.place_id = $1
          AND NOT EXISTS (
            SELECT 1 FROM blocks b
             WHERE (b.blocker_id = $2 AND b.blocked_id = r.user_id)
                OR (b.blocker_id = r.user_id AND b.blocked_id = $2))
          ${cursorSql}
        ORDER BY r.updated_at DESC, r.id DESC
        LIMIT $3`,
      params,
    );

    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: page.map<PlaceRatingDto>((row) => ({
        id: row.id,
        stars: row.stars,
        comment: row.comment,
        createdAt: iso(row.created_at),
        updatedAt: iso(row.updated_at),
        user: this.mapper.fromColumns(row),
      })),
      nextCursor:
        rows.length > limit && last ? encodeCursor({ ts: last.cursor_ts, id: last.id }) : null,
    };
  }
}
