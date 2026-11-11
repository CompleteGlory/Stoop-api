import { Body, Controller, Delete, Get, HttpCode, Param, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { ApiError } from '../common/api-error.js';
import { CurrentUser, Public, type AuthUser } from '../common/decorators.js';
import { StorageService } from '../common/storage.service.js';
import { uuidPipe } from '../common/uuid-param.js';
import { CreatePhotoDto, ListPhotosDto, PhotoUploadUrlDto } from './photos.dto.js';
import { PhotosService } from './photos.service.js';

@Controller('places/:placeId/photos')
export class PlacePhotosController {
  constructor(private readonly photos: PhotosService) {}

  @Post('upload-url')
  @HttpCode(200)
  uploadUrl(
    @CurrentUser() user: AuthUser,
    @Param('placeId', uuidPipe) placeId: string,
    @Body() dto: PhotoUploadUrlDto,
  ) {
    return this.photos.createUploadUrl(user.id, placeId, dto.contentType, dto.contentLength);
  }

  @Post()
  create(@CurrentUser() user: AuthUser, @Param('placeId', uuidPipe) placeId: string, @Body() dto: CreatePhotoDto) {
    return this.photos.create(user.id, placeId, dto.kind, dto.key);
  }

  @Get()
  list(@CurrentUser() user: AuthUser, @Param('placeId', uuidPipe) placeId: string, @Query() query: ListPhotosDto) {
    return this.photos.list(placeId, user.id, query.kind, query.limit, query.cursor);
  }

  @Delete(':photoId')
  @HttpCode(204)
  async remove(
    @CurrentUser() user: AuthUser,
    @Param('placeId', uuidPipe) placeId: string,
    @Param('photoId', uuidPipe) photoId: string,
  ) {
    await this.photos.remove(user.id, placeId, photoId);
  }
}

const FILE_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(-t)?\.jpg$/;

/**
 * Serves processed photos. The bucket is private (Railway buckets cannot be public), so the API
 * streams them. A photo is never overwritten and each file name holds a random uuid, so responses
 * are cacheable forever. Only `photos/<place uuid>/<uuid>[-t].jpg` can be read; raw uploads stay unreachable.
 */
@Public()
@Controller('photos')
export class PhotoFilesController {
  constructor(private readonly storage: StorageService) {}

  @Get(':placeId/:file')
  async get(@Param('placeId', uuidPipe) placeId: string, @Param('file') file: string, @Res() res: Response) {
    if (!FILE_NAME.test(file)) throw ApiError.notFound('Photo');
    const bytes = await this.storage.getIfExists(`photos/${placeId.toLowerCase()}/${file}`);
    if (!bytes) throw ApiError.notFound('Photo');
    res
      .set({
        'Content-Type': 'image/jpeg',
        'Cache-Control': 'public, max-age=31536000, immutable',
        'X-Content-Type-Options': 'nosniff',
      })
      .send(bytes);
  }
}
