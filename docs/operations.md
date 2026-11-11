# Operations

## Production (Railway)

One Railway project (`wholesome-perfection`, environment `production`) with four services:

| Service | What | Notes |
| --- | --- | --- |
| `place-rating-api` | This repo, built from `main` by Railway (GitHub app installed on `CompleteGlory`, limited to this repo) | `railway.json`: `npm run build`, start `node dist/main.js`, health check `/health`, restart on failure. **Every push to `main` redeploys.** Public URL `https://place-rating-api-production.up.railway.app`, region US West |
| `PostGIS` | Community "PostGIS" template running `postgis/postgis:17-3.5` with a volume | Provides `DATABASE_URL` over the private network |
| `Redis` | Railway Redis with a volume | Provides `REDIS_URL` |
| `shelved-wrap` | Railway Storage Bucket (private, S3-compatible, EU West) | Variables `BUCKET`, `REGION`, `ENDPOINT`, `ACCESS_KEY_ID`, `SECRET_ACCESS_KEY`; no lifecycle rules, cannot be made public |

Variables on the API service (references are `${{Service.VAR}}`; no secret is typed by hand):

```text
NODE_ENV=production
DATABASE_URL=${{PostGIS.DATABASE_URL}}
REDIS_URL=${{Redis.REDIS_URL}}
JWT_SECRET=${{ secret(64) }}
APPLE_BUNDLE_ID=com.example.PlaceRating        # PLACEHOLDER, set the real bundle id
S3_ENDPOINT=https://t3.storageapi.dev
S3_REGION=${{shelved-wrap.REGION}}
S3_BUCKET=${{shelved-wrap.BUCKET}}
S3_ACCESS_KEY_ID=${{shelved-wrap.ACCESS_KEY_ID}}
S3_SECRET_ACCESS_KEY=${{shelved-wrap.SECRET_ACCESS_KEY}}
S3_FORCE_PATH_STYLE=false
AVATAR_PUBLIC_BASE_URL=https://${{RAILWAY_PUBLIC_DOMAIN}}
```

Never set `DEV_AUTH_ENABLED` (the server refuses to boot with it in production) or `S3_AUTO_CREATE_BUCKET` (ignored in production). `PORT` is injected by Railway.

Checks after a deploy: `GET /health` → `{"status":"ok","db":"up","redis":"up"}`; `GET /me` without a token → 401 error envelope; an unknown avatar URL → 404 (proves the bucket credentials work). The smoke script cannot run against production, because it signs in through `/auth/dev`.

**Before the iOS app can sign in:** set `APPLE_BUNDLE_ID` to the app's real bundle id. Until then `POST /auth/apple` returns 401 for every real token.

## Local development

```bash
docker compose up -d        # Postgres+PostGIS (host port 5433), Redis (6379), moto fake S3 (9000)
cp .env.example .env
npm install
npm run start:dev           # http://localhost:3000, migrations run on startup
```

| Command | What |
| --- | --- |
| `npm test` | Unit tests (no services) |
| `npm run test:e2e` | End-to-end against real Postgres/Redis/S3-mock and real sockets (needs `docker compose up -d`; uses database `placerating_test` and Redis db 1) |
| `npm run lint` | oxlint with type-aware rules |
| `npm run smoke` | Black-box check of a running dev server: every route and the live socket, ~65 checks, writes `scripts/smoke-report.txt`. Needs `DEV_AUTH_ENABLED=true`; `--skip-slow` skips the 45 s dead-connection check |
| `npm run build && npm run start:prod` | Production build |

The moto container keeps files in memory: avatar photos vanish on `docker compose restart s3`.

## Runbook

- **Reports (moderation):** there is no admin UI. `SELECT * FROM reports WHERE status = 'open' ORDER BY created_at;` then act (delete the rating, remove the avatar by setting the user to a preset, block/ban) and `UPDATE reports SET status = 'actioned' | 'dismissed' WHERE id = …`. App Review expects reports to be handled quickly; check daily.
- **Database access:** use the `PostGIS` service's connect options in the Railway dashboard (public TCP proxy or the CLI), or run SQL from the dashboard's Data tab.
- **Rotating `JWT_SECRET`:** all access tokens become invalid at once (clients refresh with their refresh tokens, which are random values in the database and unaffected).
- **Schema changes:** add a new migration class under `src/db/migrations/` and list it in `src/db/database.module.ts`. Never edit `1700000000000-init-schema.ts`: production already ran it. Migrations run at startup, before the health check passes.
- **Health degraded:** `/health` returns 503 with which of `db`/`redis` is down. The API restarts on failure up to 5 times.
- **Costs:** Railway usage-based billing for four services plus bucket storage ($0.015 per GB-month). A 256 px avatar is 10–20 KB.

## Known gaps

- **Apple token revocation on account deletion** is not implemented. App Review expects the person's Sign in with Apple token to be revoked (Apple's `/auth/revoke`, which needs a client secret signed with your Apple developer key). Deleting an account only removes data on our side.
- **Single instance only for live location.** Fan-out to friends' sockets happens in the process that holds them; with several instances, friends on another instance miss pushes. The fix is publishing frames through Redis pub/sub (positions are already in Redis, so `hello` would work everywhere).
- **Unconfirmed uploads** under `uploads/` are never cleaned up (Railway buckets have no lifecycle rules). Add a scheduled cleanup before the app has many users.
- **Avatar traffic goes through the API.** Responses are cacheable forever, so each photo is fetched once per device; put a CDN in front of `GET /avatars/...` if that ever matters.
- **No CI** yet (milestone 1 of the spec asks for lint and tests on every push). **No admin tool** for reports. **Logs:** the WebSocket adapter logs an error per oversized frame, so a logged-in client can spam the logs.
- **Untested against real services:** real Sign in with Apple tokens (the e2e tests replace `AppleVerifier`; `src/auth/apple-verifier.ts` is the only code that talks to Apple), anything on iOS, and more than one API instance.
