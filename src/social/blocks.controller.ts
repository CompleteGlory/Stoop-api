import { Body, Controller, Delete, Get, HttpCode, Param, Post } from '@nestjs/common';
import { CurrentUser, type AuthUser } from '../common/decorators.js';
import { uuidPipe } from '../common/uuid-param.js';
import { BlocksService } from './blocks.service.js';
import { UserIdDto } from './social.dto.js';

@Controller('blocks')
export class BlocksController {
  constructor(private readonly blocks: BlocksService) {}

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.blocks.list(user.id);
  }

  @Post()
  @HttpCode(204)
  async block(@CurrentUser() user: AuthUser, @Body() dto: UserIdDto) {
    await this.blocks.block(user.id, dto.userId);
  }

  @Delete(':userId')
  @HttpCode(204)
  async unblock(@CurrentUser() user: AuthUser, @Param('userId', uuidPipe) userId: string) {
    await this.blocks.unblock(user.id, userId);
  }
}
