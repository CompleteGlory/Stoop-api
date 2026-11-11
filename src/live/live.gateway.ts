import type { IncomingMessage } from 'node:http';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
} from '@nestjs/websockets';
import type { WebSocket } from 'ws';
import { CLOSE, LiveService } from './live.service.js';
import { LIVE_PATH, LIVE_USER_ID } from './live.adapter.js';

/**
 * The /live socket. The adapter (see `live.adapter.ts`) has already
 * authenticated the upgrade request, so every socket here belongs to a person.
 */
@WebSocketGateway({ path: LIVE_PATH, maxPayload: 2048 })
export class LiveGateway implements OnGatewayConnection, OnGatewayDisconnect {
  constructor(private readonly live: LiveService) {}

  handleConnection(client: WebSocket, request: IncomingMessage) {
    const userId = (request as any)[LIVE_USER_ID] as string | undefined;
    if (!userId) {
      client.close(CLOSE.unauthorized, 'unauthorized');
      return;
    }
    this.live.connect(client, userId);
  }

  handleDisconnect(client: WebSocket) {
    return this.live.disconnect(client);
  }

  @SubscribeMessage('loc')
  loc(@ConnectedSocket() client: WebSocket, @MessageBody() body: unknown) {
    return this.live.handleLoc(client, body);
  }

  @SubscribeMessage('ghost')
  ghost(@ConnectedSocket() client: WebSocket, @MessageBody() body: unknown) {
    return this.live.handleGhost(client, body);
  }
}
