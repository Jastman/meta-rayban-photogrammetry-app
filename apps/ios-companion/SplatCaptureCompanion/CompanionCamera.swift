import Foundation
import UIKit

struct CameraSnapshot: @unchecked Sendable {
    let image: UIImage
}

protocol CompanionCamera: AnyObject, Sendable {
    var isMock: Bool { get }
    func configure() throws
    func registrationUpdates() throws -> AsyncStream<RegistrationPhase>
    func registrationPhase() throws -> RegistrationPhase
    func deviceCountUpdates() throws -> AsyncStream<Int>
    func readinessUpdates() throws -> AsyncStream<Bool>
    func waitForDevice(timeout: Duration) async throws
    func startRegistration() async throws
    func handleCallback(_ url: URL) async throws
    func cameraPermission() async throws -> CameraPermissionPhase
    func requestCameraPermission() async throws -> CameraPermissionPhase
    func startSession(
        onSession: @escaping @Sendable (DeviceSessionPhase) -> Void,
        onPreview: @escaping @Sendable (CameraSnapshot) -> Void
    ) async throws
    func stopSession() throws
    func pauseSession() throws
    func resumeSession(
        onSession: @escaping @Sendable (DeviceSessionPhase) -> Void,
        onPreview: @escaping @Sendable (CameraSnapshot) -> Void
    ) async throws
    func captureJPEG() async throws -> Data
}

enum CompanionCameraError: LocalizedError {
    case notConfigured
    case configurationInProgress
    case deviceDiscoveryTimedOut(isMock: Bool)
    case mockCameraFeedMissing
    case notStreaming
    case streamStartupFailed(details: String)
    case streamStartupTimedOut
    case captureRejected
    case captureTimedOut

    var errorDescription: String? {
        switch self {
        case .notConfigured: "The glasses SDK is not configured yet. Wait for setup to finish and try again."
        case .configurationInProgress: "The glasses SDK is currently being configured."
        case .deviceDiscoveryTimedOut(let isMock):
            if isMock {
                "The Mock Device Kit did not publish an eligible device within 10 seconds. Restart the app to reset mock discovery."
            } else {
                "No eligible glasses appeared within 10 seconds. Keep the glasses powered on, unfolded, worn, and registered, then try again."
            }
        case .mockCameraFeedMissing: "The bundled Mock Device Kit camera feed is missing."
        case .notStreaming: "Start the glasses camera session before capturing."
        case .streamStartupFailed(let details):
            "Could not start the glasses camera stream. \(details)"
        case .streamStartupTimedOut:
            "Could not start the glasses camera stream within 5 seconds. Keep the glasses worn/unfolded and try again."
        case .captureRejected: "The glasses rejected the photo request."
        case .captureTimedOut: "The glasses did not return a photo in time."
        }
    }
}

enum DeviceReadinessGate {
    static func wait(
        initialCount: Int,
        updates: AsyncStream<Int>,
        timeout: Duration,
        timeoutError: @escaping @Sendable () -> Error
    ) async throws {
        guard initialCount > 0 else {
            try await withThrowingTaskGroup(of: Void.self) { group in
                group.addTask {
                    for await count in updates {
                        if count > 0 {
                            return
                        }
                    }
                    try Task.checkCancellation()
                    throw timeoutError()
                }
                group.addTask {
                    try await Task.sleep(for: timeout)
                    throw timeoutError()
                }

                _ = try await group.next()
                group.cancelAll()
            }
            return
        }
    }
}

final class CameraConfigurationLifecycle {
    private enum State {
        case unconfigured
        case configuringSDK
        case sdkConfigured
        case configuringAdapter
        case ready
    }

    private var state: State = .unconfigured

    func configure(
        sdk: () throws -> Void,
        adapter: () throws -> Void
    ) throws {
        switch state {
        case .ready:
            return
        case .configuringSDK, .configuringAdapter:
            throw CompanionCameraError.configurationInProgress
        case .unconfigured:
            state = .configuringSDK
            do {
                try sdk()
                state = .sdkConfigured
            } catch {
                state = .unconfigured
                throw error
            }
            fallthrough
        case .sdkConfigured:
            state = .configuringAdapter
            do {
                try adapter()
                state = .ready
            } catch {
                state = .sdkConfigured
                throw error
            }
        }
    }

    func requireReady() throws {
        guard state == .ready else {
            throw CompanionCameraError.notConfigured
        }
    }
}
