import Foundation

/// A single registered gesture invocation. This receipt never claims animation or speech completion.
public struct ShannonTouchReflexDirective: Codable, Equatable, Sendable {
    public let operationId: String
    public let touchId: String
    public let gesture: String
    public let expiresAt: String
}

public enum ShannonTouchReflexOutcome: String, Codable, Sendable {
    case applied, notApplied = "not_applied", unknown
}

struct ShannonTouchReflexClaim: Encodable { let scopeKey: String; let touchId: String }
struct ShannonTouchReflexAnswer: Decodable { let directive: ShannonTouchReflexDirective? }
struct ShannonTouchReflexReport: Encodable {
    let scopeKey: String; let operationId: String; let outcome: ShannonTouchReflexOutcome
}

/// Older servers and preview clients continue their existing reaction path.
public extension ShannonBodyServing {
    func claimTouchReflex(scopeKey: String, touchId: String) async throws -> ShannonTouchReflexDirective? { nil }
    func reportTouchReflex(scopeKey: String, operationId: String, outcome: ShannonTouchReflexOutcome) async throws {}
}

@MainActor
final class ShannonTouchReflexExecutor {
    private var seen = Set<String>()
    private var busy = false

    func perform(_ directive: ShannonTouchReflexDirective, now: Date, allowed: () -> Bool,
                 gestures: [String], invoke: (String) async -> Bool?) async -> ShannonTouchReflexOutcome {
        // Never replay even when the original WebKit acknowledgement was lost.
        guard seen.insert(directive.operationId).inserted else { return .unknown }
        guard !busy, !Task.isCancelled, allowed(), gestures.contains(directive.gesture),
              let expiry = Self.date(directive.expiresAt), expiry > now else { return .notApplied }
        busy = true
        defer { busy = false }
        switch await invoke(directive.gesture) {
        case true: return .applied
        case false: return .notApplied
        default: return .unknown
        }
    }

    private static func date(_ value: String) -> Date? {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.date(from: value) ?? ISO8601DateFormatter().date(from: value)
    }
}
