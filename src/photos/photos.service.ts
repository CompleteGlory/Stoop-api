import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import sharp from 'sharp';
import { DataSource } from 'typeorm';
import { ApiError } from '../common/api-error.js';
import { USER_COLUMNS, UserMapper, type PublicUserDto, type UserColumns } from '../common/mappers.js';
import { clampLimit, decodeCursor, encodeCursor } from '../common/pagination.js';
import { RateLimiter } from '../common/rate-limiter.service.js';
import { StorageService } from '../common/storage.service.js';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import { MAX_PHOTO_BYTES, type PhotoKind } from './photos.dto.js';

export const PHOTO_MAX_PX = 1600;
export const THUMB_PX = 400;

export interface PlacePhotoDto {
  id: string;
  kind: PhotoKind;
  url: string;
  thumbnailUrl: string;
  width: number;
  height: number;
  createdAt: string;
  user: PublicUserDto;
}

type PhotoRow = UserColumns & {
  id: string;
  kind: PhotoKind;
  object_key: string;
  thumb_key: string;
  width: number;
  height: number;
  created_at: string;
  cursor_ts: string;
};

/**
 * Photos of a place or its menu. The app uploads straight to the private bucket with a presigned
 * URL, then confirms. Confirming re-encodes the picture (at most 1600 px, plus a 400 px square
 * thumbnail) as JPEG, which drops EXIF data such as GPS coordinates, and deletes the original.
 */
@Injectable()
export class PhotosService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly db: DataSource,
    private readonly storage: StorageService,
    private readonly mapper: UserMapper,
    private readonly limiter: RateLimiter,
  ) {}

  private async mustFindPlace(placeId: string) {
    const rows = await this.db.query(`SELECT 1 FROM places WHERE id = $1`, [placeId]);
    if (rows.length === 0) throw ApiError.notFound('Place');
  }

  private url(key: string) {
    return `${this.config.s3.publicBaseUrl}/${key}`;
  }

  async createUploadUrl(userId: string, placeId: string, contentType: string, contentLength: number) {
    await this.mustFindPlace(placeId);
    await this.limiter.consume(`photo-upload:${userId}`, 30, 3600, 'photo uploads');
    const key = `uploads/${userId}/${randomUUID()}`;
    const uploadUrl = await this.storage.presignPut(key, contentType, contentLength);
    return { key, uploadUrl, method: 'PUT' as const, headers: { 'Content-Type': contentType }, expiresIn: 300 };
  }

  async create(userId: string, placeId: string, kind: PhotoKind, uploadKey: string): Promise<PlacePhotoDto> {
    if (!uploadKey.startsWith(`uploads/${userId}/`)) {
      throw ApiError.badRequest('invalid_key', 'That upload does not belong to you');
    }
    await this.mustFindPlace(placeId);
    await this.limiter.consume(`photo-create:${userId}`, 60, 24 * 3600, 'photos');

    const size = await this.storage.size(uploadKey);
    if (size === null) throw ApiError.notFound('Upload');
    if (size > MAX_PHOTO_BYTES) {
      await this.storage.delete(uploadKey);
      throw ApiError.unprocessable('image_too_large', 'Photos can be at most 10 MB');
    }

    const original = await this.storage.get(uploadKey);
    let full: { data: Buffer; info: { width: number; height: number } };
    let thumb: Buffer;
    try {
      const image = sharp(original, { limitInputPixels: 60_000_000 });
      const meta = await image.metadata();
      if (meta.format !== 'jpeg' && meta.format !== 'png') throw new Error('unsupported format');
      // rotate() applies the EXIF orientation before the metadata is dropped; sharp keeps none unless asked
      full = await image
        .clone()
        .rotate()
        .resize(PHOTO_MAX_PX, PHOTO_MAX_PX, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 82 })
        .toBuffer({ resolveWithObject: true });
      thumb = await image.clone().rotate().resize(THUMB_PX, THUMB_PX, { fit: 'cover' }).jpeg({ quality: 78 }).toBuffer();
    } catch {
      await this.storage.delete(uploadKey);
      throw ApiError.unprocessable('invalid_image', 'Upload a JPEG or PNG picture');
    }

    const id = randomUUID();
    const objectKey = `photos/${placeId}/${id}.jpg`;
    const thumbKey = `photos/${placeId}/${id}-t.jpg`;
    await this.storage.put(objectKey, full.data, 'image/jpeg');
    await this.storage.put(thumbKey, thumb, 'image/jpeg');
    await this.storage.delete(uploadKey);

    await this.db.query(
      `INSERT INTO place_photos (id, place_id, user_id, kind, object_key, thumb_key, width, height)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [id, placeId, userId, kind, objectKey, thumbKey, full.info.width, full.info.height],
    );
    const [row] = await this.rows(`p.id = $1`, [id], userId);
    return this.toDto(row);
  }

  /** Newest first, hiding photos by people the viewer blocked or who blocked the viewer. */
  async list(placeId: string, viewerId: string, kind?: PhotoKind, rawLimit?: unknown, rawCursor?: string) {
    await this.mustFindPlace(placeId);
    const limit = clampLimit(rawLimit);
    const cursor = decodeCursor(rawCursor);

    const params: unknown[] = [placeId];
    let where = `p.place_id = $1`;
    if (kind) {
      params.push(kind);
      where += ` AND p.kind = $${params.length}`;
    }
    if (cursor) {
      params.push(cursor.ts, cursor.id);
      where += ` AND (p.created_at, p.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`;
    }
    const rows = await this.rows(where, params, viewerId, limit + 1);
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: page.map((row) => this.toDto(row)),
      nextCursor: rows.length > limit && last ? encodeCursor({ ts: last.cursor_ts, id: last.id }) : null,
    };
  }

  /** Only the person who added a photo can remove it. Anything else looks like it does not exist. */
  async remove(userId: string, placeId: string, photoId: string): Promise<void> {
    // TypeORM answers a DELETE ... RETURNING with [rows, affected count]
    const [deleted]: [{ object_key: string; thumb_key: string }[], number] = await this.db.query(
      `DELETE FROM place_photos WHERE id = $1 AND place_id = $2 AND user_id = $3 RETURNING object_key, thumb_key`,
      [photoId, placeId, userId],
    );
    if (deleted.length === 0) throw ApiError.notFound('Photo');
    await Promise.all([this.storage.delete(deleted[0].object_key), this.storage.delete(deleted[0].thumb_key)]);
  }

  private rows(where: string, params: unknown[], viewerId: string, limit = 1): Promise<PhotoRow[]> {
    const viewer = params.length + 1;
    return this.db.query(
      `SELECT p.id, p.kind, p.object_key, p.thumb_key, p.width, p.height, p.created_at,
              p.created_at::text AS cursor_ts, ${USER_COLUMNS}
         FROM place_photos p
         JOIN users u ON u.id = p.user_id AND u.deleted_at IS NULL
        WHERE ${where}
          AND NOT EXISTS (
            SELECT 1 FROM blocks b
             WHERE (b.blocker_id = $${viewer} AND b.blocked_id = p.user_id)
                OR (b.blocker_id = p.user_id AND b.blocked_id = $${viewer}))
        ORDER BY p.created_at DESC, p.id DESC
        LIMIT $${viewer + 1}`,
      [...params, viewerId, limit],
    );
  }

  private toDto(row: PhotoRow): PlacePhotoDto {
    return {
      id: row.id,
      kind: row.kind,
      url: this.url(row.object_key),
      thumbnailUrl: this.url(row.thumb_key),
      width: row.width,
      height: row.height,
      createdAt: new Date(row.created_at).toISOString(),
      user: this.mapper.fromColumns(row),
    };
  }
}
