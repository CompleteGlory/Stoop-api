import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { RefreshToken } from '../db/entities/refresh-token.entity.js';
import { TokensService } from './tokens.service.js';

@Module({
  imports: [TypeOrmModule.forFeature([RefreshToken])],
  providers: [TokensService],
  exports: [TokensService],
})
export class TokensModule {}
