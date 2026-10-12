import Foundation

/// A small JSON value: the payload of a device action and the result the device reports (`docs/device-actions-contract.md`).
public enum ShannonJSONValue: Codable, Equatable, Sendable {
    case string(String)
    case number(Double)
    case bool(Bool)
    case array([ShannonJSONValue])
    case object([String: ShannonJSONValue])
    case null

    public init(from decoder: any Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let value = try? container.decode(Bool.self) {
            self = .bool(value)
        } else if let value = try? container.decode(Double.self) {
            self = .number(value)
        } else if let value = try? container.decode(String.self) {
            self = .string(value)
        } else if let value = try? container.decode([ShannonJSONValue].self) {
            self = .array(value)
        } else {
            self = .object(try container.decode([String: ShannonJSONValue].self))
        }
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .string(let value): try container.encode(value)
        case .number(let value): try container.encode(value)
        case .bool(let value): try container.encode(value)
        case .array(let value): try container.encode(value)
        case .object(let value): try container.encode(value)
        case .null: try container.encodeNil()
        }
    }

    public var stringValue: String? {
        if case .string(let value) = self { return value }
        return nil
    }

    public var numberValue: Double? {
        if case .number(let value) = self { return value }
        return nil
    }

    public var boolValue: Bool? {
        if case .bool(let value) = self { return value }
        return nil
    }

    public var arrayValue: [ShannonJSONValue]? {
        if case .array(let value) = self { return value }
        return nil
    }
}

/// One action of the outbox, as `GET /v1/device/actions` hands it to this device.
public struct ShannonDeviceActionDTO: Decodable, Equatable, Sendable, Identifiable {
    public let id: String
    public let kind: String
    public let payload: [String: ShannonJSONValue]
    public let requestedAt: String
    public let expiresAt: String

    public init(id: String, kind: String, payload: [String: ShannonJSONValue], requestedAt: String, expiresAt: String) {
        self.id = id
        self.kind = kind
        self.payload = payload
        self.requestedAt = requestedAt
        self.expiresAt = expiresAt
    }

    public func string(_ key: String) -> String? {
        guard let value = payload[key]?.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines), !value.isEmpty else { return nil }
        return value
    }

    public func number(_ key: String) -> Double? { payload[key]?.numberValue }
}

public struct ShannonDeviceActionPollDTO: Decodable, Equatable, Sendable {
    public let actions: [ShannonDeviceActionDTO]
    public let pollSeconds: Double?
}

/// The device's one report of an action: `done`, `failed` or `denied`, a closed code, and a small result.
public struct ShannonDeviceActionReportDTO: Codable, Equatable, Sendable {
    public let status: String
    public let code: String?
    public let result: [String: ShannonJSONValue]?

    public init(status: String, code: String? = nil, result: [String: ShannonJSONValue]? = nil) {
        self.status = status
        self.code = code
        self.result = result
    }

    public static func done(_ result: [String: ShannonJSONValue]? = nil) -> Self { Self(status: "done", result: result) }
    public static func failed(_ code: ShannonDeviceActionCode) -> Self { Self(status: "failed", code: code.rawValue) }
    public static func denied() -> Self { Self(status: "denied", code: ShannonDeviceActionCode.notAuthorized.rawValue) }
}

/// The closed codes of a report (`DEVICE_ACTION_CODES` on the server).
public enum ShannonDeviceActionCode: String, Sendable {
    case unsupported
    case notAuthorized = "not_authorized"
    case notFound = "not_found"
    case invalid
    case past
    case unavailable
    case failed
}

public struct ShannonDeviceActionReportResponseDTO: Decodable, Equatable, Sendable {
    public let id: String
    public let status: String
    public let accepted: Bool
}

/// What the device saw of a song she chose: started, skipped, finished or stopped (for her later learning).
public struct ShannonMusicPlayReportDTO: Encodable, Equatable, Sendable {
    public let actionId: String?
    public let itemId: String
    public let title: String
    public let artist: String?
    public let outcome: String

    public init(actionId: String?, itemId: String, title: String, artist: String?, outcome: String) {
        self.actionId = actionId
        self.itemId = itemId
        self.title = title
        self.artist = artist
        self.outcome = outcome
    }
}

public enum ShannonDeviceActionError: Error, Equatable {
    case notPaired
}
