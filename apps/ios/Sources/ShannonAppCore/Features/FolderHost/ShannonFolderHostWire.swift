#if os(macOS)
import Foundation

/// What the Mac's folder device sends and reads (`docs/host-folder-contract.md`, v2). The Mac reads (A18 S2) and changes
/// (S3) her folder through the v2 operations. It never lists `write`, the v1 copy of a study piece: Syzygy ADR-0007 puts no
/// story in the PC or Mac folder, and a device without `write` is never planned a copy.
public enum ShannonFolderHostWire {
    public static let operations = ["list", "read", "search", "create", "update", "move", "delete"]
    /// The operations that change the folder.
    public static let changing: Set<String> = ["create", "update", "move", "delete"]
    public static let protocolVersion = 2
    /// A long-poll: the server holds the claim open up to this long.
    public static let waitSeconds = 25
    /// The shortest wait before claiming again, the lower end of the contract's 1–5 s after a network error. A claim that
    /// comes back empty sooner than this (a server that does not hold it, a hold cut short) is not repeated at once.
    public static let shortestClaimSeconds: Double = 1
    /// While the owner's stop switch on this Mac is on, it claims (with `localStop`) at most this often.
    public static let stoppedClaimSeconds: Double = 15
}

/// `POST /v1/autonomy/host-steps/claim`, v2 form. Nothing else is sent.
public struct ShannonFolderHostClaimRequest: Encodable, Equatable, Sendable {
    public var scopeKey: String
    public let host: String
    public let `protocol`: Int
    public let operations: [String]
    public let waitSeconds: Int
    public let localStop: Bool

    public init(scopeKey: String, host: String, localStop: Bool) {
        self.scopeKey = scopeKey
        self.host = host
        self.protocol = ShannonFolderHostWire.protocolVersion
        operations = ShannonFolderHostWire.operations
        waitSeconds = localStop ? 0 : ShannonFolderHostWire.waitSeconds
        self.localStop = localStop
    }
}

/// One step handed out by a claim. Unknown fields are ignored; an operation this Mac does not know is refused.
public struct ShannonFolderHostStep: Decodable, Equatable, Sendable {
    public let id: String
    public let operation: String
    public var relativePath: String?
    public var recursive: Bool?
    public var limit: Int?
    public var offset: Int?
    public var maxBytes: Int?
    public var query: String?
    /// `create`, `update`: the whole text, its SHA-256 as UTF-8, and its length in UTF-8 bytes.
    public var content: String?
    public var contentSha256: String?
    public var bytes: Int?
    /// `update`: the digest she read; another one on disk is `changed_since_read`.
    public var expectedSha256: String?
    /// `move`: where to.
    public var toRelativePath: String?
    public let expiresAt: String

    public init(id: String, operation: String, relativePath: String? = nil, recursive: Bool? = nil, limit: Int? = nil,
                offset: Int? = nil, maxBytes: Int? = nil, query: String? = nil, content: String? = nil, contentSha256: String? = nil,
                bytes: Int? = nil, expectedSha256: String? = nil, toRelativePath: String? = nil, expiresAt: String = "2099-01-01T00:00:00.000Z") {
        self.content = content
        self.contentSha256 = contentSha256
        self.bytes = bytes
        self.expectedSha256 = expectedSha256
        self.toRelativePath = toRelativePath
        self.id = id
        self.operation = operation
        self.relativePath = relativePath
        self.recursive = recursive
        self.limit = limit
        self.offset = offset
        self.maxBytes = maxBytes
        self.query = query
        self.expiresAt = expiresAt
    }
}

struct ShannonFolderHostClaimResponse: Decodable {
    let step: ShannonFolderHostStep?
}

/// `GET /v1/autonomy/host-steps/binding`: the host this Mac is registered for, or none.
public struct ShannonFolderHostBinding: Decodable, Equatable, Sendable {
    public let host: String?
    public let label: String?

    public init(host: String?, label: String? = nil) {
        self.host = host
        self.label = label
    }
}

// MARK: Results, in the exact shapes the server checks (`hostFolderOperationResults.ts`)

public struct ShannonFolderHostListResult: Encodable, Equatable, Sendable {
    public struct Entry: Encodable, Equatable, Sendable {
        public let path: String
        public let type: String
        public let bytes: Int?
        public let modifiedAt: String
    }

    public let entries: [Entry]
    public let truncated: Bool
}

public struct ShannonFolderHostReadResult: Encodable, Equatable, Sendable {
    public let content: String
    public let offset: Int
    /// Null (sent as `null`, never left out) at the end of the file.
    public let nextOffset: Int?
    public let totalBytes: Int
    public let sha256: String
    public let modifiedAt: String

    private enum CodingKeys: String, CodingKey { case content, offset, nextOffset, totalBytes, sha256, modifiedAt }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(content, forKey: .content)
        try container.encode(offset, forKey: .offset)
        try container.encode(nextOffset, forKey: .nextOffset)
        try container.encode(totalBytes, forKey: .totalBytes)
        try container.encode(sha256, forKey: .sha256)
        try container.encode(modifiedAt, forKey: .modifiedAt)
    }
}

public struct ShannonFolderHostSearchResult: Encodable, Equatable, Sendable {
    public struct Hit: Encodable, Equatable, Sendable {
        public let path: String
        /// Null for a match in the path.
        public let line: Int?
        public let snippet: String

        private enum CodingKeys: String, CodingKey { case path, line, snippet }

        public func encode(to encoder: Encoder) throws {
            var container = encoder.container(keyedBy: CodingKeys.self)
            try container.encode(path, forKey: .path)
            try container.encode(line, forKey: .line)
            try container.encode(snippet, forKey: .snippet)
        }
    }

    public let hits: [Hit]
    public let filesScanned: Int
    public let truncated: Bool
}

/// `create` `{ sha256 }`, `update` `{ sha256, trashedAs }`, `move` `{}`, `delete` `{ trashedAs }`: absent fields are left out.
public struct ShannonFolderHostWriteResult: Encodable, Equatable, Sendable {
    public let sha256: String?
    public let trashedAs: String?

    public init(sha256: String? = nil, trashedAs: String? = nil) {
        self.sha256 = sha256
        self.trashedAs = trashedAs
    }
}

public enum ShannonFolderHostResult: Equatable, Sendable {
    case list(ShannonFolderHostListResult)
    case read(ShannonFolderHostReadResult)
    case search(ShannonFolderHostSearchResult)
    case write(ShannonFolderHostWriteResult)
}

/// `POST /v1/autonomy/host-steps/{id}/report`: an outcome, a code from the fixed set, and for `done` the bounded result.
public struct ShannonFolderHostReport: Equatable, Sendable {
    public let outcome: String
    public let code: ShannonFolderHostCode?
    public let result: ShannonFolderHostResult?

    public static func done(_ result: ShannonFolderHostResult) -> Self { .init(outcome: "done", code: nil, result: result) }
    public static func refused(_ refusal: ShannonFolderHostRefusal) -> Self { .init(outcome: refusal.outcome.rawValue, code: refusal.code, result: nil) }

    /// The body as sent, with no field but these.
    public func body(scopeKey: String) throws -> Data {
        try ShannonFolderHostReport.encoder.encode(Body(scopeKey: scopeKey, report: self))
    }

    static let encoder: JSONEncoder = {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.withoutEscapingSlashes]
        return encoder
    }()

    private struct Body: Encodable {
        let scopeKey: String
        let report: ShannonFolderHostReport

        private enum CodingKeys: String, CodingKey { case scopeKey, outcome, code, result }

        func encode(to encoder: Encoder) throws {
            var container = encoder.container(keyedBy: CodingKeys.self)
            try container.encode(scopeKey, forKey: .scopeKey)
            try container.encode(report.outcome, forKey: .outcome)
            try container.encodeIfPresent(report.code, forKey: .code)
            switch report.result {
            case .list(let result): try container.encode(result, forKey: .result)
            case .read(let result): try container.encode(result, forKey: .result)
            case .search(let result): try container.encode(result, forKey: .result)
            case .write(let result): try container.encode(result, forKey: .result)
            case nil: break
            }
        }
    }
}

enum ShannonFolderHostTime {
    static func string(_ date: Date) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: date)
    }
}
#endif
