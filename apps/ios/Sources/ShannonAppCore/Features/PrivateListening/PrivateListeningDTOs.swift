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
    /// The app would say a message of hers aloud now. Sent only with `listening: true`.
    public let speaks: Bool?
    /// When the owner last used this device, ISO 8601. Sent only with `listening: true`.
    public let ownerActiveAt: String?

    public init(
        scopeKey: String, kind: ShannonPrivateListeningKind, listening: Bool, speaks: Bool = false, ownerActiveAt: Date? = nil
    ) {
        self.scopeKey = scopeKey
        self.kind = kind
        self.listening = listening
        self.speaks = listening ? speaks : nil
        self.ownerActiveAt = listening ? ownerActiveAt.map { ISO8601DateFormatter().string(from: $0) } : nil
    }
}

/// A message she started on her own that this app should say now. An identifier; its words come with the claim.
public struct ShannonPrivateReachOutOfferDTO: Codable, Equatable, Sendable {
    public let id: String
    public let createdAt: String

    public init(id: String, createdAt: String) {
        self.id = id
        self.createdAt = createdAt
    }
}

public struct ShannonPrivateListeningResponseDTO: Codable, Equatable, Sendable {
    public let listening: Bool
    public let since: String?
    public let expiresAt: String?
    public let pollAfterSeconds: Int?
    /// What the server stored for `speaks`. Absent when the server does not have messages said through earphones
    /// (an older server, or the feature switched off there): nothing will be offered to this app.
    public let speaks: Bool?
    public let reachOut: ShannonPrivateReachOutOfferDTO?

    public init(
        listening: Bool, since: String? = nil, expiresAt: String? = nil, pollAfterSeconds: Int? = nil,
        speaks: Bool? = nil, reachOut: ShannonPrivateReachOutOfferDTO? = nil
    ) {
        self.listening = listening
        self.since = since
        self.expiresAt = expiresAt
        self.pollAfterSeconds = pollAfterSeconds
        self.speaks = speaks
        self.reachOut = reachOut
    }
}

/// Her message as the claiming app speaks it.
public struct ShannonPrivateReachOutMessageDTO: Codable, Equatable, Sendable {
    public let id: String
    public let threadId: String
    public let content: String
    public let reason: String?
    public let createdAt: String

    public init(id: String, threadId: String, content: String, reason: String? = nil, createdAt: String) {
        self.id = id
        self.threadId = threadId
        self.content = content
        self.reason = reason
        self.createdAt = createdAt
    }
}

/// The answer of `POST /v1/private-listening/reach-outs/{id}/claim`: this device, and no other, says the message.
public struct ShannonPrivateReachOutClaimDTO: Codable, Equatable, Sendable {
    /// `claimed`, or `held` when this device asked before.
    public let status: String
    /// True when this device already reported that it spoke the message.
    public let spoken: Bool
    /// How long to keep the microphone open for his answer; zero means do not listen.
    public let listenSeconds: Int
    public let message: ShannonPrivateReachOutMessageDTO

    public init(status: String, spoken: Bool, listenSeconds: Int, message: ShannonPrivateReachOutMessageDTO) {
        self.status = status
        self.spoken = spoken
        self.listenSeconds = listenSeconds
        self.message = message
    }
}

/// What the claiming app did with her message.
public enum ShannonPrivateReachOutOutcome: String, Codable, Equatable, Sendable {
    /// It was said through his earphones.
    case spoken = "shown_spoken"
    /// Private listening had ended; nothing was said and the message is given back.
    case notSpoken = "not_spoken"
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
    /// Takes one message of hers for this device. Throws when another surface has it or it must not be spoken.
    func claimPrivateReachOut(id: String) async throws -> ShannonPrivateReachOutClaimDTO
    func reportPrivateReachOut(id: String, outcome: ShannonPrivateReachOutOutcome) async throws
}
