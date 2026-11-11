import { Controller, Get, Query } from '@nestjs/common';
import { AllowWithoutUsername, CurrentUser, type AuthUser } from '../common/decorators.js';
import { SearchUsersDto, UsernameAvailabilityDto } from './users.dto.js';
import { UsersService } from './users.service.js';

@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get('search')
  async search(@CurrentUser() user: AuthUser, @Query() query: SearchUsersDto) {
    return { items: await this.users.search(user.id, query.q) };
  }

  // used by the username picker, so it has to work before a username exists
  @AllowWithoutUsername()
  @Get('availability')
  availability(@CurrentUser() user: AuthUser, @Query() query: UsernameAvailabilityDto) {
    return this.users.checkUsername(user.id, query.username);
  }
}
