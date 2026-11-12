import { Injectable } from '@nestjs/common';
import { Subject } from 'rxjs';

export type DomainEvent =
  /** Friendships or blocks between these users changed; live connections must recompute who can see whom. */
  | { type: 'relations-changed'; userIds: string[] }
  | { type: 'ghost-changed'; userId: string; on: boolean }
  /** The person switched "a friend is nearby" alerts off: forget their background position. */
  | { type: 'nearby-alerts-off'; userId: string }
  /** `fromId` sent `toId` a new friend request. */
  | { type: 'friend-requested'; fromId: string; toId: string }
  /** `byId` accepted the request `requesterId` had sent. */
  | { type: 'friend-accepted'; byId: string; requesterId: string }
  /** A live (socket) position came in. Stays in process; coordinates are never logged. */
  | { type: 'live-position'; userId: string; lat: number; lng: number }
  /** `friendIds` are the friends the user had before deletion, so they can be told the marker is gone. */
  | { type: 'user-deleted'; userId: string; friendIds: string[] }
  /** A deleted account had signed in with Apple: its Apple token should be revoked. */
  | { type: 'apple-token-revoke'; refreshToken: string };

/**
 * A tiny in-process event bus. It lets the REST side tell the live
 * (WebSocket) side that something changed without the two modules
 * importing each other.
 */
@Injectable()
export class DomainEvents {
  private readonly subject = new Subject<DomainEvent>();
  readonly events$ = this.subject.asObservable();

  emit(event: DomainEvent) {
    this.subject.next(event);
  }
}
