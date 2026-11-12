import { Body, Controller, Delete, HttpCode, Param, PipeTransform, Post, Put } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ApiError } from '../common/api-error.js';
import { CurrentUser, type AuthUser } from '../common/decorators.js';
import { PushDevice } from '../db/entities/push-device.entity.js';
import { NearbyService } from './nearby.service.js';
import {
  DEVICE_TOKEN_PATTERN,
  MAX_POSITION_ACCURACY_M,
  RegisterDeviceDto,
  ReportPositionDto,
} from './notifications.dto.js';

const deviceTokenPipe: PipeTransform<string, string> = {
  transform(value: string) {
    const token = String(value).toLowerCase();
    if (!DEVICE_TOKEN_PATTERN.test(token)) {
      throw ApiError.badRequest('invalid_device_token', 'The device token must be the hex APNs token');
    }
    return token;
  },
};

@Controller('me')
export class DevicesController {
  constructor(
    @InjectRepository(PushDevice) private readonly devices: Repository<PushDevice>,
    private readonly nearby: NearbyService,
  ) {}

  /** Registers this phone for pushes. A token already used by another account moves to this one. */
  @Put('devices/:token')
  @HttpCode(204)
  async register(
    @CurrentUser() user: AuthUser,
    @Param('token', deviceTokenPipe) token: string,
    @Body() dto: RegisterDeviceDto,
  ) {
    await this.devices.upsert({ token, userId: user.id, environment: dto.environment }, ['token']);
  }

  /** Stops pushes to this phone, such as at sign-out. Idempotent; only the owner's token is removed. */
  @Delete('devices/:token')
  @HttpCode(204)
  async unregister(@CurrentUser() user: AuthUser, @Param('token', deviceTokenPipe) token: string) {
    await this.devices.delete({ token, userId: user.id });
  }

  /** A background position, used only to tell friends they are near each other. */
  @Post('position')
  @HttpCode(204)
  async report(@CurrentUser() user: AuthUser, @Body() dto: ReportPositionDto) {
    if (dto.accuracy > MAX_POSITION_ACCURACY_M) {
      throw ApiError.unprocessable('accuracy_too_low', `accuracy worse than ${MAX_POSITION_ACCURACY_M} m is not used`);
    }
    await this.nearby.report(user.id, { lat: dto.lat, lng: dto.lng });
  }
}
