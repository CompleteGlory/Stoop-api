import { Controller, Get, Param, Res } from '@nestjs/common';
import type { Response } from 'express';
import { ApiError } from '../common/api-error.js';
import { Public } from '../common/decorators.js';
import { uuidPipe } from '../common/uuid-param.js';
import { StorageService } from './storage.service.js';

const FILE_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jpg$/;

/**
 * Serves the processed avatar photos. Some buckets (Railway's, for one) are private, so instead of the
 * app fetching from a public bucket URL the API streams the picture itself. Each file name holds a random
 * uuid and a photo is never overwritten, so responses can be cached forever. Only keys of the exact form
 * `avatars/<user uuid>/<uuid>.jpg` can be read; uploads that are still unchecked stay unreachable.
 */
@Public()
@Controller('avatars')
export class AvatarFilesController {
  constructor(private readonly storage: StorageService) {}

  @Get(':userId/:file')
  async get(@Param('userId', uuidPipe) userId: string, @Param('file') file: string, @Res() res: Response) {
    if (!FILE_NAME.test(file)) throw ApiError.notFound('Avatar');
    const bytes = await this.storage.getIfExists(`avatars/${userId.toLowerCase()}/${file}`);
    if (!bytes) throw ApiError.notFound('Avatar');
    res
      .set({
        'Content-Type': 'image/jpeg',
        'Cache-Control': 'public, max-age=31536000, immutable',
        'X-Content-Type-Options': 'nosniff',
      })
      .send(bytes);
  }
}
