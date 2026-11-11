import { Body, Controller, Delete, Get, HttpCode, Patch } from '@nestjs/common';
import { AllowWithoutUsername, CurrentUser, type AuthUser } from '../common/decorators.js';
import { UpdateMeDto } from './users.dto.js';
import { UsersService } from './users.service.js';

// onboarding happens here, and an account must be deletable before it is finished
@AllowWithoutUsername()
@Controller('me')
export class MeController {
  constructor(private readonly users: UsersService) {}

  @Get()
  get(@CurrentUser() user: AuthUser) {
    return this.users.getSelf(user.id);
  }

  @Patch()
  update(@CurrentUser() user: AuthUser, @Body() dto: UpdateMeDto) {
    return this.users.updateSelf(user.id, dto);
  }

  @Delete()
  @HttpCode(204)
  async remove(@CurrentUser() user: AuthUser) {
    await this.users.deleteSelf(user.id);
  }
}
