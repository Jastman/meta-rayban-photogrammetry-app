import Foundation

struct AppConfiguration: Sendable {
    let serverBaseURL: URL
    let serverUsesLoopbackHost: Bool
    let callbackScheme: String
    let hasReleaseCredentials: Bool
    let analyticsOptOut: Bool
    let useDATMockDevice: Bool

    static func load(bundle: Bundle = .main) throws -> AppConfiguration {
        guard
            let serverValue = bundle.object(forInfoDictionaryKey: "SERVER_BASE_URL") as? String,
            let serverURL = URL(string: serverValue),
            !serverValue.contains("$(")
        else {
            throw ConfigurationError.invalidServerURL
        }

        let dat = bundle.object(forInfoDictionaryKey: "MWDAT") as? [String: Any]
        let callback = dat?["AppLinkURLScheme"] as? String ?? ""
        let appID = dat?["MetaAppID"] as? String ?? ""
        let token = dat?["ClientToken"] as? String ?? ""
        let analytics = dat?["Analytics"] as? [String: Any]
        let useMockValue = bundle.object(forInfoDictionaryKey: "USE_DAT_MOCK_DEVICE") as? String
        #if targetEnvironment(simulator)
        let defaultUseMock = true
        #else
        let defaultUseMock = false
        #endif
        let normalizedMockValue = useMockValue?.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
        let useMock = normalizedMockValue == "YES" || (normalizedMockValue?.isEmpty != false && defaultUseMock)

        return AppConfiguration(
            serverBaseURL: serverURL,
            serverUsesLoopbackHost: Self.isLoopbackHost(serverURL.host),
            callbackScheme: callback,
            hasReleaseCredentials: !appID.isEmpty && !token.isEmpty,
            analyticsOptOut: analytics?["OptOut"] as? Bool ?? false,
            useDATMockDevice: useMock
        )
    }

    private static func isLoopbackHost(_ host: String?) -> Bool {
        guard let host else { return false }
        let normalized = host.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return normalized == "localhost" || normalized == "127.0.0.1" || normalized == "::1"
    }
}

enum ConfigurationError: LocalizedError {
    case invalidServerURL

    var errorDescription: String? {
        "SERVER_BASE_URL is missing or invalid. Set it in Config/Local.xcconfig."
    }
}
