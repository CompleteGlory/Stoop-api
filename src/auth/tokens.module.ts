import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { RefreshToken } from '../db/entities/refresh-token.entity.js';
import { User } from '../db/entities/user.entity.js';
import { OnboardingService } from './onboarding.service.js';
import { TokensService } from './tokens.service.js';

@Module({
  imports: [TypeOrmModule.forFeature([RefreshToken, User])],
  providers: [TokensService, OnboardingService],
  exports: [TokensService, OnboardingService],
})
export class TokensModule {}
