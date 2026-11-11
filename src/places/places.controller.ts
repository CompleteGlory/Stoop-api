import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { CurrentUser, type AuthUser } from '../common/decorators.js';
import { uuidPipe } from '../common/uuid-param.js';
import { parseBBox } from './bbox.js';
import { ResolvePlaceDto } from './places.dto.js';
import { PlacesService } from './places.service.js';

@Controller('places')
export class PlacesController {
  constructor(private readonly places: PlacesService) {}

  @Get()
  async list(@Query('bbox') bbox: string) {
    return { items: await this.places.inBBox(parseBBox(bbox)) };
  }

  @Post('resolve')
  @HttpCode(200)
  resolve(@CurrentUser() user: AuthUser, @Body() dto: ResolvePlaceDto) {
    return this.places.resolve(user.id, dto);
  }

  @Get(':id')
  get(@CurrentUser() user: AuthUser, @Param('id', uuidPipe) id: string) {
    return this.places.get(id, user.id);
  }
}
