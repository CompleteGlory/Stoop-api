import { Injectable } from '@nestjs/common';
import { Subject } from 'rxjs';

export type DomainEvent =
  /** Friendships or blocks between these users changed; live connections must recompute who can see whom. */
  | { type: 'relations-changed'; userIds: string[] }
  | { type: 'ghost-changed'; userId: string; on: boolean }
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
