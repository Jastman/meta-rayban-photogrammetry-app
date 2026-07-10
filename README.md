# Meta Ray-Ban photogrammetry prototype (v1)

Runnable local prototype showing the product shape:

- **Glasses web HUD** (`apps/glasses-web`): exact 600x600, no-scroll camera guidance UI with keyboard/D-pad navigation.
- **BFF/API** (`apps/server`): capture sessions, photo quality guidance, reconstruction job submission, polling, and transition-only SSE status updates.
- **iOS companion** (`apps/ios-companion`): directly openable SwiftUI/Xcode app using official Meta DAT 0.8.0 patterns, Mock Device Kit, real JPEG capture, BFF synchronization, and local completion notifications.
- **Native companion contract** (`packages/native-companion-contract`): shared TypeScript bridge contract aligned with the iOS JPEG upload.

## Quick start

```bash
npm install
npm run dev
```

Open http://localhost:8787

For the iPhone/Simulator companion, follow [`apps/ios-companion/README.md`](apps/ios-companion/README.md). Run the mock path first; physical-iPhone setup requires Meta AI Developer Mode, Xcode signing, and an ignored local xcconfig.

## Environment configuration

Create `.env` values in your shell before starting:

```bash
export CESIUM_ION_TOKEN=...                 # optional in prototype
export CESIUM_ION_API_URL=https://api.cesium.com
export ALLOW_MOCK_RESULTS=true              # default true
export ENABLE_LIVE_ION_SUBMISSION=false     # default false
```

Behavior:

- No token + `ALLOW_MOCK_RESULTS=true` → explicit **mock** reconstruction completion (`completed_mock`).
- No token + `ALLOW_MOCK_RESULTS=false` → explicit **blocked** (`blocked_no_credentials`).
- Token present + `ENABLE_LIVE_ION_SUBMISSION=true` → server submits a live Cesium ion Gaussian Splat reconstruction job, polls ion status, and maps to `queued` / `processing` / `completed` with `result.provider="ion"` metadata.
- Token present + `ENABLE_LIVE_ION_SUBMISSION=false` + `mode=ion`/auto-live request → request fails explicitly; enable live submission first.

Live-mode caveat:

- If ion returns `405 MethodNotAllowed` with payload like `{"code":"MethodNotAllowed","message":"POST is not allowed"}` on `POST /v1/reality-capture/gaussian-splats/jobs`, this account/path likely does not expose direct public photo reconstruction. Use explicit mock mode until a supported ion/partner endpoint is provided, and verify token scope includes `assets:write`.

## Implemented API contract

- `POST /api/capture-sessions`
- `GET /api/capture-sessions/:sessionId`
- `POST /api/capture-sessions/:sessionId/photos` (single photo or `{ photos: [...] }` batch)
- `POST /api/capture-sessions/:sessionId/photos/upload` (`image/jpeg` body from native companion)
- `POST /api/reconstruction-jobs` (alias: `/api/assets/jobs`)
- `GET /api/reconstruction-jobs/:jobId` (alias: `/api/assets/jobs/:jobId`)
- `GET /api/reconstruction-jobs/:jobId/events` (SSE; alias: `/api/assets/jobs/:jobId/events`)
- `GET /api/config`
- `GET /api/health`

## Capture guidance rules

Capture follows the [Cesium reconstruction capture guidance](https://cesium.com/learn/reality-data/reconstruction/). The HUD leads the operator through a deterministic 36-station sequence: 12 positions at 30-degree increments on each of three complete rings.

- **High ring:** camera above the object, pointed down.
- **Middle ring:** camera at object level, facing forward.
- **Low ring:** camera below the object, pointed up.

The overlay emphasizes physical movement for parallax, neighboring-image overlap, stable framing, sharp imagery, consistent lighting, and a static scene. Submission remains disabled until every station and the overlap, blur, lighting, and distance-stability quality gates pass. Thin or detailed geometry may still benefit from extra close, overlapping passes in a production capture.

## Camera preview modes

The web prototype starts with an explicitly labeled **simulated preview**. It does not and cannot directly access the Meta Ray-Ban Display camera.

- **Browser camera:** available only after the operator selects **Use Browser Camera** and grants browser permission. This previews the current browser device's camera, not the glasses camera.
- **Meta DAT stream:** the iOS companion uses `AutoDeviceSelector`, a DAT device session, low/15 fps preview, and JPEG `capturePhoto`. The web HUD retains its bridge adapter point; the two clients synchronize capture progress through the BFF.
- **Captured metrics:** simulated, browser, and uploaded captures use deterministic quality values in this prototype so interaction and server gating are repeatable. Production integrations must provide measured image-quality metadata.

## Gaps requiring real SDK/credentials

1. **Meta glasses live capture** is implemented and compiled against DAT 0.8.0, but still requires the user's Meta credentials, Meta AI registration, compatible glasses/firmware, and physical-device testing. The repository does not claim that hardware validation has occurred.
2. **Cesium ion Gaussian Splat upload + job creation** is implemented server-side for live mode and remains explicitly mock/blocked when configured.
3. **Review rendering** currently shows a mock/sample splat result card rather than loading real splat content in a Cesium viewer.

## Cesium identity

This is an independent **prototype powered by Cesium ion**, not an official Cesium product. The HUD vendors the official, unmodified `Cesium_logo_only.svg` from the [Cesium press/logo resources](https://cesium.com/press) and uses the official light blue (`#6dabe4`), green (`#709c49`), and dark (`#0e1422`) palette. The logo-only variant remains legible against the additive display's dark/transparent treatment without changing official logo geometry.

## Reconstruction completion notifications

After submission, the Review screen connects to `GET /api/reconstruction-jobs/:jobId/events`. This SSE stream emits only status transitions (`queued`, `processing`, and a terminal status), sends a 15-second heartbeat while open, asks EventSource to reconnect after two seconds, and cleans up monitoring when the client disconnects. The stream closes at a terminal state. **Refresh Job Status** remains available as a fallback.

On any terminal transition, the HUD shows an in-app banner, opens Review, and focuses the status details. `completed` is reserved for a future real ion success; the local path truthfully reports `completed_mock`. Blocked and failed states use an error treatment and never use success wording. A per-job transition guard prevents duplicate banners, browser notifications, or native requests if an event repeats or EventSource reconnects.

Desktop browser alerts are optional:

1. Open **Status**.
2. Select **Enable completion alerts**.
3. Grant the browser permission prompt.

Permission is requested only from that explicit action, never at page load. Denied and unsupported states are explained in the Status screen, while in-app alerts continue to work. Browser Notifications are intended for desktop testing while this page is running.

Meta WebApps on glasses do **not** support background notifications, and this prototype does not claim Service Worker or Web Push support on MRBD. The iOS companion requests notification permission only after an explicit tap and deduplicates successful terminal alerts. Its local polling must remain active; production background completion requires server-driven APNs push infrastructure.

The server currently evaluates the mock lifecycle in process. Production integration belongs server-side: upload imagery and create the ion reconstruction job, then translate ion job state into the same status contract. Prefer an ion webhook if one is available for the production workflow; otherwise poll ion from the server and publish transitions through this SSE endpoint. Clients should not poll ion directly or receive ion credentials.
