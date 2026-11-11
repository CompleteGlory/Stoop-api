import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import sharp from 'sharp';
import { Repository } from 'typeorm';
import { ApiError } from '../common/api-error.js';
import { RateLimiter } from '../common/rate-limiter.service.js';
import { User } from '../db/entities/user.entity.js';
import { StorageService } from './storage.service.js';

export const MAX_AVATAR_BYTES = 5 * 1024 * 1024;
export const AVATAR_SIZE_PX = 256;
export const ALLOWED_AVATAR_TYPES = ['image/jpeg', 'image/png'] as const;

/**
 * Photo avatars: the app uploads straight to the bucket with a presigned URL,
 * then asks the server to confirm. Confirming re-encodes the picture as a
 * 256 px JPEG, which also strips EXIF data such as GPS coordinates.
 */
@Injectable()
export class AvatarService {
  constructor(
    @InjectRepository(User) private readonly users: Repository<User>,
    private readonly storage: StorageService,
    private readonly limiter: RateLimiter,
  ) {}

  async createUploadUrl(userId: string, contentType: string, contentLength: number) {
    await this.limiter.consume(`avatar-upload:${userId}`, 10, 3600, 'avatar uploads');
    const key = `uploads/${userId}/${randomUUID()}`;
    const uploadUrl = await this.storage.presignPut(key, contentType, contentLength);
    return {
      key,
      uploadUrl,
      method: 'PUT' as const,
      headers: { 'Content-Type': contentType },
      expiresIn: 300,
    };
  }

  async confirm(userId: string, uploadKey: string) {
    if (!uploadKey.startsWith(`uploads/${userId}/`)) {
      throw ApiError.badRequest('invalid_key', 'That upload does not belong to you');
    }

    const size = await this.storage.size(uploadKey);
    if (size === null) throw ApiError.notFound('Upload');
    if (size > MAX_AVATAR_BYTES) {
      await this.storage.delete(uploadKey);
      throw ApiError.unprocessable('image_too_large', 'Pictures can be at most 5 MB');
    }

    const original = await this.storage.get(uploadKey);
    let processed: Buffer;
    try {
      const image = sharp(original, { limitInputPixels: 40_000_000 });
      const meta = await image.metadata();
      if (meta.format !== 'jpeg' && meta.format !== 'png') {
        throw new Error('unsupported format');
      }
      processed = await image
        .rotate() // apply the EXIF orientation before it is dropped
        .resize(AVATAR_SIZE_PX, AVATAR_SIZE_PX, { fit: 'cover' })
        .jpeg({ quality: 85 }) // sharp keeps no metadata unless asked to
        .toBuffer();
    } catch {
      await this.storage.delete(uploadKey);
      throw ApiError.unprocessable('invalid_image', 'Upload a JPEG or PNG picture');
    }

    const avatarKey = `avatars/${userId}/${randomUUID()}.jpg`;
    await this.storage.put(avatarKey, processed, 'image/jpeg');
    await this.storage.delete(uploadKey);

    const user = await this.users.findOneByOrFail({ id: userId });
    const previous = user.avatarKind === 'upload' ? user.avatarValue : null;
    await this.users.update({ id: userId }, { avatarKind: 'upload', avatarValue: avatarKey });
    if (previous) await this.storage.delete(previous);

    return { kind: 'upload' as const, value: avatarKey };
  }

  /** Called when the avatar is replaced by a preset or the account is deleted. */
  async deleteUploaded(user: Pick<User, 'avatarKind' | 'avatarValue'>) {
    if (user.avatarKind === 'upload') await this.storage.delete(user.avatarValue);
  }
}
