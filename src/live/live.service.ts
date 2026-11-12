import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { Subscription } from 'rxjs';
import { DataSource } from 'typeorm';
import type { WebSocket } from 'ws';
import { DomainEvents, type DomainEvent } from '../common/domain-events.js';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import { RedisService } from '../redis/redis.service.js';
import { SocialGraph } from '../social/social-graph.service.js';
import { locKey, parseGhost, parseLoc, type LocPayload } from './live.protocol.js';

const OPEN = 1;

/** Close codes the app can act on (4000-4999 are free for applications). */
export const CLOSE = {
  badRequest: 4400,
  unauthorized: 4401,
  accountDeleted: 4403,
  replaced: 4409,
  tooManyMessages: 4429,
} as const;

const MAX_INVALID_MESSAGES = 10;
const FLOOD_WINDOW_MS = 10_000;
const FLOOD_MAX_MESSAGES = 60;
/** Every Nth ping tick the friend list of each connection is re-read, as a safety net for missed events. */
const FRIEND_REFRESH_EVERY_N_TICKS = 3;

interface Conn {
  userId: string;
  socket: WebSocket;
  /** Accepted, non-blocked friends: the only people who see this person and whom this person sees. */
  friends: Set<string>;
  ghost: boolean;
  lastLocAt: number;
  invalidCount: number;
  windowStart: number;
  windowCount: number;
  alive: boolean;
  closed: boolean;
  /** Messages can arrive while the connection is still loading its state; they wait for this. */
  ready: Promise<void>;
}

type OutFrame = { t: string; d: unknown };

/**
 * Live location sharing. A person's latest position lives only in Redis
 * (`loc:{userId}`, expiring after 60 s) and is pushed to the sockets of their
 * friends. Nothing is written to Postgres and no history is kept.
 *
 * Everything here is per process: with several API instances a person's
 * friends connected to another instance would not get the pushes. Fixing
 * that means publishing frames through Redis pub/sub, see the README.
 */
@Injectable()
export class LiveService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(LiveService.name);
  private readonly byUser = new Map<string, Conn>();
  private readonly bySocket = new WeakMap<WebSocket, Conn>();
  private subscription?: Subscription;
  private timer?: NodeJS.Timeout;
  private tick = 0;
  private stopping = false;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly redis: RedisService,
    private readonly db: DataSource,
    private readonly graph: SocialGraph,
    private readonly events: DomainEvents,
  ) {}

  onModuleInit() {
    this.subscription = this.events.events$.subscribe((event) => {
      this.onDomainEvent(event).catch((err) => this.logger.error(err));
    });
    this.timer = setInterval(() => this.heartbeat(), this.config.live.pingIntervalMs);
    this.timer.unref();
  }

  onModuleDestroy() {
    this.stopping = true;
    this.subscription?.unsubscribe();
    clearInterval(this.timer);
  }

  /** Number of open live connections (for tests and metrics). */
  get connectionCount() {
    return this.byUser.size;
  }

  // ---- connection lifecycle -------------------------------------------------------------

  connect(socket: WebSocket, userId: string) {
    const previous = this.byUser.get(userId);
    if (previous) {
      // one connection per person: the new one takes over, and friends keep seeing the last position
      previous.closed = true;
      this.byUser.delete(userId);
      previous.socket.close(CLOSE.replaced, 'replaced by a newer connection');
    }

    const conn: Conn = {
      userId,
      socket,
      friends: new Set(),
      ghost: false,
      lastLocAt: 0,
      invalidCount: 0,
      windowStart: Date.now(),
      windowCount: 0,
      alive: true,
      closed: false,
      ready: Promise.resolve(),
    };
    this.byUser.set(userId, conn);
    this.bySocket.set(socket, conn);
    socket.on('pong', () => (conn.alive = true));

    conn.ready = this.initialise(conn).catch((err) => {
      this.logger.error(`Could not start live session for ${userId}: ${err?.message ?? err}`);
      socket.close(1011, 'could not start');
    });
  }

  private async initialise(conn: Conn) {
    const rows: { ghost_mode: boolean }[] = await this.db.query(
      `SELECT ghost_mode FROM users WHERE id = $1 AND deleted_at IS NULL`,
      [conn.userId],
    );
    if (rows.length === 0) {
      conn.socket.close(CLOSE.unauthorized, 'unknown user');
      return;
    }
    conn.ghost = rows[0].ghost_mode;
    conn.friends = new Set(await this.graph.friendIds(conn.userId));

    const ids = [...conn.friends];
    const locs = await this.redis.mgetJson<LocPayload>(ids.map(locKey));
    const friends = ids.flatMap((id, i) => (locs[i] ? [{ userId: id, ...locs[i] }] : []));
    this.send(conn, { t: 'hello', d: { userId: conn.userId, ghost: conn.ghost, friends, serverTime: Date.now() } });
  }

  /** The socket closed, for any reason. */
  async disconnect(socket: WebSocket) {
    const conn = this.bySocket.get(socket);
    if (!conn) return;
    this.bySocket.delete(socket);
    if (conn.closed) return; // replaced: the newer connection owns the state now
    conn.closed = true;
    if (this.byUser.get(conn.userId) === conn) this.byUser.delete(conn.userId);

    await this.redis.del(locKey(conn.userId)).catch((err) => this.logger.error(err));
    this.fanOut(conn, { t: 'gone', d: { userId: conn.userId } });
  }

  // ---- messages from the client ---------------------------------------------------------

  async handleLoc(socket: WebSocket, raw: unknown) {
    const conn = await this.readyConn(socket);
    if (!conn || !this.countMessage(conn)) return;

    const parsed = parseLoc(raw, Date.now());
    if (!parsed.ok) return this.reject(conn, parsed.code, parsed.message);
    if (conn.ghost) return;

    const now = Date.now();
    if (now - conn.lastLocAt < this.config.live.minLocIntervalMs) return; // too soon: drop silently
    conn.lastLocAt = now;

    const key = locKey(conn.userId);
    await this.redis.setJson(key, parsed.value, this.config.live.locTtlSec);
    if (conn.ghost || conn.closed) {
      // ghost mode or a disconnect happened while we were writing
      await this.redis.del(key);
      return;
    }
    this.fanOut(conn, { t: 'loc', d: { userId: conn.userId, ...parsed.value } });
    this.events.emit({ type: 'live-position', userId: conn.userId, lat: parsed.value.lat, lng: parsed.value.lng });
  }

  async handleGhost(socket: WebSocket, raw: unknown) {
    const conn = await this.readyConn(socket);
    if (!conn || !this.countMessage(conn)) return;

    const parsed = parseGhost(raw);
    if (!parsed.ok) return this.reject(conn, parsed.code, parsed.message);

    await this.db.query(`UPDATE users SET ghost_mode = $2 WHERE id = $1`, [conn.userId, parsed.value.on]);
    await this.applyGhost(conn, parsed.value.on);
  }

  private async readyConn(socket: WebSocket): Promise<Conn | undefined> {
    const conn = this.bySocket.get(socket);
    if (!conn || conn.closed) return undefined;
    await conn.ready;
    return conn.closed ? undefined : conn;
  }

  private countMessage(conn: Conn): boolean {
    conn.alive = true;
    const now = Date.now();
    if (now - conn.windowStart > FLOOD_WINDOW_MS) {
      conn.windowStart = now;
      conn.windowCount = 0;
    }
    if (++conn.windowCount > FLOOD_MAX_MESSAGES) {
      conn.socket.close(CLOSE.tooManyMessages, 'too many messages');
      return false;
    }
    return true;
  }

  private reject(conn: Conn, code: string, message: string) {
    this.send(conn, { t: 'error', d: { code, message } });
    if (++conn.invalidCount > MAX_INVALID_MESSAGES) {
      conn.socket.close(CLOSE.badRequest, 'too many invalid messages');
    }
  }

  // ---- changes made elsewhere (REST) ----------------------------------------------------

  private async onDomainEvent(event: DomainEvent) {
    switch (event.type) {
      case 'relations-changed':
        await Promise.all(event.userIds.map((id) => this.refreshFriends(id)));
        break;
      case 'ghost-changed': {
        const conn = this.byUser.get(event.userId);
        if (conn) await this.applyGhost(conn, event.on);
        break;
      }
      case 'user-deleted':
        await this.dropUser(event.userId, event.friendIds);
        break;
      default:
        break; // handled elsewhere
    }
  }

  private async applyGhost(conn: Conn, on: boolean) {
    conn.ghost = on;
    if (on) {
      await this.redis.del(locKey(conn.userId));
      this.fanOut(conn, { t: 'gone', d: { userId: conn.userId } });
    }
    this.send(conn, { t: 'ghost', d: { on } });
  }

  /**
   * Recomputes who this connection may see after a friendship or block
   * changed. People who dropped out disappear from the map; people who were
   * added show up at once with their current position.
   */
  private async refreshFriends(userId: string) {
    const conn = this.byUser.get(userId);
    if (!conn) return;
    await conn.ready;
    if (conn.closed) return;

    const next = new Set(await this.graph.friendIds(userId));
    const removed = [...conn.friends].filter((id) => !next.has(id));
    const added = [...next].filter((id) => !conn.friends.has(id));
    conn.friends = next;

    for (const id of removed) this.send(conn, { t: 'gone', d: { userId: id } });
    if (added.length > 0) {
      const locs = await this.redis.mgetJson<LocPayload>(added.map(locKey));
      added.forEach((id, i) => {
        if (locs[i]) this.send(conn, { t: 'loc', d: { userId: id, ...locs[i]! } });
      });
      // and show the newcomers where this person is, if they are already sharing
      const mine = await this.redis.getJson<LocPayload>(locKey(userId));
      if (mine && !conn.ghost) {
        for (const id of added) {
          const other = this.byUser.get(id);
          if (other?.friends.has(userId)) this.send(other, { t: 'loc', d: { userId, ...mine } });
        }
      }
    }
  }

  private async dropUser(userId: string, formerFriendIds: string[]) {
    await this.redis.del(locKey(userId));
    for (const id of formerFriendIds) {
      const other = this.byUser.get(id);
      if (other) this.send(other, { t: 'gone', d: { userId } });
    }
    this.byUser.get(userId)?.socket.close(CLOSE.accountDeleted, 'account deleted');
  }

  // ---- helpers --------------------------------------------------------------------------

  /** Sends a frame to every connected friend of `from` who can see them too. */
  private fanOut(from: Conn, frame: OutFrame) {
    for (const friendId of from.friends) {
      const other = this.byUser.get(friendId);
      if (other && other.friends.has(from.userId)) this.send(other, frame);
    }
  }

  private send(conn: Conn, frame: OutFrame) {
    if (conn.socket.readyState !== OPEN) return;
    conn.socket.send(JSON.stringify(frame));
  }

  private heartbeat() {
    this.tick++;
    for (const conn of this.byUser.values()) {
      if (!conn.alive) {
        conn.socket.terminate(); // no pong since the last ping: the 'close' handler cleans up
        continue;
      }
      conn.alive = false;
      conn.socket.ping();
    }
    if (this.tick % FRIEND_REFRESH_EVERY_N_TICKS === 0) {
      for (const userId of this.byUser.keys()) {
        this.refreshFriends(userId).catch((err) => {
          // a query cut off by shutdown is expected; anything else is worth knowing about
          if (!this.stopping) this.logger.error(err);
        });
      }
    }
  }
}
