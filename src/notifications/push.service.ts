import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Subscription } from 'rxjs';
import { DataSource, Repository } from 'typeorm';
import { DomainEvents } from '../common/domain-events.js';
import { PushDevice } from '../db/entities/push-device.entity.js';
import { ApnsClient, type PushMessage } from './apns.client.js';

/** What a notification is about; the app opens the matching screen when it is tapped. */
export type PushKind = 'friend-request' | 'friend-accepted' | 'nearby';

/**
 * The text is localised on the phone: `loc-key` names an entry of the app's Localizable strings and
 * `loc-args` fills its `%@`. The keys below must exist in the app's string catalog.
 */
const TEXT: Record<PushKind, { title: string; body: string }> = {
  'friend-request': { title: 'Friend request', body: '%@ wants to be friends' },
  'friend-accepted': { title: 'New friend', body: '%@ accepted your friend request' },
  nearby: { title: 'Friend nearby', body: '%@ is nearby' },
};

export function pushMessage(kind: PushKind, from: { id: string; name: string }): PushMessage {
  const text = TEXT[kind];
  return {
    payload: {
      aps: {
        alert: { 'title-loc-key': text.title, 'loc-key': text.body, 'loc-args': [from.name] },
        sound: 'default',
        'thread-id': kind === 'nearby' ? 'nearby' : 'friends',
      },
      kind,
      userId: from.id,
    },
    collapseId: `${kind}:${from.id}`,
  };
}

/**
 * Delivers pushes to every device of a person, and sends the friend-request ones when the social
 * module reports them. A failed push is only logged: notifications are best effort.
 */
@Injectable()
export class PushService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PushService.name);
  private subscription?: Subscription;

  constructor(
    @InjectRepository(PushDevice) private readonly devices: Repository<PushDevice>,
    private readonly db: DataSource,
    private readonly apns: ApnsClient,
    private readonly events: DomainEvents,
  ) {}

  onModuleInit() {
    this.subscription = this.events.events$.subscribe((event) => {
      const task =
        event.type === 'friend-requested'
          ? this.notifyAbout(event.toId, 'friend-request', event.fromId)
          : event.type === 'friend-accepted'
            ? this.notifyAbout(event.requesterId, 'friend-accepted', event.byId)
            : undefined;
      task?.catch((err: unknown) => this.logger.error(err instanceof Error ? err.message : err));
    });
  }

  onModuleDestroy() {
    this.subscription?.unsubscribe();
  }

  /** Tells `userId` that `fromId` did something, naming them the way their marker does. */
  async notifyAbout(userId: string, kind: PushKind, fromId: string): Promise<void> {
    if (!this.apns.enabled) return;
    const [from]: { display_name: string; username: string | null }[] = await this.db.query(
      `SELECT display_name, username FROM users WHERE id = $1 AND deleted_at IS NULL`,
      [fromId],
    );
    if (!from) return;
    const name = from.display_name || (from.username ? `@${from.username}` : 'A friend');
    await this.send(userId, pushMessage(kind, { id: fromId, name }));
  }

  async send(userId: string, message: PushMessage): Promise<void> {
    if (!this.apns.enabled) return;
    const devices = await this.devices.find({ where: { userId } });
    await Promise.all(
      devices.map(async (device) => {
        const result = await this.apns.send(device, message);
        // no token and no person: just enough to see in the log that a push went out
        this.logger.debug(`${String(message.payload.kind)} push to a ${device.environment} device: ${result}`);
        if (result === 'unregistered') await this.devices.delete({ token: device.token, userId });
      }),
    );
  }
}
