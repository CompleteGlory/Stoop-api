import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import { Block } from './entities/block.entity.js';
import { Friendship } from './entities/friendship.entity.js';
import { RefreshToken } from './entities/refresh-token.entity.js';
import { Report } from './entities/report.entity.js';
import { User } from './entities/user.entity.js';
import { InitSchema1700000000000 } from './migrations/1700000000000-init-schema.js';
import { CharactersAndPlacePhotos1794400000000 } from './migrations/1794400000000-characters-and-place-photos.js';
import { EmailAndGoogleSignIn1794500000000 } from './migrations/1794500000000-email-and-google-sign-in.js';

export const ENTITIES = [User, RefreshToken, Friendship, Block, Report];

@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => ({
        type: 'postgres' as const,
        url: config.databaseUrl,
        ssl: config.databaseSsl ? { rejectUnauthorized: false } : false,
        entities: ENTITIES,
        // Migrations are imported, not globbed: that works the same under tsc, vitest and ESM.
        migrations: [InitSchema1700000000000, CharactersAndPlacePhotos1794400000000, EmailAndGoogleSignIn1794500000000],
        migrationsRun: true,
        synchronize: false,
        logging: ['error' as const],
      }),
    }),
    TypeOrmModule.forFeature(ENTITIES),
  ],
  exports: [TypeOrmModule],
})
export class DatabaseModule {}
