# iOS app brief

How to build the client for this backend. The product is in `product-spec.md`, the wire formats in `api-contract.md` and `live-protocol.md`. Read those two before writing any networking or model code.

## Start of the iOS session: settle these once

1. **Where the Xcode project lives.** Recommended: its own repo next to this one (`../place-rating-ios`), so the app repo gets its own README and demo recording (milestone 9). Putting it in `ios/` of this repo also works (Railway only builds the Node app).
2. **Open decisions 5–7** in `product-spec.md` are assumed defaults (Apple points of interest only, iOS 18+, Sign in with Apple only). Confirm them.
3. **Bundle identifier.** The backend verifies Apple identity tokens against `APPLE_BUNDLE_ID` (currently the placeholder `com.example.PlaceRating`, in `.env.example` and on Railway). The app's bundle id must equal it, so either use the placeholder or change the variable.
4. The owner is an experienced Flutter/NestJS developer new to native iOS. Explain SwiftUI/MapKit specifics briefly where they differ from Flutter, and keep the codebase portfolio-clean: small views, protocols at the seams, tests, a good README.

## Stack and rules

SwiftUI, **iOS 18+**, MapKit for SwiftUI (`Map`), Observation (`@Observable`), async/await, Swift Testing. **No third-party packages.** One screen, one view model, every outside dependency behind a protocol.

- Tokens go in the **Keychain**, never `UserDefaults`.
- Never log coordinates or tokens.
- No background location; sharing works only while the scene is active.
- Offline never queues writes: show a retry.

## Suggested structure

```text
PlaceRating/
  App/                PlaceRatingApp.swift, AppConfig (base URLs per build configuration)
  Models/             Codable types matching api-contract.md
  Services/           APIClient, AuthSession (Keychain, refresh), LiveSocket, LocationService
  Features/Map/       MapScreen, MapViewModel, FriendAnnotation, PlacePin, PulseRing
  Features/Sheets/    BrowseSheet, PlaceSheet, PlaceDetailSheet, ProfileSheet, PeopleSearch
  Resources/Avatars/  the 24 preset images, named by preset id
PlaceRatingTests/     MapViewModel with fakes, decoding fixtures, throttle rule
```

`MapViewModel` (`@Observable`) owns the camera position, the selected place, the friends dictionary keyed by user id, the rated places in view and the sheet state. Views only read it and call its methods. Protocols: `APIClientProtocol`, `LiveSocketProtocol`, `LocationServiceProtocol` with real and fake implementations (a `MockLiveSocket` that emits moving friends is milestone 6).

## Working against the backend in development

- **Run it locally** (see `CLAUDE.md`): `docker compose up -d`, `cp .env.example .env`, `npm run start:dev`. It listens on `http://localhost:3000` with `DEV_AUTH_ENABLED=true`.
- **Debug-only sign-in:** in `#if DEBUG`, a small field that calls `POST /auth/dev {"username":"alice"}` and stores the returned tokens like a real sign-in. Production has **no** dev login, and real Sign in with Apple needs the Apple capability, signing and a matching bundle id.
- **Two accounts, two simulators:** run alice and bob on two simulators (each has its own simulated location: Features → Location) to test live friends and ratings. Make them friends through the app or with curl.
- **Base URL per configuration:** Debug → `http://localhost:3000` / `ws://localhost:3000/live`; Release → `https://place-rating-api-production.up.railway.app` / `wss://…/live`. Plain `http` needs an App Transport Security exception for local development (`NSAllowsLocalNetworking`, Debug only).
- **Real device against your Mac:** use the Mac's LAN address, and set `AVATAR_PUBLIC_BASE_URL` in the backend `.env` to that same address, because avatar URLs in responses are built from it. The device may show the local-network permission prompt.
- The local avatar store (moto) forgets files when its container restarts; re-upload or pick a preset.

## Networking

`APIClient`: async/await over `URLSession`, a Bearer token, `Codable` models, one `APIError { status, code, message }` built from the error envelope. Switch on `code`, never on `message`.

**Dates.** The API sends ISO-8601 with milliseconds (`2026-11-11T06:54:12.345Z`), which `.iso8601` cannot decode:

```swift
extension JSONDecoder {
    static let api: JSONDecoder = {
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let plain = ISO8601DateFormatter()
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .custom { decoder in
            let string = try decoder.singleValueContainer().decode(String.self)
            if let date = fractional.date(from: string) ?? plain.date(from: string) { return date }
            throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath,
                                                    debugDescription: "Bad date: \(string)"))
        }
        return decoder
    }()
}
```

**Ids.** The server returns lowercase UUID strings and accepts any case. Swift's `UUID.uuidString` is uppercase, so either model ids as `String` or lowercase them before comparing or building keys.

**Models** mirror the "Shared types" block of `api-contract.md`. Traps: `username` is optional (nil until onboarding), `avatar.url` is nil for presets, `comment` and `category` are nullable, `heading` is nullable on the socket, `ts` on the socket is epoch milliseconds (not seconds).

**Auth session** (an `actor`, so refreshes are serialised):

1. Sign in with Apple: generate a random raw nonce, set `request.nonce` to its **SHA-256 hex**, then `POST /auth/apple { identityToken, nonce: <raw nonce>, fullName }`. The name is only available on the very first authorisation, so send it when present.
2. If `needsOnboarding` is true, show the username picker (`PATCH /me`, handle `409 username_taken`, `422 username_reserved`, validation).
3. Any `401` → one refresh → retry the request once. Refresh tokens **rotate**: store the new one in the Keychain before using the new access token, and never refresh in parallel (a reused refresh token revokes the whole session and forces a new sign-in). Failed refresh → signed out.
4. Sign out: `POST /auth/logout` with the refresh token, clear the Keychain.

**Places.** Selecting a built-in point of interest yields an `MKMapItem`; send `POST /places/resolve` with `appleId` (`MKMapItem.identifier`), name, coordinate and a category label, then use the returned place `id` for `GET /places/:id` and `PUT /places/:id/rating`. After the camera settles (debounce 400 ms) fetch `GET /places?bbox=…` for the visible region and draw pins only for `ratingCount > 0`. Check the current MapKit-for-SwiftUI docs for how a tapped feature becomes an `MKMapItem` (`MapSelection`, `MapFeature`, `MKMapItemRequest`) and for `MKMapItem.identifier`: both are iOS 18 APIs. SwiftUI `Map` has no built-in annotation clustering as far as known; start without it (a box returns at most 200 places) and decide later between grid clustering by span or wrapping `MKMapView`.

**Avatars.** Presets: render the bundled image named by `avatar.value`. Uploads: load `avatar.url` with `AsyncImage` over a shared `URLCache` (URLs are immutable). Photo flow: `PhotosPicker` → downscale to at most 1024 px JPEG → `POST /me/avatar/upload-url {contentType, contentLength}` → `PUT` the bytes to `uploadUrl` with exactly the returned headers and exactly that byte count → `POST /me/avatar/confirm {key}` → replace the cached `SelfUser`.

## Location and live socket

- `LocationService` wraps `CLLocationUpdate.liveUpdates()` and holds a `CLServiceSession(authorization: .whenInUse)` (iOS 18). Info.plist `NSLocationWhenInUseUsageDescription`: "Your location is shown to friends you accept, while the app is open." Show the app's own explanation screen before the system prompt. Publish a fix at most every 3 s and stop when the scene is not `.active`.
- `LiveSocket` (`URLSessionWebSocketTask`) and every sending/receiving rule, close-code handling and the reconnect schedule are in `live-protocol.md`. The two traps: **4409 means another connection took over, do not auto-reconnect**, and the token must be fresh at connect time.
- Friends dictionary: `hello` replaces, `loc` upserts, `gone` removes; a one-second ticker dims markers older than 30 s and drops those older than 60 s.
- Ghost toggle: send the `ghost` frame (or `PATCH /me {ghostMode}`) and trust the server's `ghost` confirmation; the "Sharing with N friends / Ghost mode on" pill always reflects it.

## Milestones (from the spec) as concrete steps

**6. Map shell**, done when it runs on a real device with fake friends moving: project and `AppConfig`; `Map` with your own pulsing avatar; location permission flow and the denied banner; floating controls and the status pill; bottom sheet with the Browse/Place/Profile states; `MockLiveSocket` driving friend annotations; `MapViewModel` tests with fakes.

**7. Joined to the API**, done when a rating made on one phone appears on a second device and a friend request sent by username can be accepted there: Keychain `AuthSession` and sign-in (dev login in Debug, Apple in Release); onboarding; places in view and `resolve`; the rating sheet (stars save on tap, comment on focus loss; the `PUT` is idempotent so retries are safe); friends' ratings first (group `GET /places/:id/ratings` by ids from `GET /friends`); profile sheet with preset and photo avatars; people search, requests, accept, remove; report and block actions can wait for 9 but the endpoints exist.

**8. Live friends**, done when two phones see each other move and sharing stops when backgrounded: swap the mock for the real `LiveSocket`; throttle (3 s, 10 m, 15 s heartbeat); reconnect and `hello` handling; avatar markers with dim/remove; ghost toggle; close on background.

**9. Polish**, done when a friend installs from TestFlight and completes the two-phone check unaided: report/block UI on every user, rating and avatar; empty and error states; terms acceptance at sign-up; account deletion in the profile sheet (`DELETE /me`); privacy labels and policy URL; README with a demo recording.

## Tests worth having

Decode every response type from JSON fixtures (capture real responses from the local backend with curl); the send-throttle rule (3 s, 10 m, 15 s heartbeat) as a pure function; the friends-dictionary reducer (`hello`/`loc`/`gone` and the 30/60 s staleness) as a pure function; `MapViewModel` with fake services; the refresh single-flight behaviour.
