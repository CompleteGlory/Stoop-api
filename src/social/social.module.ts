import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Block } from '../db/entities/block.entity.js';
import { Friendship } from '../db/entities/friendship.entity.js';
import { BlocksController } from './blocks.controller.js';
import { BlocksService } from './blocks.service.js';
import { FriendsController } from './friends.controller.js';
import { FriendsService } from './friends.service.js';

@Module({
  imports: [TypeOrmModule.forFeature([Friendship, Block])],
  controllers: [FriendsController, BlocksController],
  providers: [FriendsService, BlocksService],
})
export class SocialModule {}
