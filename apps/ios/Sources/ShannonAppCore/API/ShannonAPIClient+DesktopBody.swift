import Foundation

/// What her desktop body on the Mac reads and sends (`docs/body-contract.md`). Every request carries
/// `X-Shannon-Body: desktop`, so the server takes it from the body's own device, derived from the app's
/// ("Her desktop body inside an app"): the window is her full body while the app stays an app.
public enum ShannonDesktopBodyWire {
    public static let header = "X-Shannon-Body"
    public static let value = "desktop"
}

/// `GET /v1/body/presence`: the snapshot, or `unchanged` for the etag the body sent back.
public struct ShannonDesktopBodyPresenceDTO: Decodable, Equatable, Sendable {
    public struct Mood: Decodable, Equatable, Sendable {
        public let expression: String?
        public let feeling: String?
        public let primary: String?
        public let intensity: Double?
        public let fromConversation: Bool?
        public let valence: Double?
        public let arousal: Double?
        public let openness: Double?
    }

    public struct Study: Decodable, Equatable, Sendable { public let awaitingReaction: Int? }
    public struct Look: Decodable, Equatable, Sendable {
        public let id: String
        public let requestedAt: String
        public let expiresAt: String
    }
    public struct ReachOut: Decodable, Equatable, Sendable {
        public let pending: Int
        public let latestId: String?
    }
    public struct Elsewhere: Decodable, Equatable, Sendable {
        public let active: Bool
        public let surface: String?
    }

    public let etag: String
    public let pollAfterSeconds: Int?
    public let unchanged: Bool?
    public let mood: Mood?
    public let doing: String?
    public let study: Study?
    public let look: Look?
    public let reachOut: ReachOut?
    public let ownerCallElsewhere: Elsewhere?

    public init(
        etag: String, pollAfterSeconds: Int? = 10, unchanged: Bool? = nil, mood: Mood? = nil, doing: String? = nil,
        study: Study? = nil, look: Look? = nil, reachOut: ReachOut? = nil, ownerCallElsewhere: Elsewhere? = nil
    ) {
        self.etag = etag
        self.pollAfterSeconds = pollAfterSeconds
        self.unchanged = unchanged
        self.mood = mood
        self.doing = doing
        self.study = study
        self.look = look
        self.reachOut = reachOut
        self.ownerCallElsewhere = ownerCallElsewhere
    }
}

/// One fact for `POST /v1/body/events`: a touch (`carry` included), who is at the Mac, or a plain event.
public struct ShannonDesktopBodyEventDTO: Encodable, Equatable, Sendable {
    public let id: String
    public let type: String
    public let audience: ShannonBodyAudience
    public let occurredAt: String
    public var durationMs: Int?
    public var strength: Double?
    public var region: String?
    public var minutesAway: Int?

    public init(id: String, type: String, audience: ShannonBodyAudience, occurredAt: String, minutesAway: Int? = nil) {
        self.id = id
        self.type = type
        self.audience = audience
        self.occurredAt = occurredAt
        self.minutesAway = minutesAway
    }

    public init(touch: ShannonBodyTouchEventDTO) {
        self.init(id: touch.id, type: touch.type, audience: touch.audience, occurredAt: touch.occurredAt)
        durationMs = touch.durationMs
        strength = touch.strength
        region = touch.region
    }
}

/// `GET /v1/body/nudges`: fixed lines the body may say at a moment it detects.
public struct ShannonBodyNudgesDTO: Decodable, Equatable, Sendable {
    public struct Nudge: Decodable, Equatable, Sendable {
        public let id: String
        public let scene: String
        public let audience: String
        public let text: String
        public let expression: String?
        public let feeling: String?
        public let expiresAt: String?
    }

    public let quietUntil: String?
    public let nudges: [Nudge]
}

/// `POST /v1/body/looks/{id}`: one frame, or why not. No text field.
public struct ShannonBodyLookAnswerDTO: Encodable, Equatable, Sendable {
    public let scopeKey: String
    public let outcome: String
    public let audience: ShannonBodyAudience?
    public let image: ShannonAppLookAnswerDTO.Image?
    public let code: String?

    public static func seen(scopeKey: String, frame: ShannonAppLookFrame) -> Self {
        .init(scopeKey: scopeKey, outcome: "seen", audience: .owner,
              image: .init(mediaType: "image/jpeg", base64: frame.jpeg.base64EncodedString(), width: frame.width, height: frame.height), code: nil)
    }

    public static func refused(scopeKey: String, code: String) -> Self {
        .init(scopeKey: scopeKey, outcome: "refused", audience: nil, image: nil, code: code)
    }
}

public struct ShannonBodyLookResponseDTO: Decodable, Equatable, Sendable {
    public struct Message: Decodable, Equatable, Sendable {
        public let id: String
        public let threadId: String?
        public let text: String
    }

    public let id: String
    public let status: String
    public let message: Message?
}

/// Her desktop body's routes. `presence` says whether the server heard the request as the body's.
public protocol ShannonDesktopBodyServing: ShannonBodyServing {
    func bodyPresence(scopeKey: String, etag: String?, audience: ShannonBodyAudience?) async throws -> (ShannonDesktopBodyPresenceDTO, heardAsBody: Bool)
    func registerDesktopBody(scopeKey: String, expressions: [String], gestures: [String], camera: Bool) async throws
    func sendBodyEvents(scopeKey: String, events: [ShannonDesktopBodyEventDTO]) async throws
    func bodyInitiatives(scopeKey: String) async throws -> ShannonInitiativeInboxDTO
    func reportReachOut(scopeKey: String, id: String, outcome: String) async throws
    func answerBodyLook(id: String, answer: ShannonBodyLookAnswerDTO) async throws -> ShannonBodyLookResponseDTO
    func bodyNudges(scopeKey: String) async throws -> ShannonBodyNudgesDTO
}

/// The app's client, speaking for its desktop body. The touch routes register a full body with the camera as the
/// owner set it (`camera()`), not a touch-only one.
public struct ShannonDesktopBodyClient: ShannonDesktopBodyServing {
    let api: ShannonAPIClient
    /// The owner's camera switch for her body, read on the main actor when the touch route registers.
    let camera: @MainActor @Sendable () -> Bool

    public init(api: ShannonAPIClient, camera: @escaping @MainActor @Sendable () -> Bool) {
        self.api = api
        self.camera = camera
    }

    public func bodyPresence(scopeKey: String, etag: String?, audience: ShannonBodyAudience?) async throws -> (ShannonDesktopBodyPresenceDTO, heardAsBody: Bool) {
        let connection = api.currentConnection()
        var components = URLComponents(url: api.baseURL.appending(path: "/v1/body/presence"), resolvingAgainstBaseURL: false)
        components?.queryItems = [URLQueryItem(name: "scopeKey", value: connection?.scopeKey ?? scopeKey)]
            + (etag.map { [URLQueryItem(name: "etag", value: $0)] } ?? [])
            + (audience.map { [URLQueryItem(name: "audience", value: $0.rawValue)] } ?? [])
        guard let url = components?.url else { throw ShannonAPIError.invalidResponse }
        var request = request(url: url, method: "GET", connection: connection)
        request.timeoutInterval = 15
        let (data, http) = try await send(request)
        let heard = http.value(forHTTPHeaderField: ShannonDesktopBodyWire.header)?.lowercased() == ShannonDesktopBodyWire.value
        return (try JSONDecoder().decode(ShannonDesktopBodyPresenceDTO.self, from: data), heard)
    }

    public func registerDesktopBody(scopeKey: String, expressions: [String], gestures: [String], camera: Bool) async throws {
        let connection = api.currentConnection()
        var request = request(path: "/v1/body/capabilities", method: "PUT", connection: connection)
        request.httpBody = try JSONEncoder().encode(Capabilities(
            scopeKey: connection?.scopeKey ?? scopeKey,
            expressions: ShannonBodyRegistration.identifiers(expressions, limit: 64),
            gestures: ShannonBodyRegistration.identifiers(gestures, limit: 32),
            flags: ["camera": camera], surface: "mac"))
        _ = try await send(request)
    }

    public func sendBodyEvents(scopeKey: String, events: [ShannonDesktopBodyEventDTO]) async throws {
        let connection = api.currentConnection()
        var request = request(path: "/v1/body/events", method: "POST", connection: connection)
        request.httpBody = try JSONEncoder().encode(Events(scopeKey: connection?.scopeKey ?? scopeKey, events: events))
        _ = try await send(request)
    }

    public func bodyInitiatives(scopeKey: String) async throws -> ShannonInitiativeInboxDTO {
        let connection = api.currentConnection()
        var components = URLComponents(url: api.baseURL.appending(path: "/v1/initiatives"), resolvingAgainstBaseURL: false)
        components?.queryItems = [URLQueryItem(name: "scopeKey", value: connection?.scopeKey ?? scopeKey)]
        guard let url = components?.url else { throw ShannonAPIError.invalidResponse }
        return try JSONDecoder().decode(ShannonInitiativeInboxDTO.self, from: try await send(request(url: url, method: "GET", connection: connection)).0)
    }

    public func reportReachOut(scopeKey: String, id: String, outcome: String) async throws {
        let connection = api.currentConnection()
        guard let encoded = id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed.subtracting(CharacterSet(charactersIn: "/"))) else { return }
        var request = request(path: "/v1/body/reach-outs/\(encoded)/delivery", method: "POST", connection: connection)
        request.httpBody = try JSONEncoder().encode(["scopeKey": connection?.scopeKey ?? scopeKey, "outcome": outcome])
        _ = try await send(request)
    }

    public func answerBodyLook(id: String, answer: ShannonBodyLookAnswerDTO) async throws -> ShannonBodyLookResponseDTO {
        let connection = api.currentConnection()
        guard let encoded = id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed.subtracting(CharacterSet(charactersIn: "/"))) else {
            throw ShannonAPIError.invalidResponse
        }
        var request = request(path: "/v1/body/looks/\(encoded)", method: "POST", connection: connection)
        // The server holds the answer while the model looks (up to 20 seconds).
        request.timeoutInterval = 30
        var scoped = answer
        if let connection { scoped = ShannonBodyLookAnswerDTO(scopeKey: connection.scopeKey, outcome: answer.outcome, audience: answer.audience, image: answer.image, code: answer.code) }
        request.httpBody = try JSONEncoder().encode(scoped)
        return try JSONDecoder().decode(ShannonBodyLookResponseDTO.self, from: try await send(request).0)
    }

    public func bodyNudges(scopeKey: String) async throws -> ShannonBodyNudgesDTO {
        let connection = api.currentConnection()
        var components = URLComponents(url: api.baseURL.appending(path: "/v1/body/nudges"), resolvingAgainstBaseURL: false)
        components?.queryItems = [URLQueryItem(name: "scopeKey", value: connection?.scopeKey ?? scopeKey)]
        guard let url = components?.url else { throw ShannonAPIError.invalidResponse }
        return try JSONDecoder().decode(ShannonBodyNudgesDTO.self, from: try await send(request(url: url, method: "GET", connection: connection)).0)
    }

    // MARK: The touch routes, as the touch coordinator uses them

    public func registerTouchBody(scopeKey: String, expressions: [String], gestures: [String]) async throws {
        try await registerDesktopBody(scopeKey: scopeKey, expressions: expressions, gestures: gestures, camera: await camera())
    }

    public func sendBodyTouches(scopeKey: String, events: [ShannonBodyTouchEventDTO]) async throws {
        try await sendBodyEvents(scopeKey: scopeKey, events: events.map(ShannonDesktopBodyEventDTO.init(touch:)))
    }

    public func askBodyReaction(_ reaction: ShannonBodyReactionRequestDTO) async throws -> ShannonBodyReactionAnswerDTO {
        let connection = api.currentConnection()
        var request = request(path: "/v1/body/reactions", method: "POST", connection: connection)
        request.timeoutInterval = ShannonBodyRegistration.reactionTimeoutSeconds
        var scoped = reaction
        if let connection { scoped.scopeKey = connection.scopeKey }
        request.httpBody = try JSONEncoder().encode(scoped)
        return try JSONDecoder().decode(ShannonBodyReactionAnswerDTO.self, from: try await send(request).0)
    }

    // MARK: The wire

    private func request(path: String, method: String, connection: ShannonConnectionCredential?) -> URLRequest {
        var request = request(url: api.baseURL.appending(path: path), method: method, connection: connection)
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        return request
    }

    private func request(url: URL, method: String, connection: ShannonConnectionCredential?) -> URLRequest {
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.timeoutInterval = 15
        request.setValue(ShannonDesktopBodyWire.value, forHTTPHeaderField: ShannonDesktopBodyWire.header)
        api.authorize(&request, connection: connection)
        return request
    }

    private func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let (data, response) = try await api.session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw ShannonAPIError.invalidResponse }
        guard (200..<300).contains(http.statusCode) else {
            throw ShannonBodyRefusal(status: http.statusCode, code: (try? JSONDecoder().decode(ErrorBody.self, from: data))?.error)
        }
        return (data, http)
    }

    private struct Capabilities: Encodable {
        let scopeKey: String
        let expressions: [String]
        let gestures: [String]
        let flags: [String: Bool]
        let surface: String
    }

    private struct Events: Encodable {
        let scopeKey: String
        let events: [ShannonDesktopBodyEventDTO]
    }

    private struct ErrorBody: Decodable { let error: String? }
}
