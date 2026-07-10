# Splat Capture iOS companion

A directly openable SwiftUI app using Meta Wearables Device Access Toolkit (DAT) **0.8.0**. The default uses Meta's Mock Device Kit in Simulator and real DAT on iPhone; `Local.xcconfig` can explicitly force either path.

## What works now

- DAT registration and callback handling through Meta AI.
- Wearables camera permission checking/requesting.
- `AutoDeviceSelector`, `DeviceSession`, and stream lifecycle observation.
- Low-resolution, 24 fps live preview matching Meta's DAT 0.8 CameraAccess sample.
- JPEG still capture from DAT's `capturePhoto(format: .jpeg)` publisher, not a preview screenshot.
- Temporary automatic iPhone-camera fallback when DAT stream startup repeatedly fails (for example on iOS 27 beta), while preserving the same session/guidance/upload flow.
- Deterministic high/middle/low 36-station sequence synchronized from the BFF.
- Typed Swift models and `URLSession` requests to upload JPEG bytes and submit/poll reconstruction.
- Completed mock reconstruction responses now render in-app preview details (thumbnail, provider/format, notes, and result link).
- Explicit notification permission and one deduplicated local success alert per job.
- Meta Mock Device Kit pairing, lifecycle, and a configured JPEG capture on Simulator.

The companion supports all server modes: explicit mock, blocked (missing credentials), and live Cesium ion reconstruction when the server is configured with `CESIUM_ION_TOKEN` + `ENABLE_LIVE_ION_SUBMISSION=true`. Local notification monitoring works only while this app remains active. Production background completion requires the server to send an APNs remote push; iOS does not allow indefinite background polling.

## 1. Open and run the mock first

1. Install Xcode 26.4.1 (the project also targets iOS 16.0+).
2. Start the BFF from the repository root:

   ```bash
   npm install
   npm run dev
   ```

3. Open `apps/ios-companion/SplatCaptureCompanion.xcodeproj`.
4. Wait for Xcode to resolve `https://github.com/facebook/meta-wearables-dat-ios` at exact version `0.8.0`.
5. Select an iPhone Simulator and press **Run**.
6. The default build follows Meta's DAT 0.8 sample order: configure DAT, call `MockDeviceKit.enable()`, pair Ray-Ban Meta glasses, power on/unfold them, and configure the official CameraAccess test video plus a generated JPEG. Set `USE_DAT_MOCK_DEVICE = YES` in `Local.xcconfig` to force the mock on a device.
7. Wait until **Devices found** reaches at least 1 and the setup guidance says the mock glasses are ready. **Start session** remains disabled while DAT is still publishing the paired device.
8. Tap **Start session**, then **Capture station photo**. The app uploads the JPEG and advances to the next backend station.

If Swift Package Manager reports `safe.bareRepository is 'explicit'`, use:

```bash
GIT_CONFIG_COUNT=1 \
GIT_CONFIG_KEY_0=safe.bareRepository \
GIT_CONFIG_VALUE_0=all \
xcodebuild -project apps/ios-companion/SplatCaptureCompanion.xcodeproj \
  -scheme SplatCaptureCompanion -resolvePackageDependencies -scmProvider system
```

This command applies the setting only to that process; it does not modify global Git configuration.

## 2. Create the private local configuration

Never add Meta credentials or Apple Team IDs to source control.

```bash
cp apps/ios-companion/Config/Local.xcconfig.example \
   apps/ios-companion/Config/Local.xcconfig
```

Edit `Local.xcconfig`:

- `PRODUCT_BUNDLE_IDENTIFIER`: a unique bundle ID registered with Apple and Meta.
- `DEVELOPMENT_TEAM`: your Apple Developer Team ID.
- `META_APP_ID` and `CLIENT_TOKEN`: values from Wearables Developer Center. In Developer Mode, DAT does not use app attestation, so these may remain empty during the first device test.
- `MWDAT_URL_SCHEME`: callback scheme registered for your Meta project.
- `SERVER_BASE_URL`: BFF URL reachable from the iPhone.
- `USE_DAT_MOCK_DEVICE`: leave empty for automatic behavior (mock in Simulator, real DAT on iPhone), or explicitly set `YES`/`NO`.

`Info.plist` explicitly enables DAM and opts out of DAT analytics. To opt in, make the deliberate choice to change `MWDAT > Analytics > OptOut` to `false`; Meta documents analytics as enabled when this key is absent or false.

## 3. Create the Meta Wearables project

1. Sign in to [Wearables Developer Center](https://wearables.developer.meta.com/).
2. Create or select an organization and project.
3. Add an iOS integration with the same bundle identifier used in Xcode.
4. Register the callback/app link scheme used by `MWDAT_URL_SCHEME`.
5. Copy the generated Meta App ID and Client Token only into ignored `Config/Local.xcconfig`.
6. Keep `DAMEnabled` enabled. The app already includes the external accessory protocol, Bluetooth/external-accessory background modes, `fb-viewapp` query scheme, and usage descriptions required by the official iOS guide.

DAT is currently a developer preview and its `ExternalAccessory` use is not suitable for App Store submission. Use Developer Mode or Meta release channels for testing.

## 4. Enable Developer Mode in Meta AI

On the iPhone:

1. Open **Meta AI**.
2. Go to **Settings > App Info**.
3. Tap **App version** five times.
4. Enable **Developer Mode** and confirm.
5. Make sure the Meta AI app and glasses firmware satisfy Meta's current [version dependencies](https://wearables.developer.meta.com/docs/develop/dat/version-dependencies/).

Developer Mode may turn off after firmware updates.

## 5. Configure Xcode signing

1. Open the project and select the **SplatCaptureCompanion** target.
2. Open **Signing & Capabilities**.
3. Select your Apple development team.
4. Confirm the bundle identifier exactly matches Apple and Wearables Developer Center.
5. Connect and trust the physical iPhone, select it as the run destination, and allow Xcode to manage signing.

The committed project contains no Team ID or credential.

## 6. Connect the iPhone to the Mac BFF

`localhost` on an iPhone means the iPhone, not your Mac.

1. Put the Mac and iPhone on the same trusted Wi-Fi network.
2. Find the Mac's LAN address:

   ```bash
   ipconfig getifaddr en0
   ```

3. Set `SERVER_BASE_URL` in `Local.xcconfig`, for example:

   ```xcconfig
   SERVER_BASE_URL = http:/$()/192.168.1.100:8787
   ```

4. Start the BFF with `npm run dev`.
5. Allow incoming connections in macOS Firewall if prompted.
6. Accept the app's iOS local-network prompt.

`NSAllowsLocalNetworking` is enabled for development. Prefer a trusted HTTPS endpoint for production. If an enterprise network blocks peer-to-peer traffic, use a secure HTTPS tunnel rather than disabling ATS globally.

## 7. Pair, register, and take the first real photo

1. Pair the glasses to this iPhone in Meta AI and confirm Bluetooth is enabled.
2. Leave `USE_DAT_MOCK_DEVICE` empty (automatic) or set it to `NO`, then run on the physical iPhone.
3. Tap **Register with Meta AI**, approve the connection, and return through the callback.
4. Tap **Request camera** and approve camera access in Meta AI.
5. Confirm **Devices found** is at least 1.
6. Tap **Start session**. Keep the glasses unfolded and worn.
7. Confirm live frames appear.
8. Stand at the displayed high-ring station and tap **Capture station photo**.
9. Confirm progress changes to `1 / 12` and the next station advances.

If DAT stream startup fails twice with transient startup errors, the app now automatically switches to a temporary **iPhone-camera fallback** mode. The UI shows an explicit fallback banner, renders an inline live iPhone preview in the preview card, and keeps **Capture station photo** as a one-tap direct capture/upload action with no extra retake/use confirmation step.

Use the app's **Pause** button to stop the camera stream while preserving the DAT device session, then **Resume** to create a fresh stream. Removing/folding the glasses can also pause the DAT lifecycle. A terminal stopped device session must be started again.

## Troubleshooting

- **Registration unavailable:** install/update Meta AI, enable Developer Mode, and verify callback configuration.
- **Waiting for device:** glasses must be powered, unfolded, nearby, paired to this iPhone, and on compatible firmware.
- **DAT stream startup failed on iOS 27 beta:** the app auto-switches to temporary iPhone-camera fallback mode and labels this in the UI; captures still upload to the same session/station pipeline.
- **Mock discovery timed out:** stop the app in Xcode and run it again so `MockDeviceKit` starts from a clean process. Do not tap Start while the UI still says it is discovering mock glasses.
- **BFF request failed:** use the Mac LAN IP, not localhost; verify port 8787 and firewall access.
- **No Simulator available:** install an iOS Simulator runtime from **Xcode > Settings > Components**. Command-line target compilation can use the Simulator SDK, but running tests needs an installed runtime.
- **Real app credentials absent:** the mock and Developer Mode paths work; release-channel attestation does not.

Official references:

- [DAT iOS repository](https://github.com/facebook/meta-wearables-dat-ios)
- [iOS integration guide](https://wearables.developer.meta.com/docs/develop/dat/build-integration-ios/)
- [Mock Device Kit for iOS](https://wearables.developer.meta.com/docs/develop/dat/testing-mdk-ios/)
- [DAT 0.8 API reference](https://wearables.developer.meta.com/docs/reference/ios_swift/dat/0.8)

`MockCameraFeed.mp4` is Meta's `samples/CameraAccess/CameraAccess/TestResources/plant.mp4` integration-test fixture and remains covered by the upstream repository license.
