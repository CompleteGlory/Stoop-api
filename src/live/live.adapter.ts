import type { IncomingMessage } from 'node:http';
import type { INestApplicationContext } from '@nestjs/common';
import { WsAdapter } from '@nestjs/platform-ws';
import { TokensService } from '../auth/tokens.service.js';
import { parseFrame } from './live.protocol.js';

export const LIVE_PATH = '/live';
/** Property the upgrade check sets on the request so the gateway knows who connected. */
export const LIVE_USER_ID = 'liveUserId';

type VerifyCallback = (verified: boolean, code?: number, message?: string) => void;

/**
 * The stock WebSocket adapter with two changes: it speaks the app's
 * `{ "t": type, "d": data }` frames, and it checks the access token while the
 * connection is still an HTTP upgrade, so an unauthenticated client gets a
 * plain 401 and never becomes a socket.
 */
export class LiveWsAdapter extends WsAdapter {
  constructor(
    app: INestApplicationContext,
    private readonly tokens: TokensService,
  ) {
    super(app);
    this.setMessageParser((data) => parseFrame(data));
  }

  override create(port: number, options: Record<string, any> = {}) {
    return super.create(port, {
      ...options,
      verifyClient: (info: { req: IncomingMessage }, done: VerifyCallback) => {
        const match = info.req.headers.authorization?.match(/^Bearer\s+(.+)$/i);
        if (!match) return done(false, 401, 'Unauthorized');
        this.tokens.verifyAccessToken(match[1]).then(
          (userId) => {
            (info.req as any)[LIVE_USER_ID] = userId;
            done(true);
          },
          () => done(false, 401, 'Unauthorized'),
        );
      },
    });
  }
}
