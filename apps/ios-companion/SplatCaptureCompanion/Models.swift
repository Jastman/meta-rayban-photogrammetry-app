import Foundation

enum CaptureRing: String, Codable, CaseIterable, Sendable {
    case high
    case middle
    case low

    var title: String { rawValue.capitalized }
}

struct CaptureStation: Identifiable, Equatable, Sendable {
    let ring: CaptureRing
    let stationIndex: Int
    let angleDeg: Int

    var id: String { "\(ring.rawValue)-\(stationIndex)" }

    static let sequence: [CaptureStation] = CaptureRing.allCases.flatMap { ring in
        (0..<12).map { CaptureStation(ring: ring, stationIndex: $0, angleDeg: $0 * 30) }
    }
}

enum RegistrationPhase: String, Sendable {
    case unavailable
    case available
    case registering
    case registered
}

enum CameraPermissionPhase: String, Sendable {
    case unknown
    case denied
    case granted
}

enum DeviceSessionPhase: String, Sendable {
    case idle
    case discovering
    case starting
    case started
    case paused
    case stopping
    case stopped
}

enum CaptureInputMode: String, Sendable {
    case glassesLive
    case iphoneFallback
}

enum ReconstructionStatus: String, Codable, Sendable {
    case queued
    case processing
    case completed
    case completedMock = "completed_mock"
    case blockedNoCredentials = "blocked_no_credentials"
    case failedLiveNotImplemented = "failed_live_not_implemented"

    var isSuccess: Bool { self == .completed || self == .completedMock }
    var isTerminal: Bool { isSuccess || self == .blockedNoCredentials || self == .failedLiveNotImplemented }
}

struct Guidance: Codable, Sendable {
    let photoCount: Int
    let completedStationCount: Int
    let requiredStationCount: Int
    let ringProgress: [CaptureRing: Int]
    let nextStation: NextStation?

    private enum CodingKeys: String, CodingKey {
        case photoCount
        case completedStationCount
        case requiredStationCount
        case ringProgress
        case nextStation
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        photoCount = try container.decode(Int.self, forKey: .photoCount)
        completedStationCount = try container.decode(Int.self, forKey: .completedStationCount)
        requiredStationCount = try container.decode(Int.self, forKey: .requiredStationCount)
        nextStation = try container.decodeIfPresent(NextStation.self, forKey: .nextStation)

        let serializedProgress = try container.decode([String: Int].self, forKey: .ringProgress)
        var typedProgress: [CaptureRing: Int] = [:]
        for (key, value) in serializedProgress {
            guard let ring = CaptureRing(rawValue: key) else {
                throw DecodingError.dataCorruptedError(
                    forKey: .ringProgress,
                    in: container,
                    debugDescription: "Unknown capture ring '\(key)'."
                )
            }
            typedProgress[ring] = value
        }

        let missingRings = CaptureRing.allCases.filter { typedProgress[$0] == nil }
        guard missingRings.isEmpty else {
            throw DecodingError.dataCorruptedError(
                forKey: .ringProgress,
                in: container,
                debugDescription: "Missing capture ring values: \(missingRings.map(\.rawValue).joined(separator: ", "))."
            )
        }
        ringProgress = typedProgress
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(photoCount, forKey: .photoCount)
        try container.encode(completedStationCount, forKey: .completedStationCount)
        try container.encode(requiredStationCount, forKey: .requiredStationCount)
        try container.encode(
            Dictionary(uniqueKeysWithValues: ringProgress.map { ($0.key.rawValue, $0.value) }),
            forKey: .ringProgress
        )
        try container.encodeIfPresent(nextStation, forKey: .nextStation)
    }

    struct NextStation: Codable, Sendable {
        let ring: CaptureRing
        let stationIndex: Int
        let angleDeg: Int
    }
}

struct CaptureSessionEnvelope: Codable, Sendable {
    let session: CaptureSessionDTO
    let guidance: Guidance
}

struct CaptureSessionDTO: Codable, Sendable {
    let id: String
}

struct PhotoUpload: Codable, Sendable {
    let fileName: String
    let ring: CaptureRing
    let stationIndex: Int
    let overlapEstimate: Double
    let blurScore: Double
    let lightingScore: Double
    let distanceVariance: Double
}

struct PhotoUploadResponse: Codable, Sendable {
    let added: Int
    let guidance: Guidance
}

struct JobSubmission: Encodable, Sendable {
    let sessionId: String
    let requestedPipeline = "gaussian_splats"
    let mode = "auto"
    let useMockFallback = true
}

struct JobSubmissionResponse: Codable, Sendable {
    let jobId: String
}

enum ReconstructionResultProvider: String, Codable, Sendable {
    case mock
    case ion
}

struct ReconstructionSplatResult: Codable, Sendable {
    let id: String?
    let format: String?
    let url: String?
    let thumbnailUrl: String?
    let notes: String?
}

struct ReconstructionResultPayload: Codable, Sendable {
    let provider: ReconstructionResultProvider
    let splat: ReconstructionSplatResult?
}

struct JobStatusResponse: Codable, Sendable {
    let jobId: String
    let sessionId: String
    let status: ReconstructionStatus
    let progress: Double
    let message: String
    let result: ReconstructionResultPayload?

    init(
        jobId: String,
        sessionId: String,
        status: ReconstructionStatus,
        progress: Double,
        message: String,
        result: ReconstructionResultPayload? = nil
    ) {
        self.jobId = jobId
        self.sessionId = sessionId
        self.status = status
        self.progress = progress
        self.message = message
        self.result = result
    }
}
