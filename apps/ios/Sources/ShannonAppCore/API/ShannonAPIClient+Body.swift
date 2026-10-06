import Foundation

/// Who could see or cause what happened to her body (`docs/body-contract.md`, Audience).
public enum ShannonBodyAudience: String, Codable, Equatable, Sendable {
    case owner
    case others
}

/// Touch vocabulary 2 (`docs/body-contract.md`, "The signal"): the number the server says on `PUT /v1/body/capabilities`
/// and on presence. Its fields go only to a server that said 2 or more, because a server from before them refuses an
/// unknown field with `400`. A server that says nothing is the old one.
public enum ShannonBodyTouchVocabulary {
    /// What a server that says nothing speaks: `type`, `region` and the numbers, exactly as before.
    public static let unsaid = 1
    /// The first vocabulary with `part`, `side`, `gesture`, `input` and `reflex`.
    public static let detailed = 2

    /// The number a server said, or `unsaid` for a server (or an answer) that says none.
    public static func said(_ value: Int?) -> Int { max(unsaid, value ?? unsaid) }

    /// The vocabulary-2 fields of one touch, as they go on the wire: each a word of the server's list, or absent.
    public struct Fields: Codable, Equatable, Sendable {
        public var part: String?
        public var side: String?
        public var gesture: String?
        public var input: String?
        public var reflex: String?

        public init(_ detail: ShannonLive2DTouch.Detail) {
            part = detail.part?.rawValue
            side = detail.side?.rawValue
            gesture = detail.gesture?.rawValue
            input = detail.input?.rawValue
            reflex = detail.reflex?.rawValue
        }

        public init(part: String? = nil, side: String? = nil, gesture: String? = nil, input: String? = nil, reflex: String? = nil) {
            self.part = part
            self.side = side
            self.gesture = gesture
            self.input = input
            self.reflex = reflex
        }

        public static let none = Fields()
    }
}

/// One finished touch, as `POST /v1/body/events` takes it. Facts only: there is no text field.
public struct ShannonBodyTouchEventDTO: Codable, Equatable, Sendable {
    public let id: String
    public let type: String
    public let audience: ShannonBodyAudience
    public let occurredAt: String
    public let durationMs: Int
    public let strength: Double
    /// Which part was touched; left out when not known.
    public let region: String?
    /// Touch vocabulary 2, each left out when the page did not say it. Kept from the page; `sent(touchVocabulary:)` decides
    /// what leaves the device. The old fields above are always sent as they are: where they disagree, the server keeps them.
    public private(set) var part: String?
    public private(set) var side: String?
    public private(set) var gesture: String?
    public private(set) var input: String?
    public private(set) var reflex: String?

    public init(touch: ShannonLive2DTouch, audience: ShannonBodyAudience) {
        id = touch.id
        type = touch.kind.rawValue
        self.audience = audience
        occurredAt = touch.occurredAt
        durationMs = touch.durationMs
        strength = touch.strength
        region = touch.sentRegion?.rawValue
        detail = .init(touch.detail)
    }

    public var detail: ShannonBodyTouchVocabulary.Fields {
        get { .init(part: part, side: side, gesture: gesture, input: input, reflex: reflex) }
        set { (part, side, gesture, input, reflex) = (newValue.part, newValue.side, newValue.gesture, newValue.input, newValue.reflex) }
    }

    /// This touch as a server of that vocabulary takes it: below 2, exactly what was sent before vocabulary 2 existed.
    public func sent(touchVocabulary: Int) -> Self {
        guard touchVocabulary < ShannonBodyTouchVocabulary.detailed else { return self }
        var old = self
        old.detail = .none
        return old
    }
}

/// The start or the end of a voice conversation on this device, as `POST /v1/body/events` takes it
/// (`callStarted` / `callEnded`, `docs/body-contract.md`). Facts only: no text and no number. It tells her
/// desktop body that the owner is in a call here, so that its wake listener stays quiet.
public struct ShannonBodyCallEventDTO: Codable, Equatable, Sendable {
    public enum Kind: String, Codable, Sendable {
        case callStarted
        case callEnded
    }

    public let id: String
    public let type: Kind
    public let audience: ShannonBodyAudience
    public let occurredAt: String

    public init(id: String, type: Kind, audience: ShannonBodyAudience, occurredAt: String) {
        self.id = id
        self.type = type
        self.audience = audience
        self.occurredAt = occurredAt
    }
}

/// Reports the calls of this device. Every paired device may; no registration as a body is needed.
public protocol ShannonBodyCallReporting: Sendable {
    func sendBodyCallEvent(scopeKey: String, event: ShannonBodyCallEventDTO) async throws
}

/// `POST /v1/body/reactions`: the same touch id the finished event will carry.
public struct ShannonBodyReactionRequestDTO: Codable, Equatable, Sendable {
    public struct Touch: Codable, Equatable, Sendable {
        public let type: String
        public let durationMs: Int
        public let strength: Double
        public let ongoing: Bool
        public let region: String?
        /// Touch vocabulary 2, as on the event (`ShannonBodyTouchEventDTO`).
        public fileprivate(set) var part: String?
        public fileprivate(set) var side: String?
        public fileprivate(set) var gesture: String?
        public fileprivate(set) var input: String?
        public fileprivate(set) var reflex: String?

        public var detail: ShannonBodyTouchVocabulary.Fields {
            get { .init(part: part, side: side, gesture: gesture, input: input, reflex: reflex) }
            set { (part, side, gesture, input, reflex) = (newValue.part, newValue.side, newValue.gesture, newValue.input, newValue.reflex) }
        }
    }

    public var scopeKey: String
    public let id: String
    public private(set) var touch: Touch
    public let audience: ShannonBodyAudience
    public let occurredAt: String

    public init(scopeKey: String, touch: ShannonLive2DTouch, audience: ShannonBodyAudience) {
        self.scopeKey = scopeKey
        id = touch.id
        self.touch = Touch(
            type: touch.kind.rawValue, durationMs: touch.durationMs, strength: touch.strength, ongoing: touch.ongoing,
            region: touch.sentRegion?.rawValue)
        self.touch.detail = .init(touch.detail)
        self.audience = audience
        occurredAt = touch.occurredAt
    }

    /// This request as a server of that vocabulary takes it: below 2, exactly what was sent before vocabulary 2 existed.
    public func sent(touchVocabulary: Int) -> Self {
        guard touchVocabulary < ShannonBodyTouchVocabulary.detailed else { return self }
        var old = self
        old.touch.detail = .none
        return old
    }
}

public struct ShannonBodyReactionAnswerDTO: Codable, Equatable, Sendable {
    public struct Message: Codable, Equatable, Sendable {
        public let id: String
        public let text: String
        public let expression: String?
        public let feeling: String?
        public let threadId: String?
        public let listenSeconds: Int?
    }

    public struct Mood: Codable, Equatable, Sendable {
        public let expression: String?
        public let feeling: String?
    }

    public let id: String
    /// `said` or `quiet`.
    public let status: String
    public let message: Message?
    public let mood: Mood?

    public init(id: String, status: String, message: Message? = nil, mood: Mood? = nil) {
        self.id = id
        self.status = status
        self.message = message
        self.mood = mood
    }
}

/// A refusal of a body route, with the server's own code (`BODY_REACTION_NOT_A_BODY`, …).
public struct ShannonBodyRefusal: Error, Equatable, Sendable {
    public let status: Int
    public let code: String?

    public init(status: Int, code: String? = nil) {
        self.status = status
        self.code = code
    }
}

/// The three body routes the app uses, and no other: it registers as a body that only feels
/// touch, reports finished touches, and asks whether she says something. It never reads
/// `GET /v1/body/presence`, answers no look, and reports no delivery of her own messages.
public protocol ShannonBodyServing: Sendable {
    /// Answers the touch vocabulary the server said (`ShannonBodyTouchVocabulary.said`).
    @discardableResult
    func registerTouchBody(scopeKey: String, expressions: [String], gestures: [String]) async throws -> Int
    func sendBodyTouches(scopeKey: String, events: [ShannonBodyTouchEventDTO]) async throws
    func askBodyReaction(_ request: ShannonBodyReactionRequestDTO) async throws -> ShannonBodyReactionAnswerDTO
}

public enum ShannonBodyRegistration {
    /// The capability flag of a body that only feels touch: it has no camera, shows none of her
    /// own messages, and its presence is never read as "her window is showing".
    public static let touchOnlyFlag = "touchOnly"
    /// Where this body is, so that she is told 「iPhoneのアプリの中のボクの体」 and not 「PC」.
    public static var surface: String {
#if os(iOS)
        "iphone"
#else
        "mac"
#endif
    }
    /// The body waits this long for her words and discards anything later.
    public static let reactionTimeoutSeconds: TimeInterval = 4.5

    /// Identifiers the capabilities route accepts: 1–40 characters of `[A-Za-z0-9_.-]`, no repeats.
    public static func identifiers(_ names: [String], limit: Int) -> [String] {
        var seen = Set<String>()
        return names.filter { name in
            guard (1...40).contains(name.count), let first = name.unicodeScalars.first,
                  CharacterSet.alphanumerics.contains(first), first.isASCII,
                  name.unicodeScalars.allSatisfy({ $0.isASCII && (CharacterSet.alphanumerics.contains($0) || "_.-".unicodeScalars.contains($0)) })
            else { return false }
            return seen.insert(name).inserted
        }.prefix(limit).map { $0 }
    }
}

extension ShannonAPIClient: ShannonBodyServing, ShannonBodyCallReporting {
    @discardableResult
    public func registerTouchBody(scopeKey: String, expressions: [String], gestures: [String]) async throws -> Int {
        let connection = currentConnection()
        var request = bodyRequest(path: "/v1/body/capabilities", method: "PUT", connection: connection)
        request.httpBody = try JSONEncoder().encode(TouchBodyCapabilitiesDTO(
            scopeKey: connection?.scopeKey ?? scopeKey,
            expressions: ShannonBodyRegistration.identifiers(expressions, limit: 64),
            gestures: ShannonBodyRegistration.identifiers(gestures, limit: 32),
            flags: [ShannonBodyRegistration.touchOnlyFlag: true],
            surface: ShannonBodyRegistration.surface
        ))
        return ShannonBodyTouchVocabulary.said(inAnswer: try await bodyData(for: request))
    }

    public func sendBodyTouches(scopeKey: String, events: [ShannonBodyTouchEventDTO]) async throws {
        let connection = currentConnection()
        var request = bodyRequest(path: "/v1/body/events", method: "POST", connection: connection)
        request.httpBody = try JSONEncoder().encode(TouchEventsDTO(scopeKey: connection?.scopeKey ?? scopeKey, events: events))
        _ = try await bodyData(for: request)
    }

    /// Uses the route of the touch events, with an event of its own shape.
    public func sendBodyCallEvent(scopeKey: String, event: ShannonBodyCallEventDTO) async throws {
        let connection = currentConnection()
        var request = bodyRequest(path: "/v1/body/events", method: "POST", connection: connection)
        request.httpBody = try JSONEncoder().encode(BodyEventsDTO(scopeKey: connection?.scopeKey ?? scopeKey, events: [event]))
        _ = try await bodyData(for: request)
    }

    public func askBodyReaction(_ reaction: ShannonBodyReactionRequestDTO) async throws -> ShannonBodyReactionAnswerDTO {
        let connection = currentConnection()
        var request = bodyRequest(path: "/v1/body/reactions", method: "POST", connection: connection)
        request.timeoutInterval = ShannonBodyRegistration.reactionTimeoutSeconds
        var scoped = reaction
        if let connection { scoped.scopeKey = connection.scopeKey }
        request.httpBody = try JSONEncoder().encode(scoped)
        return try JSONDecoder().decode(ShannonBodyReactionAnswerDTO.self, from: try await bodyData(for: request))
    }

    private func bodyRequest(path: String, method: String, connection: ShannonConnectionCredential?) -> URLRequest {
        var request = URLRequest(url: baseURL.appending(path: path))
        request.httpMethod = method
        request.timeoutInterval = 15
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        authorize(&request, connection: connection)
        return request
    }

    private func bodyData(for request: URLRequest) async throws -> Data {
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw ShannonAPIError.invalidResponse }
        guard (200..<300).contains(http.statusCode) else {
            throw ShannonBodyRefusal(status: http.statusCode, code: (try? JSONDecoder().decode(BodyErrorDTO.self, from: data))?.error)
        }
        return data
    }
}

private struct TouchBodyCapabilitiesDTO: Encodable {
    let scopeKey: String
    let expressions: [String]
    let gestures: [String]
    let flags: [String: Bool]
    let surface: String
}

private struct TouchEventsDTO: Encodable {
    let scopeKey: String
    let events: [ShannonBodyTouchEventDTO]
}

private struct BodyEventsDTO<Event: Encodable>: Encodable {
    let scopeKey: String
    let events: [Event]
}

private struct BodyErrorDTO: Decodable {
    let error: String?
}

private struct TouchVocabularyDTO: Decodable {
    let touchVocabulary: Int?
}

extension ShannonBodyTouchVocabulary {
    /// The number in an answer of `PUT /v1/body/capabilities`; an answer that says none (or cannot be read) is the old server.
    static func said(inAnswer answer: Data) -> Int {
        said((try? JSONDecoder().decode(TouchVocabularyDTO.self, from: answer))?.touchVocabulary)
    }
}
