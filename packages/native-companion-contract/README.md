# Native companion contract

The iOS implementation lives in `apps/ios-companion`. `CompanionPhotoUpload.jpeg` represents the exact JPEG bytes returned by Meta DAT `capturePhoto(format: .jpeg)`; preview screenshots must not be substituted.

Type definitions for the hybrid architecture boundary between the iOS Meta Device
Access Toolkit companion and the BFF in `apps/server`.

Key exports:

- `CompanionBridge`
- `CompanionPhotoEvent` and `CompanionPhotoUpload`
- `CompanionReconstructionRequest`
- `CompanionReconstructionCompletedEvent`
- `CompanionReconstructionNotificationRequest`
- `backendRestContract`

The iOS DAT companion owns OS-level completion notifications. It requests
permission explicitly, schedules alerts only for successful terminal states,
and deduplicates by job ID. JPEG device photos use
`POST /api/capture-sessions/:sessionId/photos/upload`; deterministic station
metadata is sent in `X-Capture-*` headers and the body is `image/jpeg`.
