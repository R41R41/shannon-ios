import Foundation

/// What the VoIP push of a call from Shannon carries: identifiers and a time. Her words are never in it;
/// the app takes them through the claim route after the owner answered.
public struct ShannonIncomingCallPayload: Equatable, Sendable {
    /// The call's identifier as the server wrote it; reports and the claim name the call with it.
    public let callID: String
    /// The same identifier, as CallKit knows the call.
    public let id: UUID
    public let reachOutID: String
    public let threadID: String
    /// When the phone stops ringing.
    public let expiresAt: Date

    public init(callID: String, id: UUID, reachOutID: String, threadID: String, expiresAt: Date) {
        self.callID = callID
        self.id = id
        self.reachOutID = reachOutID
        self.threadID = threadID
        self.expiresAt = expiresAt
    }

    /// Nil for anything that is not a complete call payload; such a push is still shown and ended at once.
    public init?(dictionary: [AnyHashable: Any]) {
        guard let callID = dictionary["callId"] as? String, let id = UUID(uuidString: callID),
              let reachOutID = dictionary["reachOutId"] as? String, !reachOutID.isEmpty, reachOutID.count <= 80,
              let threadID = dictionary["threadId"] as? String, !threadID.isEmpty, threadID.count <= 120,
              let expires = dictionary["expiresAt"] as? String, let expiresAt = Self.date(expires) else { return nil }
        self.init(callID: callID.lowercased(), id: id, reachOutID: reachOutID, threadID: threadID, expiresAt: expiresAt)
    }

    static func date(_ value: String) -> Date? {
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return fractional.date(from: value) ?? ISO8601DateFormatter().date(from: value)
    }
}

/// What became of a call, as the app tells the server. The server's closed set.
public enum ShannonIncomingCallOutcome: String, Codable, Equatable, Sendable {
    case answered
    case declined
    case unanswered
    case failed
}

/// `POST /v1/incoming-calls/registration`: this iPhone's VoIP push token, with the owner's switch.
public struct ShannonIncomingCallRegistrationDTO: Codable, Equatable, Sendable {
    public let scopeKey: String
    public let deviceToken: String
    public let environment: ShannonPushEnvironmentDTO
    public let bundleId: String
    public let enabled: Bool

    public init(scopeKey: String, deviceToken: String, environment: ShannonPushEnvironmentDTO, bundleId: String, enabled: Bool) {
        self.scopeKey = scopeKey
        self.deviceToken = deviceToken
        self.environment = environment
        self.bundleId = bundleId
        self.enabled = enabled
    }
}

public struct ShannonIncomingCallRegistrationResponseDTO: Codable, Equatable, Sendable {
    public let registered: Bool
    public let enabled: Bool
    /// False while the server cannot ring: no APNs key there, or calls switched off.
    public let available: Bool

    public init(registered: Bool, enabled: Bool, available: Bool) {
        self.registered = registered
        self.enabled = enabled
        self.available = available
    }
}

/// The server side of a call from Shannon. Only a paired device (device token) may use it.
public protocol ShannonIncomingCallServing: Sendable {
    /// Whether this device is paired; nothing is registered or reported otherwise.
    func incomingCallIsPaired() -> Bool
    func registerIncomingCalls(deviceToken: String, environment: ShannonPushEnvironmentDTO, bundleId: String, enabled: Bool) async throws -> ShannonIncomingCallRegistrationResponseDTO
    /// The owner answered: takes her words for the call. Throws when the call is over or was never this device's.
    func answerIncomingCall(reachOutID: String, callID: String) async throws -> ShannonPrivateReachOutClaimDTO
    func reportIncomingCall(callID: String, outcome: ShannonIncomingCallOutcome) async throws
}
