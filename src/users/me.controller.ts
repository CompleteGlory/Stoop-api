import { Body, Controller, Delete, Get, HttpCode, Patch, Post } from '@nestjs/common';
import { AllowWithoutUsername, CurrentUser, type AuthUser } from '../common/decorators.js';
import { AvatarService } from './avatar.service.js';
import { AvatarConfirmDto, AvatarUploadUrlDto, UpdateMeDto } from './users.dto.js';
import { UsersService } from './users.service.js';

// onboarding happens here, and an account must be deletable before it is finished
@AllowWithoutUsername()
@Controller('me')
export class MeController {
  constructor(
    private readonly users: UsersService,
    private readonly avatars: AvatarService,
  ) {}

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

  @Post('avatar/upload-url')
  @HttpCode(200)
  uploadUrl(@CurrentUser() user: AuthUser, @Body() dto: AvatarUploadUrlDto) {
    return this.avatars.createUploadUrl(user.id, dto.contentType, dto.contentLength);
  }

  @Post('avatar/confirm')
  @HttpCode(200)
  async confirm(@CurrentUser() user: AuthUser, @Body() dto: AvatarConfirmDto) {
    await this.avatars.confirm(user.id, dto.key);
    return this.users.getSelf(user.id);
  }
}
