import { Body, Controller, Delete, Get, HttpCode, Param, Put, Query } from '@nestjs/common';
import { CurrentUser, type AuthUser } from '../common/decorators.js';
import { uuidPipe } from '../common/uuid-param.js';
import { PutRatingDto } from './ratings.dto.js';
import { RatingsService } from './ratings.service.js';

@Controller('places/:placeId')
export class RatingsController {
  constructor(private readonly ratings: RatingsService) {}

  @Put('rating')
  put(
    @CurrentUser() user: AuthUser,
    @Param('placeId', uuidPipe) placeId: string,
    @Body() dto: PutRatingDto,
  ) {
    return this.ratings.put(user.id, placeId, dto);
  }

  @Delete('rating')
  @HttpCode(204)
  async remove(@CurrentUser() user: AuthUser, @Param('placeId', uuidPipe) placeId: string) {
    await this.ratings.remove(user.id, placeId);
  }

  @Get('ratings')
  list(
    @CurrentUser() user: AuthUser,
    @Param('placeId', uuidPipe) placeId: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    return this.ratings.listForPlace(placeId, user.id, limit, cursor);
  }
}
