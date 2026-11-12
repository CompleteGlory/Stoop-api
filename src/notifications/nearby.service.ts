import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import type { Subscription } from 'rxjs';
import { DataSource } from 'typeorm';
import { ApiError } from '../common/api-error.js';
import { DomainEvents, type DomainEvent } from '../common/domain-events.js';
import { RateLimiter } from '../common/rate-limiter.service.js';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import { locKey, type LocPayload } from '../live/live.protocol.js';
import { RedisService } from '../redis/redis.service.js';
import { SocialGraph } from '../social/social-graph.service.js';
import { coarse, distanceM, type Point } from './geo.js';
import { PushService } from './push.service.js';

/** A background position: coarse, only the latest, kept in Redis for `nearby.positionTtlSec`. */
interface NearPosition extends Point {
  ts: number;
}

export const nearKey = (userId: string) => `near:${userId}`;
const checkKey = (userId: string) => `nearby-check:${userId}`;
const pairKey = (a: string, b: string) => (a < b ? `nearby-pair:${a}:${b}` : `nearby-pair:${b}:${a}`);
/** A person moving with the app open sends a position every few seconds; they are checked once a minute. */
const CHECK_EVERY_SEC = 60;

/**
 * "A friend is nearby" pushes. Positions come from the live socket (the app is open) and from
 * background reports (`POST /me/position`, only for people who switched the alerts on). When two
 * accepted, non-blocked friends who are not in ghost mode are within `nearby.radiusM`, each one who
 * has the alerts on gets a push, at most once per pair per `nearby.cooldownSec`.
 *
 * Background positions never reach other people: they are only compared here. Nothing goes to
 * Postgres and coordinates are never logged.
 */
@Injectable()
export class NearbyService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(NearbyService.name);
  private subscription?: Subscription;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly db: DataSource,
    private readonly redis: RedisService,
    private readonly graph: SocialGraph,
    private readonly push: PushService,
    private readonly limiter: RateLimiter,
    private readonly events: DomainEvents,
  ) {}

  onModuleInit() {
    this.subscription = this.events.events$.subscribe((event) => {
      this.onEvent(event).catch((err: unknown) => this.logger.error(err instanceof Error ? err.message : err));
    });
  }

  onModuleDestroy() {
    this.subscription?.unsubscribe();
  }

  private async onEvent(event: DomainEvent) {
    switch (event.type) {
      case 'live-position':
        await this.check(event.userId, event);
        break;
      case 'ghost-changed':
        if (event.on) await this.redis.del(nearKey(event.userId));
        break;
      case 'nearby-alerts-off':
      case 'user-deleted':
        await this.redis.del(nearKey(event.userId));
        break;
      default:
        break;
    }
  }

  /** A background position from the app. Ghost mode makes it a no-op; alerts off is an error so the app stops. */
  async report(userId: string, point: Point): Promise<void> {
    await this.limiter.consume(`position:${userId}`, 120, 3600, 'position reports');
    const [me]: { ghost_mode: boolean; nearby_alerts: boolean }[] = await this.db.query(
      `SELECT ghost_mode, nearby_alerts FROM users WHERE id = $1 AND deleted_at IS NULL`,
      [userId],
    );
    if (!me) throw ApiError.notFound('User');
    if (!me.nearby_alerts) {
      throw ApiError.conflict('nearby_alerts_off', 'Turn on nearby alerts before reporting a position');
    }
    if (me.ghost_mode) return;

    const position: NearPosition = { lat: coarse(point.lat), lng: coarse(point.lng), ts: Date.now() };
    await this.redis.setJson(nearKey(userId), position, this.config.nearby.positionTtlSec);
    await this.check(userId, position);
  }

  /** Compares one person's position with their friends' and sends the pushes that are due. */
  async check(userId: string, here: Point): Promise<void> {
    // live positions arrive every few seconds; once a minute is enough
    const first = await this.redis.client.set(checkKey(userId), '1', 'EX', CHECK_EVERY_SEC, 'NX');
    if (first !== 'OK') return;

    const friendIds = await this.graph.friendIds(userId);
    if (friendIds.length === 0) return;

    const people: { id: string; ghost_mode: boolean; nearby_alerts: boolean }[] = await this.db.query(
      `SELECT id, ghost_mode, nearby_alerts FROM users WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL`,
      [[userId, ...friendIds]],
    );
    const byId = new Map(people.map((p) => [p.id, p]));
    const me = byId.get(userId);
    if (!me || me.ghost_mode) return;

    // only friends where at least one side wants the alert, and who are visible at all
    const candidates = friendIds.filter((id) => {
      const friend = byId.get(id);
      return friend && !friend.ghost_mode && (me.nearby_alerts || friend.nearby_alerts);
    });
    if (candidates.length === 0) return;

    const [live, background] = await Promise.all([
      this.redis.mgetJson<LocPayload>(candidates.map(locKey)),
      this.redis.mgetJson<NearPosition>(candidates.map(nearKey)),
    ]);

    await Promise.all(
      candidates.map(async (friendId, i) => {
        const there = live[i] ?? background[i];
        if (!there || distanceM(here, there) > this.config.nearby.radiusM) return;

        const fresh = await this.redis.client.set(
          pairKey(userId, friendId),
          '1',
          'EX',
          this.config.nearby.cooldownSec,
          'NX',
        );
        if (fresh !== 'OK') return;

        const friend = byId.get(friendId)!;
        await Promise.all([
          me.nearby_alerts ? this.push.notifyAbout(userId, 'nearby', friendId) : undefined,
          friend.nearby_alerts ? this.push.notifyAbout(friendId, 'nearby', userId) : undefined,
        ]);
      }),
    );
  }
}
