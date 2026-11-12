import { Module } from '@nestjs/common';
import { PlacesModule } from '../places/places.module.js';
import { ShareController } from './share.controller.js';

@Module({
  imports: [PlacesModule],
  controllers: [ShareController],
})
export class ShareModule {}
