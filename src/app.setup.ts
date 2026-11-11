import type { INestApplication } from '@nestjs/common';
import { TokensService } from './auth/tokens.service.js';
import { LiveWsAdapter } from './live/live.adapter.js';

/** Settings shared by `main.ts` and the end-to-end tests. */
export function setupApp(app: INestApplication) {
  // Railway and most hosts terminate TLS in front of the app; trust one proxy hop for `req.ip`
  app.getHttpAdapter().getInstance().set('trust proxy', 1);
  app.useWebSocketAdapter(new LiveWsAdapter(app, app.get(TokensService)));
  app.enableShutdownHooks();
  return app;
}
