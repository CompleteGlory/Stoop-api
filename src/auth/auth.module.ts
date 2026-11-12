import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { TypeOrmModule } from '@nestjs/typeorm';
import { User } from '../db/entities/user.entity.js';
import { UsersModule } from '../users/users.module.js';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import { LogMailer, Mailer, ResendMailer } from '../mail/mailer.js';
import { AppleVerifier, JoseAppleVerifier } from './apple-verifier.js';
import { AppleRevoker, AppleTokenClient, HttpAppleTokenClient } from './apple-tokens.js';
import { EmailCodesService } from './email-codes.service.js';
import { GoogleVerifier, JoseGoogleVerifier } from './google-verifier.js';
import { AuthController } from './auth.controller.js';
import { AuthGuard } from './auth.guard.js';
import { AuthService } from './auth.service.js';
import { TokensModule } from './tokens.module.js';

@Module({
  imports: [TypeOrmModule.forFeature([User]), TokensModule, UsersModule],
  controllers: [AuthController],
  providers: [
    AuthService,
    EmailCodesService,
    { provide: AppleVerifier, useClass: JoseAppleVerifier },
    { provide: AppleTokenClient, useClass: HttpAppleTokenClient },
    AppleRevoker,
    { provide: GoogleVerifier, useClass: JoseGoogleVerifier },
    {
      provide: Mailer,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) =>
        config.email.provider === 'resend' ? new ResendMailer(config) : new LogMailer(),
    },
    // every route needs a valid access token unless it is marked @Public()
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
  exports: [TokensModule],
})
export class AuthModule {}
