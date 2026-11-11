import { Body, Controller, Delete, Get, HttpCode, Param, Post } from '@nestjs/common';
import { CurrentUser, type AuthUser } from '../common/decorators.js';
import { uuidPipe } from '../common/uuid-param.js';
import { FriendsService } from './friends.service.js';
import { UserIdDto } from './social.dto.js';

@Controller('friends')
export class FriendsController {
  constructor(private readonly friends: FriendsService) {}

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.friends.list(user.id);
  }

  @Post('requests')
  @HttpCode(200)
  request(@CurrentUser() user: AuthUser, @Body() dto: UserIdDto) {
    return this.friends.request(user.id, dto.userId);
  }

  @Post('requests/:id/accept')
  @HttpCode(204)
  async accept(@CurrentUser() user: AuthUser, @Param('id', uuidPipe) id: string) {
    await this.friends.accept(user.id, id);
  }

  @Delete(':userId')
  @HttpCode(204)
  async remove(@CurrentUser() user: AuthUser, @Param('userId', uuidPipe) userId: string) {
    await this.friends.remove(user.id, userId);
  }
}
