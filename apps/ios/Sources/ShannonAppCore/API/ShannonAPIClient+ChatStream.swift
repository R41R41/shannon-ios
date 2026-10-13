import Foundation

// A text turn read sentence by sentence (docs/chat-stream-contract.md): `POST /v1/chat` with
// `stream: "sentences"` is answered as NDJSON — `start`, `sentence`…, then exactly one `done` or `error` —
// or, by a server older than the contract and by every turn it sends at once, as the plain JSON document.

/// How far a streamed reply has come: the sentences so far, joined as the contract joins them.
public struct ShannonChatStreamProgress: Equatable, Sendable {
    /// The thread the server named in `start`; nil until it arrived.
    public let threadId: String?
    public let text: String
    public let sentenceCount: Int

    public init(threadId: String?, text: String, sentenceCount: Int) {
        self.threadId = threadId
        self.text = text
        self.sentenceCount = sentenceCount
    }
}

public typealias ShannonChatStreamProgressHandler = @Sendable (ShannonChatStreamProgress) async -> Void

/// A client that can read a text turn as it is written. A client without it (an older stub) sends the turn whole.
public protocol ShannonChatStreamServing: Sendable {
    func sendStreaming(
        message: String,
        scopeKey: String,
        threadId: String?,
        attachments: [ShannonChatAttachmentDTO],
        webSearch: Bool,
        placeLocation: ShannonVoiceDeviceLocationDTO?,
        appLook: ShannonAppLookClientStateDTO?,
        onProgress: @escaping ShannonChatStreamProgressHandler
    ) async throws -> ChatResponseDTO
}

/// The server ended the stream with `error` after sentences: what was shown is not her reply and is discarded.
/// `MODEL_UNAVAILABLE`: nothing of the turn was stored. `STREAM_FAILED`: the turn is stored; the Talk has it.
public struct ShannonChatStreamRetracted: Error, Equatable, Sendable {
    public let status: Int
    public let code: String?
    public let threadId: String?
    public let shownText: String

    /// Whether the server said the turn was not stored, so sending it again cannot make a second turn.
    public var turnWasNotStored: Bool { code == "MODEL_UNAVAILABLE" }
}

/// The stream stopped without `done` or `error`: the connection broke, the app was suspended, or the read was
/// cancelled. The server finishes and stores the turn without its reader, so whether it exists is unknown here.
public struct ShannonChatStreamInterrupted: Error, Sendable {
    public let partialText: String
    public let threadId: String?
    public let underlying: (any Error)?
}

/// One NDJSON line of the chat stream. Unknown types are kept as `.unknown` and ignored, as the contract asks.
public enum ShannonChatStreamEvent: Equatable, Sendable {
    case start(threadId: String?, audience: String?, turnId: String?)
    case sentence(index: Int, text: String)
    case done(ChatResponseDTO, fallback: String?)
    case error(status: Int, code: String?)
    case unknown(type: String)

    public struct MalformedLine: Error, Equatable, Sendable {
        public let reason: String
    }

    private struct Envelope: Decodable { let type: String }
    private struct Start: Decodable { let threadId: String?; let audience: String?; let turnId: String? }
    private struct Sentence: Decodable { let index: Int; let text: String }
    private struct Done: Decodable { let response: ChatResponseDTO; let fallback: String? }
    private struct Failure: Decodable { let status: Int?; let error: String? }

    /// Parses one line. nil for a blank line; throws `MalformedLine` for a line that is not a valid event.
    public static func parse(line: String) throws -> ShannonChatStreamEvent? {
        guard line.contains(where: { !$0.isWhitespace }) else { return nil }
        let data = Data(line.utf8)
        let decoder = JSONDecoder()
        let type: String
        do {
            type = try decoder.decode(Envelope.self, from: data).type
        } catch {
            throw MalformedLine(reason: "not an event")
        }
        do {
            switch type {
            case "start":
                let start = try decoder.decode(Start.self, from: data)
                return .start(threadId: start.threadId, audience: start.audience, turnId: start.turnId)
            case "sentence":
                let sentence = try decoder.decode(Sentence.self, from: data)
                return .sentence(index: sentence.index, text: sentence.text)
            case "done":
                let done = try decoder.decode(Done.self, from: data)
                return .done(done.response, fallback: done.fallback)
            case "error":
                let failure = try decoder.decode(Failure.self, from: data)
                return .error(status: failure.status ?? 502, code: failure.error)
            default:
                return .unknown(type: type)
            }
        } catch {
            throw MalformedLine(reason: "invalid \(type)")
        }
    }
}

/// Joins the events of one stream into the reply as it grows, and checks the contract's ordering.
public struct ShannonChatStreamAssembler: Sendable {
    public enum Step: Equatable, Sendable {
        case ignored
        case started
        case grew(ShannonChatStreamProgress)
        case finished(ChatResponseDTO, fallback: String?)
    }

    public struct OutOfOrder: Error, Equatable, Sendable {
        public let expected: Int
        public let received: Int
    }

    public private(set) var threadId: String?
    public private(set) var turnId: String?
    public private(set) var sentences: [String] = []
    public private(set) var isFinished = false

    public init() {}

    /// The sentences joined in index order with nothing between them (the contract's equality rule).
    public var text: String { sentences.joined() }

    public var progress: ShannonChatStreamProgress {
        ShannonChatStreamProgress(threadId: threadId, text: text, sentenceCount: sentences.count)
    }

    /// Applies one event. `error` throws `ShannonChatStreamRetracted`; a sentence out of order throws `OutOfOrder`.
    /// Nothing follows a terminal line: later events are ignored.
    public mutating func apply(_ event: ShannonChatStreamEvent) throws -> Step {
        guard !isFinished else { return .ignored }
        switch event {
        case let .start(threadId, _, turnId):
            self.threadId = threadId ?? self.threadId
            self.turnId = turnId ?? self.turnId
            return .started
        case let .sentence(index, text):
            guard index == sentences.count else { throw OutOfOrder(expected: sentences.count, received: index) }
            sentences.append(text)
            return .grew(progress)
        case let .done(response, fallback):
            isFinished = true
            return .finished(response, fallback: fallback)
        case let .error(status, code):
            isFinished = true
            throw ShannonChatStreamRetracted(status: status, code: code, threadId: threadId, shownText: text)
        case .unknown:
            return .ignored
        }
    }
}

/// Splits bytes into lines at `\n` only. `AsyncLineSequence` also splits at U+2028/U+2029, which JSON
/// strings may hold unescaped, so the stream is split here.
struct ShannonNDJSONLineSplitter {
    private var buffer: [UInt8] = []

    /// Adds one byte; returns the line it completed, if any.
    mutating func append(_ byte: UInt8) -> String? {
        guard byte == 0x0A else {
            buffer.append(byte)
            return nil
        }
        defer { buffer.removeAll(keepingCapacity: true) }
        return Self.line(buffer)
    }

    /// The last line when the bytes ended without a newline.
    mutating func finish() -> String? {
        guard !buffer.isEmpty else { return nil }
        defer { buffer.removeAll() }
        return Self.line(buffer)
    }

    private static func line(_ bytes: [UInt8]) -> String {
        let trimmed = bytes.last == 0x0D ? bytes.dropLast() : bytes[...]
        return String(decoding: trimmed, as: UTF8.self)
    }
}

enum ShannonChatStreamReader {
    static func isNDJSON(contentType: String?) -> Bool {
        contentType?.lowercased().hasPrefix("application/x-ndjson") == true
    }

    /// Reads a 2xx body: NDJSON as the stream, anything else as the plain JSON document (an older server).
    static func read<Bytes: AsyncSequence>(
        bytes: Bytes,
        contentType: String?,
        onProgress: @escaping ShannonChatStreamProgressHandler
    ) async throws -> ChatResponseDTO where Bytes.Element == UInt8 {
        guard isNDJSON(contentType: contentType) else {
            var data = Data()
            for try await byte in bytes { data.append(byte) }
            return try JSONDecoder().decode(ChatResponseDTO.self, from: data)
        }
        var splitter = ShannonNDJSONLineSplitter()
        var assembler = ShannonChatStreamAssembler()

        func handle(_ line: String) async throws -> ChatResponseDTO? {
            guard let event = try ShannonChatStreamEvent.parse(line: line) else { return nil }
            switch try assembler.apply(event) {
            case .ignored, .started:
                return nil
            case let .grew(progress):
                await onProgress(progress)
                return nil
            case let .finished(response, _):
                return response
            }
        }

        do {
            for try await byte in bytes {
                guard let line = splitter.append(byte) else { continue }
                try Task.checkCancellation()
                // `done` is the protocol boundary: what comes after it, or a reset after it, changes nothing.
                if let response = try await handle(line) { return response }
            }
            if let line = splitter.finish(), let response = try await handle(line) { return response }
        } catch let retracted as ShannonChatStreamRetracted {
            throw retracted
        } catch {
            throw ShannonChatStreamInterrupted(partialText: assembler.text, threadId: assembler.threadId, underlying: error)
        }
        throw ShannonChatStreamInterrupted(partialText: assembler.text, threadId: assembler.threadId, underlying: nil)
    }
}

extension ShannonAPIClient: ShannonChatStreamServing {
    public func sendStreaming(
        message: String,
        scopeKey: String,
        threadId: String?,
        attachments: [ShannonChatAttachmentDTO],
        webSearch: Bool,
        placeLocation: ShannonVoiceDeviceLocationDTO?,
        appLook: ShannonAppLookClientStateDTO?,
        onProgress: @escaping ShannonChatStreamProgressHandler
    ) async throws -> ChatResponseDTO {
        let connection = currentConnection()
        var request = URLRequest(url: baseURL.appending(path: "/v1/chat"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.setValue("application/x-ndjson, application/json", forHTTPHeaderField: "accept")
        authorize(&request, connection: connection)
        var body = ChatRequestDTO(
            scopeKey: connection?.scopeKey ?? scopeKey,
            message: message,
            threadId: threadId,
            attachments: attachments,
            webSearch: webSearch,
            placeLocation: placeLocation
        )
        body.appLook = appLook
        body.stream = ChatRequestDTO.sentenceStream
        request.httpBody = try JSONEncoder().encode(body)

        let (bytes, response) = try await session.bytes(for: request)
        guard let http = response as? HTTPURLResponse else { throw ShannonAPIError.invalidResponse }
        // A refusal, a limit or a model failure before the first line is plain JSON with its status, as without `stream`.
        guard (200..<300).contains(http.statusCode) else { throw ShannonAPIError.rejected(status: http.statusCode) }
        return try await ShannonChatStreamReader.read(
            bytes: bytes,
            contentType: http.value(forHTTPHeaderField: "content-type"),
            onProgress: onProgress
        )
    }
}
