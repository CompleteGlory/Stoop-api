import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { TypeOrmModule } from '@nestjs/typeorm';
import { User } from '../db/entities/user.entity.js';
import { UsersModule } from '../users/users.module.js';
import { AppleVerifier, JoseAppleVerifier } from './apple-verifier.js';
import { AuthController } from './auth.controller.js';
import { AuthGuard } from './auth.guard.js';
import { AuthService } from './auth.service.js';
import { TokensModule } from './tokens.module.js';

@Module({
  imports: [TypeOrmModule.forFeature([User]), TokensModule, UsersModule],
  controllers: [AuthController],
  providers: [
    AuthService,
    { provide: AppleVerifier, useClass: JoseAppleVerifier },
    // every route needs a valid access token unless it is marked @Public()
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
  exports: [TokensModule],
})
export class AuthModule {}
