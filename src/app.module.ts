import { Module, ValidationPipe, type ValidationError } from '@nestjs/common';
import { APP_FILTER, APP_PIPE } from '@nestjs/core';
import { ApiError } from './common/api-error.js';
import { CoreModule } from './common/core.module.js';
import { ApiErrorFilter } from './common/error.filter.js';
import { ConfigModule } from './config/config.module.js';
import { DatabaseModule } from './db/database.module.js';
import { AuthModule } from './auth/auth.module.js';
import { HealthModule } from './health/health.module.js';
import { LegalModule } from './legal/legal.module.js';
import { LiveModule } from './live/live.module.js';
import { ModerationModule } from './moderation/moderation.module.js';
import { PhotosModule } from './photos/photos.module.js';
import { PlacesModule } from './places/places.module.js';
import { RedisModule } from './redis/redis.module.js';
import { SocialModule } from './social/social.module.js';
import { UsersModule } from './users/users.module.js';

function flatten(errors: ValidationError[], prefix = ''): string[] {
  return errors.flatMap((e) => {
    const path = prefix ? `${prefix}.${e.property}` : e.property;
    const own = Object.values(e.constraints ?? {}).map((m) => m);
    return [...own, ...flatten(e.children ?? [], path)];
  });
}

@Module({
  imports: [
    ConfigModule,
    RedisModule,
    DatabaseModule,
    CoreModule,
    AuthModule,
    UsersModule,
    PlacesModule,
    PhotosModule,
    SocialModule,
    ModerationModule,
    LiveModule,
    HealthModule,
    LegalModule,
  ],
  providers: [
    { provide: APP_FILTER, useClass: ApiErrorFilter },
    {
      provide: APP_PIPE,
      useValue: new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
        exceptionFactory: (errors) =>
          ApiError.badRequest('validation_failed', flatten(errors).join('; ') || 'Invalid request'),
      }),
    },
  ],
})
export class AppModule {}
