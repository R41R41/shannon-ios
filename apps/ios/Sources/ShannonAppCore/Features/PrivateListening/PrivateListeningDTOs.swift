import Foundation

/// Which of the owner's apps is reporting. A closed value; no device name is ever sent.
public enum ShannonPrivateListeningKind: String, Codable, Equatable, Sendable {
    case mac
    case iphone

    public static var current: ShannonPrivateListeningKind {
#if os(macOS)
        .mac
#else
        .iphone
#endif
    }
}

/// `POST /v1/private-listening`: whether only the owner can hear this app now.
public struct ShannonPrivateListeningReportDTO: Codable, Equatable, Sendable {
    public let scopeKey: String
    public let kind: ShannonPrivateListeningKind
    public let listening: Bool
    /// When the owner last used this device, ISO 8601. Sent only with `listening: true`.
    public let ownerActiveAt: String?

    public init(scopeKey: String, kind: ShannonPrivateListeningKind, listening: Bool, ownerActiveAt: Date? = nil) {
        self.scopeKey = scopeKey
        self.kind = kind
        self.listening = listening
        self.ownerActiveAt = listening ? ownerActiveAt.map { ISO8601DateFormatter().string(from: $0) } : nil
    }
}

public struct ShannonPrivateListeningResponseDTO: Codable, Equatable, Sendable {
    public let listening: Bool
    public let since: String?
    public let expiresAt: String?
    public let pollAfterSeconds: Int?

    public init(listening: Bool, since: String? = nil, expiresAt: String? = nil, pollAfterSeconds: Int? = nil) {
        self.listening = listening
        self.since = since
        self.expiresAt = expiresAt
        self.pollAfterSeconds = pollAfterSeconds
    }
}

public enum ShannonPrivateListeningError: Error, Equatable {
    /// Only a paired device reports; the build-time token never does.
    case notPaired
}

/// The server side of private listening. Only a paired device (device token) may report.
public protocol ShannonPrivateListeningServing: Sendable {
    /// The scope of the paired connection, or nil when this device is not paired.
    func privateListeningScopeKey() -> String?
    func reportPrivateListening(_ report: ShannonPrivateListeningReportDTO) async throws -> ShannonPrivateListeningResponseDTO
}
