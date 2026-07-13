import Foundation

protocol CaptureBackendClient: Sendable {
    func createCaptureSession() async throws -> CaptureSessionEnvelope
    func captureSession(id: String) async throws -> CaptureSessionEnvelope
    func uploadPhoto(sessionID: String, photo: PhotoUpload, jpeg: Data) async throws -> PhotoUploadResponse
    func submitReconstruction(sessionID: String) async throws -> JobSubmissionResponse
    func jobStatus(jobID: String) async throws -> JobStatusResponse
    func fetchConfig() async throws -> BackendConfigResponse
}

actor BFFClient {
    private let baseURL: URL
    private let session: URLSession
    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()

    init(baseURL: URL, session: URLSession = .shared) {
        self.baseURL = baseURL
        self.session = session
    }

    func createCaptureSession() async throws -> CaptureSessionEnvelope {
        try await request(path: "api/capture-sessions", method: "POST", body: Optional<String>.none)
    }

    func captureSession(id: String) async throws -> CaptureSessionEnvelope {
        try await request(path: "api/capture-sessions/\(id)", method: "GET", body: Optional<String>.none)
    }

    func uploadPhoto(sessionID: String, photo: PhotoUpload, jpeg: Data) async throws -> PhotoUploadResponse {
        var request = URLRequest(url: baseURL.appending(path: "api/capture-sessions/\(sessionID)/photos/upload"))
        request.httpMethod = "POST"
        request.timeoutInterval = 30
        request.httpBody = jpeg
        request.setValue("image/jpeg", forHTTPHeaderField: "Content-Type")
        request.setValue(photo.fileName, forHTTPHeaderField: "X-Capture-File-Name")
        request.setValue(photo.ring.rawValue, forHTTPHeaderField: "X-Capture-Ring")
        request.setValue(String(photo.stationIndex), forHTTPHeaderField: "X-Capture-Station-Index")
        request.setValue(String(photo.overlapEstimate), forHTTPHeaderField: "X-Capture-Overlap-Estimate")
        request.setValue(String(photo.blurScore), forHTTPHeaderField: "X-Capture-Blur-Score")
        request.setValue(String(photo.lightingScore), forHTTPHeaderField: "X-Capture-Lighting-Score")
        request.setValue(String(photo.distanceVariance), forHTTPHeaderField: "X-Capture-Distance-Variance")
        return try await execute(request)
    }

    func submitReconstruction(sessionID: String) async throws -> JobSubmissionResponse {
        try await request(path: "api/assets/jobs", method: "POST", body: JobSubmission(sessionId: sessionID))
    }

    func jobStatus(jobID: String) async throws -> JobStatusResponse {
        try await request(path: "api/assets/jobs/\(jobID)", method: "GET", body: Optional<String>.none)
    }

    func fetchConfig() async throws -> BackendConfigResponse {
        try await request(path: "api/config", method: "GET", body: Optional<String>.none)
    }

    private func request<Response: Decodable, Body: Encodable>(
        path: String,
        method: String,
        body: Body?
    ) async throws -> Response {
        var request = URLRequest(url: baseURL.appending(path: path))
        request.httpMethod = method
        request.timeoutInterval = 30
        if let body {
            request.httpBody = try encoder.encode(body)
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        return try await execute(request)
    }

    private func execute<Response: Decodable>(_ request: URLRequest) async throws -> Response {
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch let error as URLError {
            throw BFFError.connectivity(
                endpoint: request.url?.absoluteString ?? "unknown endpoint",
                baseURL: baseURL,
                reason: error
            )
        }
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            let message = (try? decoder.decode(ServerError.self, from: data).error) ?? "Server request failed."
            throw BFFError.http(message)
        }
        do {
            return try decoder.decode(Response.self, from: data)
        } catch let error as DecodingError {
            let method = request.httpMethod ?? "REQUEST"
            let path = request.url?.path.isEmpty == false ? request.url!.path : "/"
            throw BFFError.decoding(
                endpoint: "\(method) \(path)",
                details: Self.describe(error)
            )
        }
    }

    private static func describe(_ error: DecodingError) -> String {
        let context: DecodingError.Context
        let description: String

        switch error {
        case .typeMismatch(let type, let valueContext):
            context = valueContext
            description = "Expected \(type). \(valueContext.debugDescription)"
        case .valueNotFound(let type, let valueContext):
            context = valueContext
            description = "Missing \(type) value. \(valueContext.debugDescription)"
        case .keyNotFound(let key, let valueContext):
            context = valueContext
            description = "Missing key '\(key.stringValue)'. \(valueContext.debugDescription)"
        case .dataCorrupted(let valueContext):
            context = valueContext
            description = valueContext.debugDescription
        @unknown default:
            return error.localizedDescription
        }

        let path = context.codingPath.reduce("$") { result, key in
            if let index = key.intValue {
                return "\(result)[\(index)]"
            }
            return "\(result).\(key.stringValue)"
        }
        return "\(path): \(description)"
    }
}

extension BFFClient: CaptureBackendClient {}

private struct ServerError: Decodable {
    let error: String
}

enum BFFError: LocalizedError {
    case http(String)
    case decoding(endpoint: String, details: String)
    case connectivity(endpoint: String, baseURL: URL, reason: URLError)

    var errorDescription: String? {
        switch self {
        case .http(let message):
            return message
        case .decoding(let endpoint, let details):
            return "Could not read the response from \(endpoint). \(details)"
        case .connectivity(let endpoint, let baseURL, let reason):
            if Self.isLoopbackHost(baseURL.host) {
                return """
                Could not connect to \(endpoint). This app is running on your iPhone, so \(baseURL.host ?? "localhost") points to the phone itself. \
                Set SERVER_BASE_URL to your Mac's LAN IP (for example, http://192.168.1.100:8788), keep the Mac server running, and ensure both devices are on the same Wi-Fi network.
                """
            }
            return "Could not connect to \(endpoint). \(reason.localizedDescription)"
        }
    }

    private static func isLoopbackHost(_ host: String?) -> Bool {
        guard let host else { return false }
        let normalized = host.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return normalized == "localhost" || normalized == "127.0.0.1" || normalized == "::1"
    }
}
