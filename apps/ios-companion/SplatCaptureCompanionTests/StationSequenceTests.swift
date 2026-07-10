import XCTest
import AVFoundation
@testable import SplatCaptureCompanion

final class StationSequenceTests: XCTestCase {
    func testCaptureSessionEnvelopeDecodesServerGuidanceObject() throws {
        let payload = """
        {
          "session": {
            "id": "18075583-ad66-4d2b-aa52-c9dbd87b80b4",
            "createdAt": "2026-07-09T21:29:12.845Z",
            "photos": []
          },
          "guidance": {
            "photoCount": 0,
            "orbitCoverageRatio": 0,
            "completedStationCount": 0,
            "requiredStationCount": 36,
            "ringProgress": {
              "high": 0,
              "middle": 0,
              "low": 0
            },
            "nextStation": {
              "ring": "high",
              "stationIndex": 0,
              "angleDeg": 0
            },
            "averageOverlap": 0,
            "averageBlurScore": 0,
            "averageLightingScore": 0,
            "averageDistanceVariance": 0,
            "checklist": {
              "minPhotoCountMet": false,
              "overlapMet": false,
              "threeOrbitCoverageMet": false,
              "blurMet": true,
              "lightingMet": false,
              "distanceStabilityMet": true
            },
            "tips": [
              "Capture every 30-degree station on the high, middle, and low rings.",
              "Increase overlap by moving in smaller increments around the object."
            ]
          },
          "thresholds": {
            "stationsPerRing": 12,
            "requiredRings": 3,
            "minPhotos": 36
          }
        }
        """

        let envelope = try JSONDecoder().decode(
            CaptureSessionEnvelope.self,
            from: try XCTUnwrap(payload.data(using: .utf8))
        )

        XCTAssertEqual(envelope.session.id, "18075583-ad66-4d2b-aa52-c9dbd87b80b4")
        XCTAssertEqual(envelope.guidance.photoCount, 0)
        XCTAssertEqual(envelope.guidance.completedStationCount, 0)
        XCTAssertEqual(envelope.guidance.requiredStationCount, 36)
        XCTAssertEqual(envelope.guidance.ringProgress, [.high: 0, .middle: 0, .low: 0])
        XCTAssertEqual(envelope.guidance.nextStation?.ring, .high)
        XCTAssertEqual(envelope.guidance.nextStation?.stationIndex, 0)
        XCTAssertEqual(envelope.guidance.nextStation?.angleDeg, 0)
    }

    func testGuidanceDecodesNullNextStation() throws {
        let payload = """
        {
          "photoCount": 36,
          "completedStationCount": 36,
          "requiredStationCount": 36,
          "ringProgress": {"high": 12, "middle": 12, "low": 12},
          "nextStation": null,
          "tips": ["Capture quality is solid. You can submit a reconstruction job."]
        }
        """

        let guidance = try JSONDecoder().decode(
            Guidance.self,
            from: try XCTUnwrap(payload.data(using: .utf8))
        )

        XCTAssertNil(guidance.nextStation)
        XCTAssertEqual(guidance.ringProgress[.low], 12)
    }

    func testJobStatusDecodesCompletedMockResultPayload() throws {
        let payload = """
        {
          "jobId": "job-42",
          "sessionId": "session-42",
          "status": "completed_mock",
          "progress": 1,
          "message": "Mock result ready",
          "result": {
            "provider": "mock",
            "splat": {
              "id": "mock-room",
              "format": "splat",
              "url": "/mock/sample-room.splat",
              "thumbnailUrl": "/mock/sample-splat-preview.svg",
              "notes": "Mock preview for UI validation."
            }
          }
        }
        """

        let decoded = try JSONDecoder().decode(JobStatusResponse.self, from: try XCTUnwrap(payload.data(using: .utf8)))

        XCTAssertEqual(decoded.status, .completedMock)
        XCTAssertEqual(decoded.result?.provider, .mock)
        XCTAssertEqual(decoded.result?.splat?.format, "splat")
        XCTAssertEqual(decoded.result?.splat?.thumbnailUrl, "/mock/sample-splat-preview.svg")
    }

    func testLiveCaptureSessionDecodesWhenServerURLIsProvided() async throws {
        guard
            let value = ProcessInfo.processInfo.environment["LIVE_BFF_URL"],
            let url = URL(string: value)
        else {
            throw XCTSkip("Set LIVE_BFF_URL to run against a development BFF.")
        }

        let envelope = try await BFFClient(baseURL: url).createCaptureSession()

        XCTAssertFalse(envelope.session.id.isEmpty)
        XCTAssertEqual(envelope.guidance.requiredStationCount, 36)
        XCTAssertEqual(envelope.guidance.ringProgress, [.high: 0, .middle: 0, .low: 0])
        XCTAssertEqual(envelope.guidance.nextStation?.ring, .high)
    }

    func testBFFDecodingErrorIncludesEndpointAndCodingDetails() {
        let error = BFFError.decoding(
            endpoint: "POST /api/capture-sessions",
            details: "$.guidance.ringProgress: Expected Dictionary<String, Int>."
        )

        XCTAssertEqual(
            error.localizedDescription,
            "Could not read the response from POST /api/capture-sessions. "
                + "$.guidance.ringProgress: Expected Dictionary<String, Int>."
        )
    }

    func testSequenceHasThreeOrderedRingsAndThirtySixUniqueStations() {
        XCTAssertEqual(CaptureStation.sequence.count, 36)
        XCTAssertEqual(Set(CaptureStation.sequence.map(\.id)).count, 36)
        XCTAssertEqual(CaptureStation.sequence.prefix(12).map(\.ring), Array(repeating: .high, count: 12))
        XCTAssertEqual(CaptureStation.sequence.dropFirst(12).prefix(12).map(\.ring), Array(repeating: .middle, count: 12))
        XCTAssertEqual(CaptureStation.sequence.suffix(12).map(\.ring), Array(repeating: .low, count: 12))
        XCTAssertEqual(CaptureStation.sequence.prefix(12).map(\.angleDeg), Array(stride(from: 0, to: 360, by: 30)))
    }

    func testCameraConfigurationLifecycleRejectsUseBeforeConfiguration() {
        let lifecycle = CameraConfigurationLifecycle()

        XCTAssertThrowsError(try lifecycle.requireReady()) { error in
            XCTAssertEqual(
                error.localizedDescription,
                "The glasses SDK is not configured yet. Wait for setup to finish and try again."
            )
        }
    }

    func testCameraConfigurationLifecycleIsIdempotent() throws {
        let lifecycle = CameraConfigurationLifecycle()
        var sdkConfigurationCount = 0
        var adapterConfigurationCount = 0

        for _ in 0..<2 {
            try lifecycle.configure(
                sdk: { sdkConfigurationCount += 1 },
                adapter: { adapterConfigurationCount += 1 }
            )
        }

        XCTAssertEqual(sdkConfigurationCount, 1)
        XCTAssertEqual(adapterConfigurationCount, 1)
        XCTAssertNoThrow(try lifecycle.requireReady())
    }

    func testCameraConfigurationLifecycleDoesNotReconfigureSDKWhenAdapterRetries() throws {
        let lifecycle = CameraConfigurationLifecycle()
        var sdkConfigurationCount = 0
        var adapterConfigurationCount = 0

        XCTAssertThrowsError(try lifecycle.configure(
            sdk: { sdkConfigurationCount += 1 },
            adapter: {
                adapterConfigurationCount += 1
                throw CompanionCameraError.captureRejected
            }
        ))

        try lifecycle.configure(
            sdk: { sdkConfigurationCount += 1 },
            adapter: { adapterConfigurationCount += 1 }
        )

        XCTAssertEqual(sdkConfigurationCount, 1)
        XCTAssertEqual(adapterConfigurationCount, 2)
        XCTAssertNoThrow(try lifecycle.requireReady())
    }

    func testDeviceReadinessGateWaitsForDelayedDiscovery() async throws {
        let updates = AsyncStream<Int> { continuation in
            Task {
                try? await Task.sleep(for: .milliseconds(100))
                continuation.yield(1)
                continuation.finish()
            }
        }

        try await DeviceReadinessGate.wait(
            initialCount: 0,
            updates: updates,
            timeout: .seconds(1),
            timeoutError: { CompanionCameraError.deviceDiscoveryTimedOut(isMock: true) }
        )
    }

    func testDeviceReadinessGateHasBoundedTimeout() async {
        let start = ContinuousClock.now

        do {
            try await DeviceReadinessGate.wait(
                initialCount: 0,
                updates: AsyncStream { _ in },
                timeout: .milliseconds(100),
                timeoutError: { CompanionCameraError.deviceDiscoveryTimedOut(isMock: false) }
            )
            XCTFail("Expected discovery to time out")
        } catch {
            XCTAssertEqual(
                error.localizedDescription,
                "No eligible glasses appeared within 10 seconds. Keep the glasses powered on, unfolded, worn, and registered, then try again."
            )
            XCTAssertLessThan(start.duration(to: .now), .seconds(1))
        }
    }

    func testStreamStartupErrorSurfacesUnderlyingDetails() {
        let error = CompanionCameraError.streamStartupFailed(details: "DAT: bluetooth link dropped")
        XCTAssertEqual(
            error.localizedDescription,
            "Could not start the glasses camera stream. DAT: bluetooth link dropped"
        )
    }

    func testStartCaptureSessionRetryPolicyIncludesTransientStartupErrors() {
        XCTAssertTrue(AppModel.shouldRetryStartSession(after: CompanionCameraError.notStreaming))
        XCTAssertTrue(AppModel.shouldRetryStartSession(
            after: CompanionCameraError.streamStartupFailed(details: "temporary stream stop")
        ))
        XCTAssertTrue(AppModel.shouldRetryStartSession(after: CompanionCameraError.streamStartupTimedOut))
        XCTAssertFalse(AppModel.shouldRetryStartSession(after: CompanionCameraError.captureRejected))
    }

    @MainActor
    func testFallbackModeActivatesAfterRepeatedDATStartupFailure() async {
        let camera = FakeCompanionCamera(startSessionFailuresRemaining: 2)
        let backend = FakeCaptureBackendClient()
        let fallbackCamera = FakeFallbackCamera(jpeg: Data([0xFF, 0xD8, 0xFF]))
        let model = AppModel(
            camera: camera,
            client: backend,
            serverUsesLoopbackHost: false,
            configurationMessage: "DAT 0.8 physical-glasses mode",
            fallbackCamera: fallbackCamera
        )

        await model.start()
        try? await Task.sleep(for: .milliseconds(20))
        await model.startCaptureSession()

        XCTAssertEqual(model.captureInputMode, .iphoneFallback)
        XCTAssertEqual(model.sessionPhase, .started)
        XCTAssertTrue(model.fallbackMessage?.contains("DAT stream startup failed") == true)
        XCTAssertEqual(camera.startSessionAttempts, 2)
        XCTAssertEqual(fallbackCamera.startCount, 1)
    }

    @MainActor
    func testFallbackModeOneTapCaptureUploadsUsingExistingGuidanceFlow() async {
        let camera = FakeCompanionCamera(startSessionFailuresRemaining: 2)
        let backend = FakeCaptureBackendClient()
        let fallbackJPEG = Data([0xFF, 0xD8, 0xAA, 0xBB, 0xFF])
        let fallbackCamera = FakeFallbackCamera(jpeg: fallbackJPEG)
        let model = AppModel(
            camera: camera,
            client: backend,
            serverUsesLoopbackHost: false,
            configurationMessage: "DAT 0.8 physical-glasses mode",
            fallbackCamera: fallbackCamera
        )

        await model.start()
        try? await Task.sleep(for: .milliseconds(20))
        await model.startCaptureSession()
        await model.captureCurrentStation()

        let upload = await backend.latestUpload
        XCTAssertNotNil(upload)
        XCTAssertEqual(upload?.jpeg, fallbackJPEG)
        XCTAssertEqual(upload?.photo.ring, .high)
        XCTAssertEqual(upload?.photo.stationIndex, 0)
        XCTAssertEqual(model.completedStationCount, 1)
        XCTAssertEqual(model.ringProgress[.high], 1)
        XCTAssertEqual(model.currentStation.ring, .high)
        XCTAssertEqual(model.currentStation.stationIndex, 1)
        XCTAssertEqual(fallbackCamera.captureCount, 1)
    }

    @MainActor
    func testAppModelStoresResolvedCompletedMockResultDetails() async throws {
        let camera = FakeCompanionCamera(startSessionFailuresRemaining: 0)
        let backend = FakeCompletedMockBackendClient()
        let fallbackCamera = FakeFallbackCamera(jpeg: Data([0xFF, 0xD8, 0x01]))
        let baseURL = try XCTUnwrap(URL(string: "http://127.0.0.1:8788"))
        let model = AppModel(
            camera: camera,
            client: backend,
            serverUsesLoopbackHost: false,
            configurationMessage: "DAT 0.8 physical-glasses mode",
            fallbackCamera: fallbackCamera,
            backendBaseURL: baseURL
        )

        await model.start()
        try? await Task.sleep(for: .milliseconds(20))
        await model.startCaptureSession()
        await model.submitReconstruction()
        try? await Task.sleep(for: .milliseconds(50))

        XCTAssertEqual(model.reconstructionStatus, .completedMock)
        XCTAssertEqual(model.reconstructionResult?.provider, .mock)
        XCTAssertEqual(model.reconstructionResult?.format, "splat")
        XCTAssertEqual(model.reconstructionResult?.notes, "Mock preview for iOS.")
        XCTAssertEqual(model.reconstructionResult?.thumbnailURL?.absoluteString, "http://127.0.0.1:8788/mock/sample-splat-preview.svg")
        XCTAssertEqual(model.reconstructionResult?.resultURL?.absoluteString, "http://127.0.0.1:8788/mock/sample-room.splat")
    }

    private static func decodeEnvelope(_ payload: String) throws -> CaptureSessionEnvelope {
        try JSONDecoder().decode(CaptureSessionEnvelope.self, from: Data(payload.utf8))
    }

    private static func decodeUploadResponse(_ payload: String) throws -> PhotoUploadResponse {
        try JSONDecoder().decode(PhotoUploadResponse.self, from: Data(payload.utf8))
    }

    private final class FakeCompanionCamera: CompanionCamera, @unchecked Sendable {
        let isMock = false
        var startSessionFailuresRemaining: Int
        var startSessionAttempts = 0

        init(startSessionFailuresRemaining: Int) {
            self.startSessionFailuresRemaining = startSessionFailuresRemaining
        }

        func configure() throws {}
        func registrationUpdates() throws -> AsyncStream<RegistrationPhase> {
            AsyncStream { continuation in
                continuation.yield(.registered)
                continuation.finish()
            }
        }
        func registrationPhase() throws -> RegistrationPhase { .registered }
        func deviceCountUpdates() throws -> AsyncStream<Int> {
            AsyncStream { continuation in
                continuation.yield(1)
                continuation.finish()
            }
        }
        func readinessUpdates() throws -> AsyncStream<Bool> {
            AsyncStream { continuation in
                continuation.yield(true)
                continuation.finish()
            }
        }
        func waitForDevice(timeout: Duration) async throws {}
        func startRegistration() async throws {}
        func handleCallback(_ url: URL) async throws {}
        func cameraPermission() async throws -> CameraPermissionPhase { .granted }
        func requestCameraPermission() async throws -> CameraPermissionPhase { .granted }
        func startSession(
            onSession: @escaping @Sendable (DeviceSessionPhase) -> Void,
            onPreview: @escaping @Sendable (CameraSnapshot) -> Void
        ) async throws {
            startSessionAttempts += 1
            onSession(.starting)
            if startSessionFailuresRemaining > 0 {
                startSessionFailuresRemaining -= 1
                throw CompanionCameraError.streamStartupTimedOut
            }
            onSession(.started)
        }
        func stopSession() throws {}
        func pauseSession() throws {}
        func resumeSession(
            onSession: @escaping @Sendable (DeviceSessionPhase) -> Void,
            onPreview: @escaping @Sendable (CameraSnapshot) -> Void
        ) async throws {}
        func captureJPEG() async throws -> Data {
            XCTFail("Fallback test should not call DAT captureJPEG when iPhone fallback is active.")
            return Data()
        }
    }

    private actor FakeCaptureBackendClient: CaptureBackendClient {
        var latestUpload: (photo: PhotoUpload, jpeg: Data)?

        func createCaptureSession() async throws -> CaptureSessionEnvelope {
            try StationSequenceTests.decodeEnvelope(
                """
                {
                  "session": { "id": "session-1" },
                  "guidance": {
                    "photoCount": 0,
                    "completedStationCount": 0,
                    "requiredStationCount": 36,
                    "ringProgress": { "high": 0, "middle": 0, "low": 0 },
                    "nextStation": { "ring": "high", "stationIndex": 0, "angleDeg": 0 }
                  }
                }
                """
            )
        }

        func captureSession(id: String) async throws -> CaptureSessionEnvelope {
            try await createCaptureSession()
        }

        func uploadPhoto(sessionID: String, photo: PhotoUpload, jpeg: Data) async throws -> PhotoUploadResponse {
            latestUpload = (photo, jpeg)
            return try StationSequenceTests.decodeUploadResponse(
                """
                {
                  "added": 1,
                  "guidance": {
                    "photoCount": 1,
                    "completedStationCount": 1,
                    "requiredStationCount": 36,
                    "ringProgress": { "high": 1, "middle": 0, "low": 0 },
                    "nextStation": { "ring": "high", "stationIndex": 1, "angleDeg": 30 }
                  }
                }
                """
            )
        }

        func submitReconstruction(sessionID: String) async throws -> JobSubmissionResponse {
            JobSubmissionResponse(jobId: "job-1")
        }

        func jobStatus(jobID: String) async throws -> JobStatusResponse {
            JobStatusResponse(
                jobId: "job-1",
                sessionId: "session-1",
                status: .queued,
                progress: 0,
                message: "Queued"
            )
        }
    }

    private actor FakeCompletedMockBackendClient: CaptureBackendClient {
        func createCaptureSession() async throws -> CaptureSessionEnvelope {
            try StationSequenceTests.decodeEnvelope(
                """
                {
                  "session": { "id": "session-1" },
                  "guidance": {
                    "photoCount": 0,
                    "completedStationCount": 0,
                    "requiredStationCount": 36,
                    "ringProgress": { "high": 0, "middle": 0, "low": 0 },
                    "nextStation": { "ring": "high", "stationIndex": 0, "angleDeg": 0 }
                  }
                }
                """
            )
        }

        func captureSession(id: String) async throws -> CaptureSessionEnvelope {
            try await createCaptureSession()
        }

        func uploadPhoto(sessionID: String, photo: PhotoUpload, jpeg: Data) async throws -> PhotoUploadResponse {
            try StationSequenceTests.decodeUploadResponse(
                """
                {
                  "added": 1,
                  "guidance": {
                    "photoCount": 1,
                    "completedStationCount": 1,
                    "requiredStationCount": 36,
                    "ringProgress": { "high": 1, "middle": 0, "low": 0 },
                    "nextStation": { "ring": "high", "stationIndex": 1, "angleDeg": 30 }
                  }
                }
                """
            )
        }

        func submitReconstruction(sessionID: String) async throws -> JobSubmissionResponse {
            JobSubmissionResponse(jobId: "job-completed-mock")
        }

        func jobStatus(jobID: String) async throws -> JobStatusResponse {
            JobStatusResponse(
                jobId: "job-completed-mock",
                sessionId: "session-1",
                status: .completedMock,
                progress: 1,
                message: "Mock complete.",
                result: ReconstructionResultPayload(
                    provider: .mock,
                    splat: ReconstructionSplatResult(
                        id: "mock-asset-1",
                        format: "splat",
                        url: "/mock/sample-room.splat",
                        thumbnailUrl: "/mock/sample-splat-preview.svg",
                        notes: "Mock preview for iOS."
                    )
                )
            )
        }
    }

    private final class FakeFallbackCamera: FallbackCameraCapturing, @unchecked Sendable {
        var previewSession: AVCaptureSession? = AVCaptureSession()
        var startCount = 0
        var stopCount = 0
        var captureCount = 0
        private let jpeg: Data

        init(jpeg: Data) {
            self.jpeg = jpeg
        }

        func start() async throws {
            startCount += 1
        }

        func stop() {
            stopCount += 1
        }

        func captureJPEG() async throws -> Data {
            captureCount += 1
            return jpeg
        }
    }

}
