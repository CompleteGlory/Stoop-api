import { Body, Controller, HttpCode, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { Public } from '../common/decorators.js';
import { RateLimiter } from '../common/rate-limiter.service.js';
import {
  AppleSignInDto,
  DevLoginDto,
  EmailCodeDto,
  EmailDto,
  EmailPasswordDto,
  GoogleSignInDto,
  PasswordResetDto,
  RefreshDto,
} from './auth.dto.js';
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

  @Post('google')
  @HttpCode(200)
  async googleSignIn(@Body() dto: GoogleSignInDto, @Req() req: Request) {
    await this.limiter.consume(`auth:${req.ip}`, 30, 60, 'sign-in attempts');
    return this.auth.signInWithGoogle(dto.idToken);
  }

  /** Sends a 6-digit code. `202` whether or not the address has an account. */
  @Post('email/signup')
  @HttpCode(202)
  async emailSignUp(@Body() dto: EmailPasswordDto, @Req() req: Request) {
    await this.limiter.consume(`auth:${req.ip}`, 30, 60, 'sign-in attempts');
    await this.auth.emailSignUp(dto.email, dto.password);
  }

  @Post('email/resend')
  @HttpCode(202)
  async emailResend(@Body() dto: EmailDto, @Req() req: Request) {
    await this.limiter.consume(`auth:${req.ip}`, 30, 60, 'sign-in attempts');
    await this.auth.emailResend(dto.email);
  }

  @Post('email/verify')
  @HttpCode(200)
  async emailVerify(@Body() dto: EmailCodeDto, @Req() req: Request) {
    await this.limiter.consume(`auth:${req.ip}`, 30, 60, 'sign-in attempts');
    return this.auth.emailVerify(dto.email, dto.code);
  }

  @Post('email/signin')
  @HttpCode(200)
  async emailSignIn(@Body() dto: EmailPasswordDto, @Req() req: Request) {
    await this.limiter.consume(`auth:${req.ip}`, 30, 60, 'sign-in attempts');
    return this.auth.emailSignIn(dto.email, dto.password);
  }

  @Post('password/forgot')
  @HttpCode(202)
  async passwordForgot(@Body() dto: EmailDto, @Req() req: Request) {
    await this.limiter.consume(`auth:${req.ip}`, 30, 60, 'sign-in attempts');
    await this.auth.passwordForgot(dto.email);
  }

  @Post('password/reset')
  @HttpCode(200)
  async passwordReset(@Body() dto: PasswordResetDto, @Req() req: Request) {
    await this.limiter.consume(`auth:${req.ip}`, 30, 60, 'sign-in attempts');
    return this.auth.passwordReset(dto.email, dto.code, dto.newPassword);
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
