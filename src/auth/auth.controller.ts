import { Body, Controller, HttpCode, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { Public } from '../common/decorators.js';
import { RateLimiter } from '../common/rate-limiter.service.js';
import { AppleSignInDto, DevLoginDto, RefreshDto } from './auth.dto.js';
import { AuthService } from './auth.service.js';
import { TokensService } from './tokens.service.js';

@Public()
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly tokens: TokensService,
    private readonly limiter: RateLimiter,
  ) {}

  @Post('apple')
  @HttpCode(200)
  async apple(@Body() dto: AppleSignInDto, @Req() req: Request) {
    await this.limiter.consume(`auth:${req.ip}`, 30, 60, 'sign-in attempts');
    return this.auth.signInWithApple(dto);
  }

  @Post('refresh')
  @HttpCode(200)
  async refresh(@Body() dto: RefreshDto, @Req() req: Request) {
    await this.limiter.consume(`auth:${req.ip}`, 30, 60, 'sign-in attempts');
    return this.auth.refresh(dto.refreshToken);
  }

  @Post('logout')
  @HttpCode(204)
  async logout(@Body() dto: RefreshDto) {
    await this.tokens.revokeByToken(dto.refreshToken);
  }

  /** Only answers when DEV_AUTH_ENABLED=true; otherwise it is a 404. */
  @Post('dev')
  @HttpCode(200)
  dev(@Body() dto: DevLoginDto) {
    return this.auth.devLogin(dto.username);
  }
}
