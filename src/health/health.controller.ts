import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { Public } from '../common/decorators.js';
import { RedisService } from '../redis/redis.service.js';

@Public()
@Controller('health')
export class HealthController {
  constructor(
    private readonly db: DataSource,
    private readonly redis: RedisService,
  ) {}

  /** For the host's health check: 200 only when both Postgres and Redis answer. */
  @Get()
  async check() {
    const [db, redis] = await Promise.all([
      this.db.query('SELECT 1').then(() => 'up', () => 'down'),
      this.redis.ping().then((ok) => (ok ? 'up' : 'down'), () => 'down'),
    ]);
    const status = db === 'up' && redis === 'up' ? 'ok' : 'degraded';
    if (status !== 'ok') {
      throw new ServiceUnavailableException({ status, db, redis });
    }
    return { status, db, redis };
  }
}
