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

**Live ion token requirements:**
The token must have both `assets:read` and `assets:write` scopes. The `GET /api/config` endpoint runs a preflight against the ion API and reports readiness — the iOS companion surfaces this as a warning before you submit. If you see `"assetRegion"` in the error, your ion account requires a region-specific endpoint; contact Cesium ion support.

## Local run

### Server (BFF)

**Development (hot-reload — use for iterating on server code):**

```bash
npm install
npm run dev -w @prototype/server
```

> ⚠️ `npm run dev` uses `tsx watch` which restarts the process on file changes. During long-running ion polling this can cause **port collisions and dropped SSE connections**. Do not use for device testing or live ion submissions.

**Stable (compiled — use for device/live ion testing and production-like runs):**

```bash
npm run build          # compiles server + contracts
npm start              # runs node apps/server/dist/index.js
```

Or in one step:

```bash
npm run build -w @prototype/server && node apps/server/dist/index.js
```

Default local server URL: `http://localhost:8787`

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
- Live Cesium ion Gaussian Splat reconstruction via API requires an account plan that supports `POST /v1/assets`. If ion returns a region-routing error, contact Cesium ion support. Use mock mode to validate the capture flow independently.
- Review UI currently focuses on status + metadata and mock preview assets; it is not yet a full in-app real splat renderer.
- Notifications are in-app/local; production background completion needs server-driven push infra.

## Next steps

1. Integrate a supported production ion reconstruction endpoint/workflow for fully live jobs.
2. Add first-class CesiumJS splat viewer integration for real result visualization.
3. Replace deterministic prototype quality metrics with measured image-quality scoring.
4. Add production auth, observability, and retry/backoff policies for long-running jobs.
