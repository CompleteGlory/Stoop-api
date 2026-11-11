import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TokensModule } from '../auth/tokens.module.js';
import { User } from '../db/entities/user.entity.js';
import { AvatarFilesController } from './avatar-files.controller.js';
import { AvatarService } from './avatar.service.js';
import { MeController } from './me.controller.js';
import { StorageService } from './storage.service.js';
import { UsersController } from './users.controller.js';
import { UsersService } from './users.service.js';

@Module({
  imports: [TypeOrmModule.forFeature([User]), TokensModule],
  controllers: [MeController, UsersController, AvatarFilesController],
  providers: [UsersService, AvatarService, StorageService],
  exports: [UsersService, AvatarService, StorageService],
})
export class UsersModule {}
