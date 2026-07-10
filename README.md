# Meta Ray-Ban photogrammetry prototype (v1)

Prototype app stack for guided capture and reconstruction status tracking across web, iOS, and a Node BFF.

## Architecture (high-level)

```text
Meta Ray-Ban Glasses / iPhone Camera
             │
             ▼
   iOS Companion (SwiftUI + DAT)
   - primary: DAT stream/capture
   - fallback: iPhone inline camera
             │  JPEG upload + session sync
             ▼
      Node/Express BFF (apps/server)
      - capture sessions + guidance rules
      - reconstruction job lifecycle + SSE
             │
             ├── mock pipeline (local deterministic result)
             └── Cesium ion live pipeline (when enabled)
                        │
                        ▼
               Reconstruction result metadata
                        │
                        ▼
          Glasses Web HUD (apps/glasses-web)
          - station guidance + review/status UI
```

## Data flow

1. Operator starts a capture session in the web HUD (or iOS companion syncs to it).
2. Station photos are captured (DAT primary, iPhone fallback if DAT startup fails) and uploaded to BFF.
3. BFF validates sequence/quality gates and accepts reconstruction submission.
4. BFF routes the job to either mock mode or live Cesium ion mode.
5. Clients poll `GET /api/reconstruction-jobs/:jobId` and/or subscribe to SSE events.
6. Review UI shows terminal status plus available preview/result metadata.

## Runtime behavior modes

Set environment in your shell:

```bash
export CESIUM_ION_TOKEN=...                 # optional in prototype
export CESIUM_ION_API_URL=https://api.cesium.com
export ALLOW_MOCK_RESULTS=true              # default true
export ENABLE_LIVE_ION_SUBMISSION=false     # default false
```

- **Mock mode:** no token + `ALLOW_MOCK_RESULTS=true` → `completed_mock`.
- **Blocked mode:** no token + `ALLOW_MOCK_RESULTS=false` → `blocked_no_credentials`.
- **Live mode:** token present + `ENABLE_LIVE_ION_SUBMISSION=true` → submit/poll ion and map to `queued` / `processing` / `completed` with `result.provider="ion"`.
- **Explicit fail-fast:** token present but live disabled and ion requested → explicit error (no silent fallback).

**Current live caveat (important):**
If ion returns `405 MethodNotAllowed` with
`{"code":"MethodNotAllowed","message":"POST is not allowed"}`
on `POST /v1/reality-capture/gaussian-splats/jobs`, the public endpoint is not available for this account/path. Use mock mode for now and ensure token scope includes `assets:write`.

## Local run

### Server (BFF)

```bash
npm install
npm run dev --workspace @apps/server
```

Default local server URL: `http://localhost:8788`

### Glasses web HUD

```bash
npm run dev --workspace @apps/glasses-web
```

Default local web URL: `http://localhost:8787`

### iOS companion

1. Open `apps/ios-companion/SplatCaptureCompanion.xcodeproj` in Xcode.
2. Copy `apps/ios-companion/Config/Local.xcconfig.example` to `Local.xcconfig` and set `SERVER_BASE_URL`.
3. Build/run on simulator or device (see [`apps/ios-companion/README.md`](apps/ios-companion/README.md) for DAT/device details).

## API surface

- `POST /api/capture-sessions`
- `GET /api/capture-sessions/:sessionId`
- `POST /api/capture-sessions/:sessionId/photos`
- `POST /api/capture-sessions/:sessionId/photos/upload`
- `POST /api/reconstruction-jobs` (alias: `/api/assets/jobs`)
- `GET /api/reconstruction-jobs/:jobId` (alias: `/api/assets/jobs/:jobId`)
- `GET /api/reconstruction-jobs/:jobId/events` (SSE)
- `GET /api/config`
- `GET /api/health`

## Known limitations

- DAT-based live glasses capture depends on user credentials, hardware/firmware, and Meta setup.
- Live Cesium ion Gaussian Splat submission may be unavailable on current public endpoint for some accounts (405 caveat above).
- Review UI currently focuses on status + metadata and mock preview assets; it is not yet a full in-app real splat renderer.
- Notifications are in-app/local; production background completion needs server-driven push infra.

## Next steps

1. Integrate a supported production ion reconstruction endpoint/workflow for fully live jobs.
2. Add first-class CesiumJS splat viewer integration for real result visualization.
3. Replace deterministic prototype quality metrics with measured image-quality scoring.
4. Add production auth, observability, and retry/backoff policies for long-running jobs.
