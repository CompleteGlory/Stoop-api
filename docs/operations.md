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
APPLE_BUNDLE_ID=com.magdzaky.PlaceRating
S3_ENDPOINT=https://t3.storageapi.dev
S3_REGION=${{shelved-wrap.REGION}}
S3_BUCKET=${{shelved-wrap.BUCKET}}
S3_ACCESS_KEY_ID=${{shelved-wrap.ACCESS_KEY_ID}}
S3_SECRET_ACCESS_KEY=${{shelved-wrap.SECRET_ACCESS_KEY}}
S3_FORCE_PATH_STYLE=false
AVATAR_PUBLIC_BASE_URL=https://${{RAILWAY_PUBLIC_DOMAIN}}   # old name of PUBLIC_BASE_URL, still read
```

Sign-in settings: `GOOGLE_CLIENT_IDS` (the iOS OAuth client id from Google Cloud; empty turns Google sign-in off) and, for email sign-in, `EMAIL_AUTH_ENABLED=true` with either `MAIL_PROVIDER=resend`, `RESEND_API_KEY` and `MAIL_FROM` (an address on a domain verified in Resend), or `MAIL_PROVIDER=brevo`, `BREVO_API_KEY` and `MAIL_FROM` (`Name <address>`, the address verified as a sender in Brevo; a Gmail address works without a domain, though some codes may land in spam). Brevo's Authorized IPs blocking must stay off, because Railway's outbound addresses change. The config refuses `MAIL_PROVIDER=log` there, because codes in the log would let anyone with log access take accounts. `PUBLIC_BASE_URL` is the API's own public address (photo URLs are built from it); Railway still has it under its old name `AVATAR_PUBLIC_BASE_URL`, which is read as a fallback. Never set `DEV_AUTH_ENABLED` (the server refuses to boot with it in production) or `S3_AUTO_CREATE_BUCKET` (ignored in production). `SUPPORT_EMAIL` is the contact address on the `/terms` and `/privacy` pages (it defaults to the owner's address). `PORT` is injected by Railway.

Checks after a deploy: `GET /health` → `{"status":"ok","db":"up","redis":"up"}`; `GET /me` without a token → 401 error envelope; an unknown photo URL such as `/photos/<any uuid>/<any uuid>.jpg` → 404 (proves the bucket credentials work). The smoke script cannot run against production, because it signs in through `/auth/dev`.

`APPLE_BUNDLE_ID` must equal the iOS app's bundle id, or `POST /auth/apple` returns 401 for every real token.

Apple settings beyond the bundle id:

- `APPLE_TEAM_ID` (the 10-character team id, `W4D7HW9L4Y`) turns on universal links: the API serves `/.well-known/apple-app-site-association` so shared place links open in the app.
- `APPLE_KEY_ID` and `APPLE_PRIVATE_KEY` turn on token revocation, which App Review expects. Create a key with Sign in with Apple enabled under Certificates, Identifiers & Profiles > Keys and paste the `.p8` contents (one line with `\n` works). With them, `POST /auth/apple` exchanges the app's `authorizationCode` for an Apple refresh token, and `DELETE /me` revokes it. Without them both steps are skipped. A failure is logged as a warning and never blocks sign-in or deletion. Accounts that signed in before the key was set have no stored token; they get one at their next sign-in.
- `APNS_KEY_ID` and `APNS_PRIVATE_KEY` turn on push notifications (friend requests, accepts, nearby friends); they need `APPLE_TEAM_ID` too. Create a key under Certificates, Identifiers & Profiles > Keys with **Apple Push Notifications service (APNs)** enabled (one key can have both APNs and Sign in with Apple; then the same id and `.p8` go in both pairs) and paste the `.p8` contents. The topic is `APPLE_BUNDLE_ID`. The same key works for the sandbox (Xcode builds) and production (TestFlight, App Store); each device says which it is. Without the key devices still register and nothing is sent. APNs failures are logged as `APNs answered <status> (<reason>)`, never with the token.
- `NEARBY_RADIUS_M` (500), `NEARBY_COOLDOWN_SEC` (10800) and `NEARBY_POSITION_TTL_SEC` (1800) tune the nearby alerts; the defaults are what the app's settings text promises, so change them together.

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

The moto container keeps files in memory: place photos vanish on `docker compose restart s3`.

## Runbook

- **Reports (moderation):** there is no admin UI. `SELECT * FROM reports WHERE status = 'open' ORDER BY created_at;` then act (delete the rating, delete the photo row and its two files under `photos/`, block/ban) and `UPDATE reports SET status = 'actioned' | 'dismissed' WHERE id = …`. App Review expects reports to be handled quickly; check daily.
- **Database access:** use the `PostGIS` service's connect options in the Railway dashboard (public TCP proxy or the CLI), or run SQL from the dashboard's Data tab.
- **Rotating `JWT_SECRET`:** all access tokens become invalid at once (clients refresh with their refresh tokens, which are random values in the database and unaffected).
- **Schema changes:** add a new migration class under `src/db/migrations/` and list it in `src/db/database.module.ts`. Never edit `1700000000000-init-schema.ts`: production already ran it. Migrations run at startup, before the health check passes.
- **Health degraded:** `/health` returns 503 with which of `db`/`redis` is down. The API restarts on failure up to 5 times.
- **Costs:** Railway usage-based billing for four services plus bucket storage ($0.015 per GB-month). A place photo is about 150–400 KB plus a 20–40 KB thumbnail.

## Known gaps

- **Single instance only for live location.** Fan-out to friends' sockets happens in the process that holds them; with several instances, friends on another instance miss pushes. The fix is publishing frames through Redis pub/sub (positions are already in Redis, so `hello` would work everywhere).
- **Unconfirmed uploads** under `uploads/` are never cleaned up (Railway buckets have no lifecycle rules). Add a scheduled cleanup before the app has many users.
- **Photo traffic goes through the API.** Responses are cacheable forever, so each photo is fetched once per device; put a CDN in front of `GET /photos/...` if that ever matters.
- **No CI** yet (milestone 1 of the spec asks for lint and tests on every push). **No admin tool** for reports. **Logs:** the WebSocket adapter logs an error per oversized frame, so a logged-in client can spam the logs.
- **Untested against real services:** real Sign in with Apple tokens (the e2e tests replace `AppleVerifier`; `src/auth/apple-verifier.ts` is the only code that talks to Apple), anything on iOS, and more than one API instance.
