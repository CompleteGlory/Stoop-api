import { Module } from '@nestjs/common';
import { PhotoFilesController, PlacePhotosController } from './photos.controller.js';
import { PhotosService } from './photos.service.js';

@Module({
  controllers: [PlacePhotosController, PhotoFilesController],
  providers: [PhotosService],
})
export class PhotosModule {}
