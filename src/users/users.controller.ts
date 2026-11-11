import { Controller, Get, Query } from '@nestjs/common';
import { CurrentUser, type AuthUser } from '../common/decorators.js';
import { SearchUsersDto } from './users.dto.js';
import { UsersService } from './users.service.js';

@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get('search')
  async search(@CurrentUser() user: AuthUser, @Query() query: SearchUsersDto) {
    return { items: await this.users.search(user.id, query.q) };
  }
}
