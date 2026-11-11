@AGENTS.md

# Place Rating

A one-screen iOS MapKit app: friends see each other move on a map (Snapchat-map style, friends only) and everyone rates places by tapping them. **This repository is the backend** (NestJS REST API + live-location WebSocket). The SwiftUI app is the next thing to build and has not been started.

## Status

- Backend: spec milestones 1–5 are done, tested and **deployed** at `https://place-rating-api-production.up.railway.app` (Railway project `wholesome-perfection`: services `place-rating-api`, `PostGIS`, `Redis`, bucket `shelved-wrap`). Every push to `main` redeploys.
- iOS app: milestones 6–9 to do. Start with `docs/ios-app-brief.md`.
- Production has **no dev sign-in**. `APPLE_BUNDLE_ID` on Railway is the app's real bundle id, `com.magdzaky.PlaceRating`. For development run the backend locally (below).

## Docs: read before working on the matching area

| File | Read it when |
| --- | --- |
| `docs/ios-app-brief.md` | Building or changing the iOS app: structure, auth, networking pitfalls, dev workflow, milestone steps |
| `docs/api-contract.md` | Writing any request/response model or call: every route, shape, status code, error code, rate limit |
| `docs/live-protocol.md` | Touching location sharing: WebSocket frames, close codes, client throttle, reconnect and staleness rules |
| `docs/data-model.md` | Touching the database, Redis keys, storage layout or deletion behaviour |
| `docs/product-spec.md` | Needing product intent: screens, privacy and App Review rules, build order, open decisions |
| `docs/operations.md` | Deploying, running locally, moderation SQL, known gaps |
| `README.md` | Architecture and data-flow diagrams, quick start |

The code is the source of truth (`src/**/*.controller.ts`, `*.dto.ts`, `test/*.e2e-spec.ts`); the docs describe it and `docs/api-contract.md` lists where the original spec differs.

## Commands

```bash
docker compose up -d     # Postgres+PostGIS (host 5433), Redis, moto fake S3 (9000)
cp .env.example .env     # DEV_AUTH_ENABLED=true for local sign-in via POST /auth/dev
npm install
npm run start:dev        # http://localhost:3000, migrations run on startup
npm test                 # unit tests, no services needed
npm run test:e2e         # real Postgres/Redis/S3-mock/sockets (needs docker compose)
npm run lint             # oxlint, type-aware
npm run smoke            # black-box check of the running dev server, ~65 checks
```

Run `npm test && npm run test:e2e && npm run lint` before pushing a backend change.

## Architecture in one minute

One NestJS 12 process serves REST and a `ws` WebSocket at `/live`. Postgres+PostGIS holds durable data (users, places, ratings, friendships, blocks, reports, refresh tokens). Redis holds the live position of each user (`loc:{userId}`, 60 s TTL), rate-limit counters and revoked-token markers. A private S3-compatible bucket holds avatar photos, which the API serves itself at `GET /avatars/...`. REST changes that affect the live graph (friend accepted, block, ghost, deletion) reach the socket side through the in-process `DomainEvents` bus. Diagrams are in `README.md`.

```text
src/
  config/ db/ redis/ common/   typed env, entities + migration, Redis client, errors/limiter/pagination/events
  auth/ users/ places/ ratings/ social/ moderation/ live/ health/
test/                          e2e specs (REST, avatars, live sockets); src/**/*.spec.ts are unit tests
scripts/smoke.mjs              black-box smoke test
docs/                          the docs above
```

## Rules that must not break

1. Every error is `{ "error": { "code", "message" } }`; throw `ApiError.*`, keep codes stable and document new ones in `docs/api-contract.md`.
2. Live location lives only in Redis with a 60 s expiry. Never write it to Postgres, never keep history, never log coordinates.
3. Only accepted, non-blocked friends see each other, and only while the sender is not in ghost mode. Blocks hide both people everywhere.
4. A rating write locks the place row, upserts the rating and recomputes the place average in one transaction. `PUT /places/:id/rating` stays idempotent.
5. Clients can create places but never change or delete them.
6. `DEV_AUTH_ENABLED` must never be on in production (the config refuses to boot). No secrets in git; `.env` is ignored.
7. The bucket stays private. Photos are re-encoded to a 256 px JPEG (EXIF stripped) before they are served.
8. One live connection per user, and one API instance (live fan-out is in memory).
9. Account deletion anonymises the user row and removes ratings, friendships, blocks, sessions and the photo, then recomputes averages.
10. A username is mandatory: without one, only `/me` and `/users/availability` work (`403 username_required`) and `/live` refuses the upgrade. A username can change but never be cleared.

## Backend conventions

- ESM only: relative imports end in `.js`, no `__dirname` (use `import.meta.dirname`), tests are Vitest (`vi.fn()`).
- Controllers are thin; logic is in services; DTO classes use class-validator under a global `ValidationPipe` (`whitelist`, `forbidNonWhitelisted`). Path ids go through `uuidPipe`.
- Places and ratings use raw SQL (PostGIS, `FOR UPDATE`, aggregates); the other tables use TypeORM repositories.
- New environment variables go through `src/config/app-config.ts` (validated at startup), `.env.example` and `docs/operations.md`.
- Per-user limits use `RateLimiter.consume`; cross-module side effects use `DomainEvents`.
- Schema changes need a **new** migration listed in `src/db/database.module.ts`; never edit `1700000000000-init-schema.ts` (production ran it).
- A behaviour change ships with its test and with updates to `docs/api-contract.md` / the README tables in the same commit.

## When the iOS app needs something from the API

Prefer adapting the client. If the API has to change: write the failing e2e test, change the backend, update `docs/api-contract.md`, run the checks above, push to `main` (Railway redeploys), and say so in the commit message so the client work can follow.

## Working with the owner

Magd is an experienced Flutter/NestJS developer new to native iOS. Explain SwiftUI/MapKit specifics briefly where they differ from Flutter, keep the app a clean portfolio project (small views, protocols at the seams, tests, a README with a demo), and ask before choosing between real alternatives. Spec open decisions 5–7 (Apple points of interest only, iOS 18+, Sign in with Apple only) are assumed defaults, not confirmed.

## Known gaps

No Apple token revocation on account deletion, no CI, no admin UI for reports, single API instance only, unconfirmed avatar uploads are never cleaned up. Details in `docs/operations.md`.
