import Foundation
import MWDATCamera
import MWDATCore
import MWDATMockDevice
import UIKit

final class MetaDATCamera: CompanionCamera, @unchecked Sendable {
    static let streamConfiguration = StreamConfiguration(
        videoCodec: .raw,
        resolution: .low,
        frameRate: 24
    )

    let isMock: Bool
    private let lifecycle = CameraConfigurationLifecycle()
    private var wearables: (any WearablesInterface)?
    private var deviceSelector: AutoDeviceSelector?
    private var session: DeviceSession?
    private var stream: MWDATCamera.Stream?
    private var listenerTokens: [AnyListenerToken] = []
    private var mockGlasses: MockGlasses?
    private var photoContinuation: CheckedContinuation<Data, Error>?
    private var pauseRequested = false
    private final class ListenerBox: @unchecked Sendable {
        var tokens: [AnyListenerToken] = []
    }

    init(useMockDevice: Bool) {
        isMock = useMockDevice
    }

    func configure() throws {
        try lifecycle.configure(
            sdk: {
                try? Wearables.configure()
                self.wearables = Wearables.shared
            },
            adapter: {
                guard self.isMock else { return }
                let imageURL = try Self.createMockCaptureImage()
                guard let videoURL = Bundle.main.url(forResource: "MockCameraFeed", withExtension: "mp4") else {
                    throw CompanionCameraError.mockCameraFeedMissing
                }
                let kit = MockDeviceKit.shared
                kit.enable()
                let glasses = try kit.pairGlasses(model: .rayBanMeta)
                glasses.powerOn()
                glasses.unfold()
                glasses.services.camera.setCameraFeed(fileURL: videoURL)
                glasses.services.camera.setCapturedImage(fileURL: imageURL)
                self.mockGlasses = glasses
            }
        )
        if deviceSelector == nil, let wearables {
            deviceSelector = AutoDeviceSelector(wearables: wearables)
        }
    }

    func registrationUpdates() throws -> AsyncStream<RegistrationPhase> {
        let wearables = try configuredWearables()
        return AsyncStream { continuation in
            continuation.yield(Self.map(wearables.registrationState))
            let task = Task {
                for await state in wearables.registrationStateStream() {
                    continuation.yield(Self.map(state))
                }
                continuation.finish()
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    func registrationPhase() throws -> RegistrationPhase {
        let wearables = try configuredWearables()
        return Self.map(wearables.registrationState)
    }

    func deviceCountUpdates() throws -> AsyncStream<Int> {
        let wearables = try configuredWearables()
        let sdkUpdates = wearables.devicesStream()
        return AsyncStream { continuation in
            continuation.yield(wearables.devices.count)
            let task = Task {
                for await devices in sdkUpdates {
                    continuation.yield(devices.count)
                }
                continuation.finish()
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    func readinessUpdates() throws -> AsyncStream<Bool> {
        try lifecycle.requireReady()
        guard let deviceSelector else {
            throw CompanionCameraError.notConfigured
        }
        let activeDevices = deviceSelector.activeDeviceStream()
        return AsyncStream { continuation in
            let task = Task {
                for await device in activeDevices {
                    continuation.yield(device != nil)
                }
                continuation.finish()
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    func waitForDevice(timeout: Duration) async throws {
        let readiness = try readinessUpdates()
        try await DeviceReadinessGate.wait(
            initialCount: 0,
            updates: AsyncStream { continuation in
                let task = Task {
                    for await isReady in readiness {
                        continuation.yield(isReady ? 1 : 0)
                    }
                    continuation.finish()
                }
                continuation.onTermination = { _ in task.cancel() }
            },
            timeout: timeout,
            timeoutError: { CompanionCameraError.deviceDiscoveryTimedOut(isMock: self.isMock) }
        )
    }

    func startRegistration() async throws {
        let wearables = try configuredWearables()
        try await wearables.startRegistration()
    }

    func handleCallback(_ url: URL) async throws {
        let wearables = try configuredWearables()
        _ = try await wearables.handleUrl(url)
    }

    func cameraPermission() async throws -> CameraPermissionPhase {
        let wearables = try configuredWearables()
        let status = try await wearables.checkPermissionStatus(.camera)
        return status == .granted ? .granted : .denied
    }

    func requestCameraPermission() async throws -> CameraPermissionPhase {
        let wearables = try configuredWearables()
        let status = try await wearables.requestPermission(.camera)
        return status == .granted ? .granted : .denied
    }

    func startSession(
        onSession: @escaping @Sendable (DeviceSessionPhase) -> Void,
        onPreview: @escaping @Sendable (CameraSnapshot) -> Void
    ) async throws {
        let wearables = try configuredWearables()
        guard session == nil else {
            try await startStream(onSession: onSession, onPreview: onPreview)
            return
        }
        onSession(.discovering)
        try await waitForDevice(timeout: .seconds(10))
        if isMock {
            // Match Meta's sample stabilization window after reactive device discovery.
            try await Task.sleep(for: .seconds(1))
        }

        guard let selector = deviceSelector else {
            throw CompanionCameraError.notConfigured
        }
        let newSession = try wearables.createSession(deviceSelector: selector)
        session = newSession
        let sessionStates = newSession.stateStream()
        try newSession.start()

        if newSession.state != .started {
            for await state in sessionStates {
                onSession(Self.map(state))
                if state == .started {
                    break
                }
                if state == .stopped {
                    throw CompanionCameraError.streamStartupFailed(
                        details: "The DAT device session stopped before streaming started."
                    )
                }
            }
        }
        onSession(.started)

        try await startStream(onSession: onSession, onPreview: onPreview)
    }

    func pauseSession() throws {
        try lifecycle.requireReady()
        pauseRequested = true
        stream?.stop()
    }

    func resumeSession(
        onSession: @escaping @Sendable (DeviceSessionPhase) -> Void,
        onPreview: @escaping @Sendable (CameraSnapshot) -> Void
    ) async throws {
        try lifecycle.requireReady()
        guard session?.state == .started else {
            throw CompanionCameraError.notStreaming
        }
        try await startStream(onSession: onSession, onPreview: onPreview)
    }

    private func startStream(
        onSession: @escaping @Sendable (DeviceSessionPhase) -> Void,
        onPreview: @escaping @Sendable (CameraSnapshot) -> Void
    ) async throws {
        guard let session else {
            throw CompanionCameraError.notStreaming
        }
        pauseRequested = false
        listenerTokens.removeAll()
        guard let newStream = try session.addStream(config: Self.streamConfiguration) else {
            throw CompanionCameraError.streamStartupFailed(
                details: "DAT returned no stream object for the requested configuration."
            )
        }
        stream = newStream
        listenerTokens = [
            newStream.statePublisher.listen { state in
                let phase: DeviceSessionPhase = switch state {
                case .paused: .paused
                case .stopping: .stopping
                case .stopped: self.pauseRequested ? .paused : .stopped
                case .waitingForDevice, .starting: .starting
                case .streaming: .started
                @unknown default: .stopped
                }
                onSession(phase)
                if state == .streaming, self.isMock {
                    // DAT 0.8 can enter streaming before the first mock video frame is decoded.
                    onPreview(CameraSnapshot(image: Self.mockImage()))
                }
            },
            newStream.videoFramePublisher.listen { frame in
                if let image = frame.makeUIImage() {
                    onPreview(CameraSnapshot(image: image))
                }
            },
            newStream.photoDataPublisher.listen { [weak self] photo in
                self?.resumePhoto(with: .success(photo.data))
            },
            newStream.errorPublisher.listen { [weak self] error in
                self?.resumePhoto(with: .failure(error))
            },
        ]
        try await waitForStreamStartup(
            stream: newStream,
            onSession: onSession,
            timeout: .seconds(5)
        )
    }

    private func waitForStreamStartup(
        stream: MWDATCamera.Stream,
        onSession: @escaping @Sendable (DeviceSessionPhase) -> Void,
        timeout: Duration
    ) async throws {
        let streamStates = AsyncThrowingStream<Void, Error> { continuation in
            let startupListeners = ListenerBox()
            startupListeners.tokens = [
                stream.statePublisher.listen { state in
                    let phase: DeviceSessionPhase = switch state {
                    case .paused: .paused
                    case .stopping: .stopping
                    case .stopped: self.pauseRequested ? .paused : .stopped
                    case .waitingForDevice, .starting: .starting
                    case .streaming: .started
                    @unknown default: .stopped
                    }
                    onSession(phase)
                    if state == .streaming {
                        continuation.yield(())
                        continuation.finish()
                    } else if state == .stopped && !self.pauseRequested {
                        continuation.finish(throwing: CompanionCameraError.streamStartupFailed(
                            details: "The DAT stream stopped while starting."
                        ))
                    }
                },
                stream.errorPublisher.listen { error in
                    continuation.finish(throwing: CompanionCameraError.streamStartupFailed(
                        details: error.localizedDescription
                    ))
                },
            ]
            stream.start()
            continuation.onTermination = { _ in
                startupListeners.tokens.removeAll()
            }
        }

        try await withThrowingTaskGroup(of: Void.self) { group in
            group.addTask {
                for try await _ in streamStates {
                    return
                }
                throw CompanionCameraError.streamStartupFailed(
                    details: "The DAT stream ended before reaching a streaming state."
                )
            }
            group.addTask {
                try await Task.sleep(for: timeout)
                throw CompanionCameraError.streamStartupTimedOut
            }
            _ = try await group.next()
            group.cancelAll()
        }
    }

    func stopSession() throws {
        try lifecycle.requireReady()
        stream?.stop()
        session?.stop()
        stream = nil
        session = nil
        listenerTokens.removeAll()
        pauseRequested = false
    }

    func captureJPEG() async throws -> Data {
        try lifecycle.requireReady()
        guard let stream, photoContinuation == nil else {
            throw CompanionCameraError.notStreaming
        }
        return try await withCheckedThrowingContinuation { continuation in
            photoContinuation = continuation
            guard stream.capturePhoto(format: .jpeg) else {
                resumePhoto(with: .failure(CompanionCameraError.captureRejected))
                return
            }
            Task { [weak self] in
                try? await Task.sleep(for: .seconds(15))
                self?.resumePhoto(with: .failure(CompanionCameraError.captureTimedOut))
            }
        }
    }

    private func resumePhoto(with result: Result<Data, Error>) {
        guard let continuation = photoContinuation else { return }
        photoContinuation = nil
        continuation.resume(with: result)
    }

    private func configuredWearables() throws -> any WearablesInterface {
        try lifecycle.requireReady()
        guard let wearables else {
            throw CompanionCameraError.notConfigured
        }
        return wearables
    }

    private static func map(_ state: DeviceSessionState) -> DeviceSessionPhase {
        switch state {
        case .idle: .idle
        case .starting: .starting
        case .started: .started
        case .paused: .paused
        case .stopping: .stopping
        case .stopped: .stopped
        }
    }

    private static func map(_ state: RegistrationState) -> RegistrationPhase {
        switch state {
        case .unavailable: .unavailable
        case .available: .available
        case .registering: .registering
        case .registered: .registered
        @unknown default: .unavailable
        }
    }

    private static func createMockCaptureImage() throws -> URL {
        guard let data = mockImage().jpegData(compressionQuality: 0.9) else {
            throw CompanionCameraError.captureRejected
        }
        let url = FileManager.default.temporaryDirectory.appending(path: "splat-capture-mock.jpg")
        try data.write(to: url, options: .atomic)
        return url
    }

    private static func mockImage() -> UIImage {
        let renderer = UIGraphicsImageRenderer(size: CGSize(width: 360, height: 640))
        return renderer.image { context in
            UIColor(red: 0.05, green: 0.08, blue: 0.13, alpha: 1).setFill()
            context.fill(CGRect(x: 0, y: 0, width: 360, height: 640))
            UIColor(red: 0.43, green: 0.67, blue: 0.89, alpha: 1).setStroke()
            let frame = UIBezierPath(ovalIn: CGRect(x: 70, y: 210, width: 220, height: 220))
            frame.lineWidth = 8
            frame.stroke()
            let text = "MOCK DEVICE KIT" as NSString
            text.draw(
                at: CGPoint(x: 93, y: 470),
                withAttributes: [
                    .font: UIFont.boldSystemFont(ofSize: 18),
                    .foregroundColor: UIColor.white,
                ]
            )
        }
    }
}
