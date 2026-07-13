import Foundation
import AVFoundation
import UIKit

enum FallbackCaptureError: LocalizedError {
    case cameraUnavailable
    case cameraPermissionDenied
    case cameraPermissionRestricted
    case cameraNotReady
    case captureInProgress

    var errorDescription: String? {
        switch self {
        case .cameraUnavailable:
            "iPhone camera is unavailable on this device. Use a physical device with a camera."
        case .cameraPermissionDenied:
            "iPhone camera permission is denied. Enable Camera access for Splat Capture in Settings and try again."
        case .cameraPermissionRestricted:
            "iPhone camera access is restricted on this device."
        case .cameraNotReady:
            "iPhone fallback camera is not ready yet. Wait a moment and try again."
        case .captureInProgress:
            "A fallback capture is already in progress."
        }
    }
}

protocol FallbackCameraCapturing: AnyObject, Sendable {
    var previewSession: AVCaptureSession? { get }
    func start() async throws
    func stop()
    func captureJPEG() async throws -> Data
}

@MainActor
final class AppModel: ObservableObject {
    struct ReconstructionResultViewData: Sendable {
        let provider: ReconstructionResultProvider
        let format: String?
        let notes: String?
        let thumbnailURL: URL?
        let resultURL: URL?
    }

    struct ReconstructionJobViewData: Identifiable, Sendable {
        let id: String
        let jobID: String
        let sessionID: String
        let submittedAt: Date
        let updatedAt: Date
        let status: ReconstructionStatus
        let progress: Double?
        let message: String
        let result: ReconstructionResultViewData?
    }

    @Published private(set) var configurationMessage = "Checking configuration..."
    @Published private(set) var registration: RegistrationPhase = .unavailable
    @Published private(set) var cameraPermission: CameraPermissionPhase = .unknown
    @Published private(set) var deviceCount = 0
    @Published private(set) var deviceReady = false
    @Published private(set) var sessionPhase: DeviceSessionPhase = .idle
    @Published private(set) var previewImage: UIImage?
    @Published private(set) var currentStation = CaptureStation.sequence[0]
    @Published private(set) var completedStationCount = 0
    @Published private(set) var ringProgress: [CaptureRing: Int] = [:]
    @Published private(set) var reconstructionStatus: ReconstructionStatus?
    @Published private(set) var reconstructionProgress: Double?
    @Published private(set) var reconstructionMessage = "Not submitted"
    @Published private(set) var reconstructionResult: ReconstructionResultViewData?
    @Published private(set) var reconstructionJobs: [ReconstructionJobViewData] = []
    @Published private(set) var activeReconstructionJobID: String?
    @Published private(set) var isSubmittingReconstruction = false
    @Published private(set) var notificationsEnabled = false
    @Published private(set) var isBusy = false
    @Published private(set) var captureInputMode: CaptureInputMode = .glassesLive
    @Published private(set) var fallbackMessage: String?
    @Published var errorMessage: String?

    var canRegister: Bool {
        !camera.isMock && registration != .registered && registration != .registering && startupState == .started
    }

    var canRequestCamera: Bool {
        !camera.isMock && cameraPermission != .granted && startupState == .started
    }

    var canStartSession: Bool {
        startupState == .started && (deviceReady || captureInputMode == .iphoneFallback) && !isBusy
            && sessionPhase != .starting && sessionPhase != .discovering
    }

    var setupGuidance: String {
        if camera.isMock {
            return deviceReady
                ? "Mock glasses are active and ready."
                : "Setting up and discovering mock glasses..."
        }
        return deviceReady
            ? "Physical glasses discovered."
            : "Waiting for registered glasses. Keep them powered on, unfolded, worn, and nearby."
    }

    let camera: CompanionCamera
    private let client: CaptureBackendClient?
    private let fallbackCamera: FallbackCameraCapturing
    private let notifications = NotificationManager()
    private let serverUsesLoopbackHost: Bool
    private let backendBaseURL: URL?
    private var captureSessionID: String?
    private var monitoringTask: Task<Void, Never>?
    private var startupState: StartupState = .idle

    var activeReconstruction: ReconstructionJobViewData? {
        guard let activeReconstructionJobID else { return nil }
        return reconstructionJobs.first(where: { $0.jobID == activeReconstructionJobID })
    }

    var previousReconstructions: [ReconstructionJobViewData] {
        reconstructionJobs
            .filter { $0.jobID != activeReconstructionJobID }
            .sorted { $0.updatedAt > $1.updatedAt }
    }

    var hasActiveReconstructionInFlight: Bool {
        activeReconstruction?.status.isTerminal == false
    }

    var canSubmitReconstruction: Bool {
        completedStationCount >= 36 && !isSubmittingReconstruction && !hasActiveReconstructionInFlight
    }

    var fallbackPreviewSession: AVCaptureSession? {
        fallbackCamera.previewSession
    }

    private enum StartupState {
        case idle
        case starting
        case started
    }

    init() {
        do {
            let configuration = try AppConfiguration.load()
            camera = MetaDATCamera(useMockDevice: configuration.useDATMockDevice)
            client = BFFClient(baseURL: configuration.serverBaseURL)
            fallbackCamera = AVFoundationFallbackCameraService()
            serverUsesLoopbackHost = configuration.serverUsesLoopbackHost
            backendBaseURL = configuration.serverBaseURL
            configurationMessage = configuration.useDATMockDevice
                ? "Setting up DAT 0.8 Mock Device Kit..."
                : "DAT 0.8 physical-glasses mode\(configuration.hasReleaseCredentials ? "" : " (Developer Mode)")"
        } catch {
            camera = MetaDATCamera(useMockDevice: true)
            client = nil
            fallbackCamera = AVFoundationFallbackCameraService()
            serverUsesLoopbackHost = true
            backendBaseURL = nil
            configurationMessage = error.localizedDescription
        }
    }

    init(
        camera: CompanionCamera,
        client: CaptureBackendClient?,
        serverUsesLoopbackHost: Bool,
        configurationMessage: String,
        fallbackCamera: FallbackCameraCapturing = AVFoundationFallbackCameraService(),
        backendBaseURL: URL? = nil
    ) {
        self.camera = camera
        self.client = client
        self.serverUsesLoopbackHost = serverUsesLoopbackHost
        self.configurationMessage = configurationMessage
        self.fallbackCamera = fallbackCamera
        self.backendBaseURL = backendBaseURL
    }

    func start() async {
        guard startupState == .idle else { return }
        startupState = .starting
        do {
            try camera.configure()
            try observeSDK()
            sessionPhase = .discovering
            if camera.isMock {
                configurationMessage = "Discovering simulated Ray-Ban Meta glasses..."
                try await camera.waitForDevice(timeout: .seconds(10))
                deviceReady = true
                registration = .registered
                cameraPermission = .granted
                sessionPhase = .stopped
                configurationMessage = "Ready: DAT 0.8 Mock Device Kit, analytics opted out"
            } else {
                configurationMessage = "DAT 0.8 physical-glasses mode"
                if serverUsesLoopbackHost {
                    errorMessage = "SERVER_BASE_URL points to localhost. On iPhone this means the phone, not your Mac. Set SERVER_BASE_URL to your Mac LAN IP and rebuild."
                }
            }
            startupState = .started
        } catch {
            startupState = .idle
            errorMessage = error.localizedDescription
        }
    }

    func handleCallback(_ url: URL) async {
        await perform {
            try await self.camera.handleCallback(url)
            try await self.refreshSetupState()
        }
    }

    func register() async {
        await perform {
            self.registration = .registering
            try await self.camera.startRegistration()
        }
    }

    func requestCameraPermission() async {
        await perform {
            self.cameraPermission = try await self.camera.requestCameraPermission()
            try await self.refreshSetupState()
        }
    }

    func enableNotifications() async {
        await perform {
            self.notificationsEnabled = try await self.notifications.requestPermission()
        }
    }

    func startCaptureSession() async {
        if !camera.isMock && serverUsesLoopbackHost {
            errorMessage = "Could not connect to the server. Set SERVER_BASE_URL to your Mac LAN IP (for example, http://192.168.1.100:8788), keep npm run dev running, and ensure iPhone + Mac are on the same Wi-Fi."
            return
        }
        guard deviceReady else {
            errorMessage = camera.isMock
                ? "Mock glasses are still being discovered. Wait for Devices found to reach 1."
                : "No physical glasses are ready. Power them on, unfold them, register, and wait for discovery."
            return
        }
        guard let client else {
            errorMessage = configurationMessage
            return
        }
        await perform {
            if self.captureSessionID == nil {
                let envelope = try await client.createCaptureSession()
                self.apply(envelope)
            }
            do {
                try await self.camera.startSession(
                    onSession: { [weak self] phase in
                        Task { @MainActor in self?.sessionPhase = phase }
                    },
                    onPreview: { [weak self] snapshot in
                        Task { @MainActor in self?.previewImage = snapshot.image }
                    }
                )
                self.captureInputMode = .glassesLive
                self.fallbackMessage = nil
                self.fallbackCamera.stop()
            } catch let firstError {
                guard Self.shouldRetryStartSession(after: firstError) else {
                    throw firstError
                }
                do {
                    try self.camera.stopSession()
                } catch let cleanupError {
                    throw CompanionCameraError.streamStartupFailed(
                        details: "Initial start failed (\(firstError.localizedDescription)). Cleanup also failed (\(cleanupError.localizedDescription))."
                    )
                }
                try await Task.sleep(for: .milliseconds(350))
                do {
                    try await self.camera.startSession(
                        onSession: { [weak self] phase in
                            Task { @MainActor in self?.sessionPhase = phase }
                        },
                        onPreview: { [weak self] snapshot in
                            Task { @MainActor in self?.previewImage = snapshot.image }
                        }
                    )
                    self.captureInputMode = .glassesLive
                    self.fallbackMessage = nil
                    self.fallbackCamera.stop()
                } catch let retryError {
                    if Self.shouldRetryStartSession(after: retryError), !self.camera.isMock {
                        try await self.activateIPhoneFallback(trigger: retryError)
                        return
                    }
                    throw retryError
                }
            }
        }
    }

    func stopCaptureSession() {
        do {
            try camera.stopSession()
            sessionPhase = .stopped
            if captureInputMode == .iphoneFallback {
                fallbackCamera.stop()
            }
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func pauseCaptureSession() {
        do {
            try camera.pauseSession()
            sessionPhase = .paused
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func resumeCaptureSession() async {
        await perform {
            try await self.camera.resumeSession(
                onSession: { [weak self] phase in
                    Task { @MainActor in self?.sessionPhase = phase }
                },
                onPreview: { [weak self] snapshot in
                    Task { @MainActor in self?.previewImage = snapshot.image }
                }
            )
        }
    }

    func captureCurrentStation() async {
        guard let client, let captureSessionID else {
            errorMessage = "Create and start a capture session first."
            return
        }
        await perform {
            let jpeg = try await self.captureJPEGForCurrentMode()
            let station = self.currentStation
            let upload = PhotoUpload(
                fileName: "\(station.id).jpg",
                ring: station.ring,
                stationIndex: station.stationIndex,
                overlapEstimate: 0.85,
                blurScore: 0.1,
                lightingScore: 0.9,
                distanceVariance: 0.08
            )
            let response = try await client.uploadPhoto(
                sessionID: captureSessionID,
                photo: upload,
                jpeg: jpeg
            )
            self.apply(response.guidance)
        }
    }

    func submitReconstruction() async {
        guard let client, let captureSessionID else {
            errorMessage = "Create and start a capture session first."
            return
        }
        guard completedStationCount >= 36 else {
            errorMessage = "Capture all 36 stations before submitting reconstruction."
            return
        }
        guard !isSubmittingReconstruction else {
            errorMessage = "A reconstruction submit is already in progress."
            return
        }
        if let active = activeReconstruction, !active.status.isTerminal {
            errorMessage = "Reconstruction \(active.jobID) is still in progress. Wait for it to finish before submitting again."
            return
        }
        await perform {
            self.isSubmittingReconstruction = true
            defer { self.isSubmittingReconstruction = false }
            let response = try await client.submitReconstruction(sessionID: captureSessionID)
            let submittedAt = Date()
            self.upsertReconstructionJob(
                jobID: response.jobId,
                sessionID: captureSessionID,
                submittedAt: submittedAt,
                status: .queued,
                progress: nil,
                message: "Submitted to backend. Waiting for status update...",
                result: nil
            )
            self.activeReconstructionJobID = response.jobId
            self.refreshReconstructionSummary()
            self.monitor(jobID: response.jobId, client: client)
        }
    }

    private func observeSDK() throws {
        let registrationUpdates = try camera.registrationUpdates()
        let deviceCountUpdates = try camera.deviceCountUpdates()
        let readinessUpdates = try camera.readinessUpdates()
        Task {
            for await value in registrationUpdates {
                registration = camera.isMock ? .registered : value
            }
        }
        Task {
            for await value in deviceCountUpdates {
                deviceCount = value
                if value > 0 {
                    if camera.isMock {
                        registration = .registered
                        cameraPermission = .granted
                    } else if cameraPermission == .unknown {
                        cameraPermission = (try? await camera.cameraPermission()) ?? .unknown
                    }
                }
            }
        }
        Task {
            for await value in readinessUpdates {
                deviceReady = value
                if sessionPhase == .idle || sessionPhase == .discovering || sessionPhase == .stopped {
                    sessionPhase = value ? .stopped : .discovering
                }
            }
        }
    }

    private func refreshSetupState() async throws {
        registration = try camera.registrationPhase()
        cameraPermission = try await camera.cameraPermission()
    }

    private func monitor(jobID: String, client: CaptureBackendClient) {
        monitoringTask?.cancel()
        monitoringTask = Task {
            while !Task.isCancelled {
                do {
                    let response = try await client.jobStatus(jobID: jobID)
                    let resolvedResult = resolveResultViewData(from: response.result)
                    upsertReconstructionJob(
                        jobID: response.jobId,
                        sessionID: response.sessionId,
                        submittedAt: existingSubmissionDate(for: response.jobId) ?? Date(),
                        status: response.status,
                        progress: response.progress,
                        message: response.message,
                        result: resolvedResult
                    )
                    if activeReconstructionJobID == nil || activeReconstructionJobID == response.jobId {
                        activeReconstructionJobID = response.jobId
                    }
                    refreshReconstructionSummary()
                    if response.status.isTerminal {
                        if response.status.isSuccess && notificationsEnabled {
                            try? await notifications.notifySuccess(
                                jobID: jobID,
                                mock: response.status == .completedMock
                            )
                        }
                        if activeReconstructionJobID == response.jobId {
                            activeReconstructionJobID = nil
                            refreshReconstructionSummary()
                        }
                        return
                    }
                    try await Task.sleep(for: .seconds(2))
                } catch {
                    if let active = activeReconstruction {
                        upsertReconstructionJob(
                            jobID: active.jobID,
                            sessionID: active.sessionID,
                            submittedAt: active.submittedAt,
                            status: .failedLiveNotImplemented,
                            progress: active.progress,
                            message: "Status polling failed: \(error.localizedDescription)",
                            result: active.result
                        )
                        activeReconstructionJobID = nil
                        refreshReconstructionSummary()
                    }
                    errorMessage = error.localizedDescription
                    return
                }
            }
        }
    }

    private func apply(_ envelope: CaptureSessionEnvelope) {
        captureSessionID = envelope.session.id
        apply(envelope.guidance)
    }

    private func apply(_ guidance: Guidance) {
        completedStationCount = guidance.completedStationCount
        ringProgress = guidance.ringProgress
        if let next = guidance.nextStation {
            currentStation = CaptureStation(
                ring: next.ring,
                stationIndex: next.stationIndex,
                angleDeg: next.angleDeg
            )
        }
    }

    private func captureJPEGForCurrentMode() async throws -> Data {
        switch captureInputMode {
        case .glassesLive:
            return try await camera.captureJPEG()
        case .iphoneFallback:
            return try await fallbackCamera.captureJPEG()
        }
    }

    private func activateIPhoneFallback(trigger error: Error) async throws {
        try await fallbackCamera.start()
        captureInputMode = .iphoneFallback
        fallbackMessage = "DAT stream startup failed (\(error.localizedDescription)). Using temporary iPhone-camera fallback for station captures."
        previewImage = nil
        sessionPhase = .started
    }

    private func perform(_ operation: () async throws -> Void) async {
        isBusy = true
        defer { isBusy = false }
        do {
            try await operation()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func resolveResultViewData(from payload: ReconstructionResultPayload?) -> ReconstructionResultViewData? {
        guard let payload else { return nil }
        return ReconstructionResultViewData(
            provider: payload.provider,
            format: payload.splat?.format,
            notes: payload.splat?.notes,
            thumbnailURL: resolveURL(payload.splat?.thumbnailUrl),
            resultURL: resolveURL(payload.splat?.url)
        )
    }

    private func existingSubmissionDate(for jobID: String) -> Date? {
        reconstructionJobs.first(where: { $0.jobID == jobID })?.submittedAt
    }

    private func upsertReconstructionJob(
        jobID: String,
        sessionID: String,
        submittedAt: Date,
        status: ReconstructionStatus,
        progress: Double?,
        message: String,
        result: ReconstructionResultViewData?
    ) {
        let updated = ReconstructionJobViewData(
            id: jobID,
            jobID: jobID,
            sessionID: sessionID,
            submittedAt: submittedAt,
            updatedAt: Date(),
            status: status,
            progress: progress,
            message: message,
            result: result
        )
        if let existingIndex = reconstructionJobs.firstIndex(where: { $0.jobID == jobID }) {
            reconstructionJobs[existingIndex] = updated
        } else {
            reconstructionJobs.insert(updated, at: 0)
        }
        reconstructionJobs.sort { $0.updatedAt > $1.updatedAt }
    }

    private func refreshReconstructionSummary() {
        if let active = activeReconstruction {
            reconstructionStatus = active.status
            reconstructionProgress = active.progress
            reconstructionMessage = active.message
            reconstructionResult = active.result
            return
        }

        if let latest = reconstructionJobs.sorted(by: { $0.updatedAt > $1.updatedAt }).first {
            reconstructionStatus = latest.status
            reconstructionProgress = latest.progress
            reconstructionMessage = latest.message
            reconstructionResult = latest.result
            return
        }

        reconstructionStatus = nil
        reconstructionProgress = nil
        reconstructionMessage = "Not submitted"
        reconstructionResult = nil
    }

    private func resolveURL(_ rawValue: String?) -> URL? {
        guard let rawValue, !rawValue.isEmpty else { return nil }
        if let absolute = URL(string: rawValue), absolute.scheme != nil {
            return absolute
        }
        guard let backendBaseURL else { return nil }
        return backendBaseURL.appending(path: rawValue.hasPrefix("/") ? String(rawValue.dropFirst()) : rawValue)
    }

    nonisolated static func shouldRetryStartSession(after error: Error) -> Bool {
        guard let cameraError = error as? CompanionCameraError else {
            return false
        }
        switch cameraError {
        case .notStreaming, .streamStartupFailed, .streamStartupTimedOut:
            return true
        default:
            return false
        }
    }
}

final class AVFoundationFallbackCameraService: NSObject, FallbackCameraCapturing, @unchecked Sendable {
    var previewSession: AVCaptureSession? { session }

    private let session = AVCaptureSession()
    private let photoOutput = AVCapturePhotoOutput()
    private let sessionQueue = DispatchQueue(label: "com.cesium.splatcapture.fallback-camera")
    private var isConfigured = false
    private var photoContinuation: CheckedContinuation<Data, Error>?

    func start() async throws {
        let authStatus = AVCaptureDevice.authorizationStatus(for: .video)
        switch authStatus {
        case .authorized:
            break
        case .notDetermined:
            let granted = await AVCaptureDevice.requestAccess(for: .video)
            if !granted {
                throw FallbackCaptureError.cameraPermissionDenied
            }
        case .denied:
            throw FallbackCaptureError.cameraPermissionDenied
        case .restricted:
            throw FallbackCaptureError.cameraPermissionRestricted
        @unknown default:
            throw FallbackCaptureError.cameraPermissionDenied
        }

        if !isConfigured {
            try await configureSession()
        }
        await withCheckedContinuation { continuation in
            sessionQueue.async {
                if !self.session.isRunning {
                    self.session.startRunning()
                }
                continuation.resume()
            }
        }
    }

    func stop() {
        sessionQueue.async {
            if self.session.isRunning {
                self.session.stopRunning()
            }
        }
    }

    func captureJPEG() async throws -> Data {
        guard isConfigured, session.isRunning else {
            throw FallbackCaptureError.cameraNotReady
        }
        guard photoContinuation == nil else {
            throw FallbackCaptureError.captureInProgress
        }
        let settings = AVCapturePhotoSettings()
        settings.flashMode = .off
        return try await withCheckedThrowingContinuation { continuation in
            self.photoContinuation = continuation
            self.sessionQueue.async {
                self.photoOutput.capturePhoto(with: settings, delegate: self)
            }
        }
    }

    private func configureSession() async throws {
        try await withCheckedThrowingContinuation { continuation in
            sessionQueue.async {
                do {
                    self.session.beginConfiguration()
                    self.session.sessionPreset = .photo
                    self.session.inputs.forEach { self.session.removeInput($0) }
                    self.session.outputs.forEach { self.session.removeOutput($0) }

                    guard let device = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .back) else {
                        throw FallbackCaptureError.cameraUnavailable
                    }
                    let input = try AVCaptureDeviceInput(device: device)
                    guard self.session.canAddInput(input) else {
                        throw FallbackCaptureError.cameraUnavailable
                    }
                    self.session.addInput(input)
                    guard self.session.canAddOutput(self.photoOutput) else {
                        throw FallbackCaptureError.cameraUnavailable
                    }
                    self.session.addOutput(self.photoOutput)
                    self.photoOutput.isHighResolutionCaptureEnabled = false
                    self.session.commitConfiguration()
                    self.isConfigured = true
                    continuation.resume()
                } catch {
                    self.session.commitConfiguration()
                    continuation.resume(throwing: error)
                }
            }
        }
    }
}

extension AVFoundationFallbackCameraService: AVCapturePhotoCaptureDelegate {
    func photoOutput(
        _ output: AVCapturePhotoOutput,
        didFinishProcessingPhoto photo: AVCapturePhoto,
        error: Error?
    ) {
        guard let continuation = photoContinuation else { return }
        photoContinuation = nil
        if error != nil {
            continuation.resume(throwing: FallbackCaptureError.cameraUnavailable)
            return
        }
        guard let data = photo.fileDataRepresentation(), !data.isEmpty else {
            continuation.resume(throwing: CompanionCameraError.captureRejected)
            return
        }
        continuation.resume(returning: data)
    }
}
