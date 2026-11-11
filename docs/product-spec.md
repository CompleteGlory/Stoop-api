# Product spec (digest)

Condensed from the design doc "Place Rating Map App — Design Spec" (a Claude Doc, 2026-11-11, not stored in this repo). Where the shipped backend differs from that doc, `api-contract.md` wins.

## What it is

A one-screen iOS app where small groups of friends (2–10, same city) see each other moving on a map and rate places by tapping them. The map is the whole app; everything else is a sheet or an overlay.

**Done means:** two phones on two accounts: each sees the other's avatar moving, and a rating made on one phone shows up on the other.

### v1 goals

- Tap any point of interest on the map and rate it 1–5 stars with an optional short comment.
- See friends as avatar markers that move in near real time.
- Every user has a display name and an avatar: a DiceBear character they build (style, hair, face, outfit and colours).
- Anyone can add photos of a place or its menu.
- Sharing is under the user's control: friends only, with a ghost-mode switch.

### Non-goals for v1

Chat, stories, discovery of strangers. Background location (sharing works only while the app is open). Android, iPad layouts, web client.

## The screen

The map fills the display, small controls float above it, a bottom sheet carries every detail.

**Map layers**

- You: your own avatar with a soft pulse ring instead of the system blue dot.
- Friends: 44 pt avatar circles with the name underneath; dim after 30 s without an update, gone after 60 s.
- Rated places: pins showing the average stars, clustered when zoomed out.
- Points of interest: Apple's own labels, tappable to select.

**Floating controls**

- Top left: your avatar opens the profile sheet.
- Top right: eye button toggles ghost mode, a recenter button under it.
- A pill under the status bar reads "Sharing with 4 friends" or "Ghost mode on", so sharing is never invisible.

**Bottom sheet**

| State | Detent | Shows |
| --- | --- | --- |
| Browse | Peek, about 120 pt | Search field with a Places / People switch, and a row of friend avatars (tap one to center the map on that friend) |
| Place selected | Medium | Name, category, average stars and count, your star control, comment field, friends' ratings first |
| Place details | Large | Every rating, newest first, with report and block actions |
| Profile | Medium | Display name, avatar (edit the DiceBear character), ghost mode, who you are sharing with |

A rating saves the moment a star is tapped; the comment saves when its field loses focus.

**Edge states**

- Location denied: banner "Turn on location to share with friends" with a Settings button. Map and ratings still work.
- Offline: banner, friend markers dim. The star control shows a retry instead of queueing the rating.
- No friends yet: the peek sheet shows a "Find friends" prompt that opens username search.
- Loading places: no spinner; pins fade in as results arrive.

## Privacy, safety and App Review

Live location is the riskiest feature; defaults are conservative and the user can always see and stop sharing.

- **Location:** When In Use only. Show an explanation screen before the system prompt. Purpose string: "Your location is shown to friends you accept, while the app is open." Stop sending and close the socket when the app leaves the foreground. No location history; logs must never contain coordinates.
- **Who sees what:** only accepted friends see live position; a request needs acceptance. Ghost mode removes you from every friend's map immediately. A block removes both people from each other's map, friend list and rating details. Friends are found by username search only (never email or Apple ID; 3+ characters; skips blocked users).
- **User-generated content** (ratings, comments, place photos) needs, for App Review: terms of use accepted at sign-up; a report action on every user, rating and photo; a block action on every user; a way to act on reports quickly (check the `reports` table daily); a support contact address.
- **Account and data:** in-app account deletion (`DELETE /me`). Honest privacy labels: precise location linked to the user and used for app functionality, plus user content and identifiers. Publish a privacy policy URL before TestFlight external testing.
- **Place photos:** JPEG/PNG up to 10 MB, real file type checked on the server, EXIF stripped (it can carry GPS), only re-encoded copies are served. Avatars are drawn characters, so no personal photos are stored.
- **Apple also expects** the Sign in with Apple token to be revoked on account deletion; this backend does not do that yet (see `operations.md`, "Known gaps").

## Build order

Backend first, then the client against a mocked socket, then the two joined.

| # | Milestone | Done when | Status |
| --- | --- | --- | --- |
| 1 | API skeleton: NestJS, docker-compose, `/health`, Sign in with Apple, `GET /me` | Valid Apple token returns your profile; CI runs lint and tests | **Done** (CI not set up) |
| 2 | Places and ratings: resolve, bbox query, idempotent rating PUT with aggregates | Two users rate one place, average correct, bbox returns it | **Done** |
| 3 | Friends and moderation: search, requests, accept, remove, blocks, reports, deletion | Blocked user cannot be found nor see the other's rating details/friend status | **Done** |
| 4 | Avatars and photos: DiceBear character validation; place and menu photos with presigned upload, file checks, EXIF stripping, thumbnails | JPEG with GPS comes back with none; a non-image is rejected; an unknown character option is rejected | **Done** (reworked 2026-11-11 from preset and photo avatars) |
| 5 | Live gateway: WS auth, hello, loc fan-out, 60 s TTL, ghost, gone | Friend receives `loc`; `gone` on ghost and on disconnect | **Done** |
| 6 | iOS map shell: map, location permission, own avatar, bottom sheet, mock friends | Runs on a real device with fake friends moving | To do |
| 7 | iOS + API joined: sign-in, places in view, rating sheet, character screen and profile, people search and friend requests | A rating made on the phone appears on a second device; a request by username can be accepted there | To do |
| 8 | iOS live friends: LiveSocket, avatar markers, ghost toggle, dim and remove on stale | Two phones see each other move; sharing stops when backgrounded | To do |
| 9 | Polish: report/block UI, empty and error states, README with demo recording, TestFlight build | A friend installs from TestFlight and completes the two-phone check unaided | To do |

## Decisions

| # | Decision | Answer |
| --- | --- | --- |
| 1 | Who sees live location | Friends only |
| 2 | How friends are added | Search by username |
| 3 | Avatars | DiceBear characters only (changed 2026-11-11 from presets plus photo upload); photo uploads are for places and menus |
| 4 | Whose ratings the map shows | Everyone's average |
| 5 | Place source | Apple points of interest only (**assumed default**, not confirmed) |
| 6 | Minimum iOS | iOS 18 (**assumed default**) |
| 7 | Sign-in | Sign in with Apple only (**assumed default**) |
| 8 | Data access in NestJS | TypeORM with raw SQL (**assumed default**; implemented) |
| 9 | Hosting | Railway (implemented and live) |
| 10 | What to build first | Backend first (done) |

Rows 5–7 still need the owner's confirmation before the iOS work depends on them; ask once at the start of the iOS session.
