import { Controller, Get, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { CurrentUser, Public, type AuthUser } from '../common/decorators.js';
import { SearchUsersDto, UsernameAvailabilityDto } from './users.dto.js';
import { UsersService } from './users.service.js';

@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get('search')
  async search(@CurrentUser() user: AuthUser, @Query() query: SearchUsersDto) {
    return { items: await this.users.search(user.id, query.q) };
  }

  // used by the username picker and the email sign-up screen, so it works signed out too;
  // a valid token, when sent, makes your own username count as available
  @Public()
  @Get('availability')
  availability(@CurrentUser() user: AuthUser | undefined, @Query() query: UsernameAvailabilityDto, @Req() req: Request) {
    return this.users.checkUsername({ userId: user?.id, ip: req.ip }, query.username);
  }
}
