import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PushDevice } from '../db/entities/push-device.entity.js';
import { ApnsClient, Http2ApnsClient } from './apns.client.js';
import { DevicesController } from './devices.controller.js';
import { NearbyService } from './nearby.service.js';
import { PushService } from './push.service.js';

/** Push notifications: device registration, friend-request pushes and "a friend is nearby" alerts. */
@Module({
  imports: [TypeOrmModule.forFeature([PushDevice])],
  controllers: [DevicesController],
  providers: [{ provide: ApnsClient, useClass: Http2ApnsClient }, PushService, NearbyService],
})
export class NotificationsModule {}
