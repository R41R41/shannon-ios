import Foundation

/// One look through this app's camera (docs/body-contract.md, "A look through the app").
/// The server asks in the response of a turn; the app answers with one frame or a reason.
public enum ShannonAppLookCamera: String, Codable, Equatable, Sendable, CaseIterable {
    case back
    case front
}

/// What the app says about its camera in a turn. Facts only; no text.
public struct ShannonAppLookClientStateDTO: Codable, Equatable, Sendable {
    public enum State: String, Codable, Equatable, Sendable {
        case ready
        case undetermined
        case background
        case denied
        case noCamera = "no_camera"
        case switchedOff = "switched_off"
    }

    public let state: State
    public let cameras: [ShannonAppLookCamera]
    public let platform: String

    public init(state: State, cameras: [ShannonAppLookCamera], platform: String) {
        self.state = state
        self.cameras = cameras
        self.platform = platform
    }
}

/// The ask a turn's response carries: capture one frame with `camera` and answer before `expiresAt`.
public struct ShannonAppLookAskDTO: Codable, Equatable, Sendable {
    public let id: String
    public let camera: ShannonAppLookCamera
    public let expiresAt: String

    public init(id: String, camera: ShannonAppLookCamera, expiresAt: String) {
        self.id = id
        self.camera = camera
        self.expiresAt = expiresAt
    }

    /// False once the server has closed the ask: nothing is captured for it then.
    public func isOpen(at now: Date = Date()) -> Bool {
        guard let expiry = ShannonAppLookAskDTO.date(expiresAt) else { return false }
        return now < expiry
    }

    static func date(_ text: String) -> Date? {
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return fractional.date(from: text) ?? ISO8601DateFormatter().date(from: text)
    }
}

/// Why the app did not look. The server says one fixed line for each.
public enum ShannonAppLookRefusal: String, Codable, Equatable, Sendable {
    case background
    case denied
    case declined
    case noCamera = "no_camera"
    case switchedOff = "switched_off"
    case busy
    case failed
}

/// The app's answer to one ask: `POST /v1/app/looks/{id}`.
public struct ShannonAppLookAnswerDTO: Encodable, Equatable, Sendable {
    public struct Image: Encodable, Equatable, Sendable {
        public let mediaType: String
        public let base64: String
        public let width: Int
        public let height: Int
    }

    public let scopeKey: String
    public let outcome: String
    public let camera: ShannonAppLookCamera?
    public let image: Image?
    public let code: ShannonAppLookRefusal?

    public static func seen(scopeKey: String, camera: ShannonAppLookCamera, frame: ShannonAppLookFrame) -> ShannonAppLookAnswerDTO {
        ShannonAppLookAnswerDTO(
            scopeKey: scopeKey, outcome: "seen", camera: camera,
            image: Image(mediaType: "image/jpeg", base64: frame.jpeg.base64EncodedString(), width: frame.width, height: frame.height),
            code: nil
        )
    }

    public static func refused(scopeKey: String, code: ShannonAppLookRefusal) -> ShannonAppLookAnswerDTO {
        ShannonAppLookAnswerDTO(scopeKey: scopeKey, outcome: "refused", camera: nil, image: nil, code: code)
    }

    /// The same answer for the scope of the paired connection.
    public func scoped(to scopeKey: String) -> ShannonAppLookAnswerDTO {
        ShannonAppLookAnswerDTO(scopeKey: scopeKey, outcome: outcome, camera: camera, image: image, code: code)
    }
}

public struct ShannonAppLookAnswerResponseDTO: Decodable, Equatable, Sendable {
    public struct Message: Decodable, Equatable, Sendable {
        public let id: String
        public let threadId: String
        public let text: String
    }

    public let id: String
    public let status: String
    /// What she says next, already stored in the Talk; nil when she says nothing.
    public let message: Message?
}

/// The JPEG the server accepts: at most 960 wide, 1,920 high and 400,000 bytes.
public struct ShannonAppLookFrame: Equatable, Sendable {
    public let jpeg: Data
    public let width: Int
    public let height: Int

    public init(jpeg: Data, width: Int, height: Int) {
        self.jpeg = jpeg
        self.width = width
        self.height = height
    }
}

/// The API a look needs beyond a plain chat turn. A client without it (an older stub) never looks.
public protocol ShannonAppLookServing: Sendable {
    func send(
        message: String, scopeKey: String, threadId: String?, attachments: [ShannonChatAttachmentDTO],
        webSearch: Bool, placeLocation: ShannonVoiceDeviceLocationDTO?, appLook: ShannonAppLookClientStateDTO?
    ) async throws -> ChatResponseDTO

    func answerAppLook(id: String, answer: ShannonAppLookAnswerDTO) async throws -> ShannonAppLookAnswerResponseDTO
}

public extension ShannonVoiceDeviceContextDTO {
    /// The same context, saying what this app's camera can do in this turn.
    func withAppLook(_ state: ShannonAppLookClientStateDTO?) -> ShannonVoiceDeviceContextDTO {
        var copy = self
        copy.appLook = state
        return copy
    }
}

/// A voice turn's look, running beside the spoken reply.
enum ShannonAppLookSpeech {
    /// Starts the look a voice turn asked for; its value is what she says about it, or nil when she says nothing.
    @MainActor
    static func begin(
        _ ask: ShannonAppLookAskDTO?, with perform: (@MainActor (ShannonAppLookAskDTO) async -> String?)?
    ) -> Task<String?, Never>? {
        guard let ask, let perform else { return nil }
        return Task { @MainActor in
            let text = await perform(ask)?.trimmingCharacters(in: .whitespacesAndNewlines)
            return text?.isEmpty == false ? text : nil
        }
    }
}
