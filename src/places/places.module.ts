import { Module } from '@nestjs/common';
import { PlacesController } from './places.controller.js';
import { PlacesService } from './places.service.js';
import { RatingsController } from '../ratings/ratings.controller.js';
import { RatingsService } from '../ratings/ratings.service.js';

@Module({
  controllers: [PlacesController, RatingsController],
  providers: [PlacesService, RatingsService],
  exports: [PlacesService],
})
export class PlacesModule {}
