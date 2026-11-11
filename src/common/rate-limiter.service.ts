import { Injectable } from '@nestjs/common';
import { RedisService } from '../redis/redis.service.js';
import { ApiError } from './api-error.js';

/**
 * Fixed-window counters in Redis. The spec's limits are per user and per
 * hour or day (30 rating writes/h, 20 friend requests/day, 60 searches/h),
 * which a per-IP request throttler cannot express.
 */
@Injectable()
export class RateLimiter {
  constructor(private readonly redis: RedisService) {}

  /** Counts one hit and throws a 429 when `key` went over `limit` within `windowSec`. */
  async consume(key: string, limit: number, windowSec: number, what = 'requests') {
    const k = `rl:${key}`;
    const count = await this.redis.client.incr(k);
    if (count === 1) {
      await this.redis.client.expire(k, windowSec);
    } else if ((await this.redis.client.ttl(k)) < 0) {
      // the process died between INCR and EXPIRE earlier; do not leave a key that never resets
      await this.redis.client.expire(k, windowSec);
    }
    if (count > limit) {
      throw ApiError.rateLimited(`Too many ${what}, try again later`);
    }
  }
}
