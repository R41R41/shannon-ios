import Foundation

/// Owner-visible task facts. Optional progress is absent on older servers; a summary is never evidence.
public struct ShannonConversationActivityDTO: Codable, Sendable {
    public let generatedAt: String
    public let tasks: [Task]
    /// The server writes each report's short spoken form; a call waits for it instead of reading the full report.
    public var spokenReports: Bool? = nil
    public struct Task: Codable, Identifiable, Sendable {
        public let id: String
        public let parentId: String?
        public let kind: String
        public let origin: String
        public let title: String
        public let phase: String
        public let summary: String
        public let revision: Int
        public let updatedAt: String
        public var currentStep: String? = nil
        public var findings: [Finding]? = nil
        public var sourceThreadId: String? = nil
        public var startedAt: String? = nil
        public var progressStatus: String? = nil
        public var observedAt: String? = nil
        public var report: Report? = nil
        public var places: [ShannonPlaceDTO]? = nil
        public var currentStepTitle: String? {
            guard let step = currentStep else { return nil }
            switch step {
            case "web.search": return progressStatus == "received" ? "検索結果を確認中" : "Webの資料を探しています"
            case "places.search", "places.details": return "場所の情報を確認中"
            case "memory.search", "memory.read": return "関連する記憶を確認中"
            case "fca.decide": return "調べたことを整理中"
            case "task.send": return "分かったことを伝えています"
            default: return "資料と結果を確認中"
            }
        }
        public var updatedTime: String {
            ((try? Date.ISO8601FormatStyle(includingFractionalSeconds: true).parse(updatedAt))
                ?? (try? Date.ISO8601FormatStyle().parse(updatedAt)))?.formatted(.dateTime.hour().minute()) ?? "時刻不明"
        }
        public var isActive: Bool { ["ready", "executing", "waiting", "stopping", "unknown", "stopped"].contains(phase) }
        public var canStop: Bool { ["ready", "executing", "waiting"].contains(phase) }
        public var phaseTitle: String {
            switch phase {
            case "ready": "準備中"
            case "executing": "進めています"
            case "waiting": "結果を待っています"
            case "stopping": "停止を確認中"
            case "unknown": "結果を確認できません"
            case "stopped": "停止済み"
            case "completed": "完了"
            case "failed": "続きが必要です"
            default: "状態を確認できません"
            }
        }
        public var symbol: String {
            switch phase {
            case "completed": "checkmark.circle"
            case "failed", "unknown": "exclamationmark.triangle"
            case "stopped", "stopping": "stop.circle"
            case "waiting", "ready": "clock"
            default: kind == "research" ? "globe" : "gearshape.2"
            }
        }
    }
    public struct Report: Codable, Identifiable, Sendable {
        public let id: String
        public let text: String
        public let updatedAt: String
        /// What a call says aloud: a few sentences. `text` stays the full report for the screen.
        public var spoken: String? = nil
        public func wasWritten(since date: Date) -> Bool {
            guard let written = (try? Date.ISO8601FormatStyle(includingFractionalSeconds: true).parse(updatedAt))
                ?? (try? Date.ISO8601FormatStyle().parse(updatedAt)) else { return false }
            return written >= date
        }
    }
    public struct Finding: Codable, Identifiable, Sendable {
        public let id: String
        public let text: String
        public let status: String
        public let sources: [Source]
        public let updatedAt: String
        public var statusTitle: String {
            switch status { case "confirmed": "確認済み"; case "corrected": "訂正"; default: "未確認" }
        }
    }
    public struct Source: Codable, Sendable {
        public let title: String
        public let url: String
        public var webURL: URL? {
            guard let value = URL(string: url), ["https", "http"].contains(value.scheme?.lowercased() ?? ""), value.host != nil else { return nil }
            return value
        }
    }
}

public protocol ShannonConversationActivityServing: Sendable {
    func loadNow(scopeKey: String) async throws -> ShannonConversationActivityDTO
    func sendNowCommand(scopeKey: String, id: String, command: String, message: String?, requestID: String) async throws
}

extension ShannonAPIClient: ShannonConversationActivityServing {
    public func loadNow(scopeKey: String) async throws -> ShannonConversationActivityDTO {
        try await response(ShannonConversationActivityDTO.self, for: autonomyGet("/v1/fca/tasks", scopeKey: scopeKey,
            extra: [URLQueryItem(name: "projection", value: "now")]))
    }
    public func sendNowCommand(scopeKey: String, id: String, command: String, message: String?, requestID: String) async throws {
        struct Command: Encodable { let command: String; let id: String; let requestId: String; let message: String? }
        let request = try autonomyPost("/v1/fca/tasks", body: Command(command: command, id: id, requestId: requestID, message: message), connection: currentConnection())
        let _: ShannonActivityCommandReceipt = try await response(ShannonActivityCommandReceipt.self, for: request)
    }
}
private struct ShannonActivityCommandReceipt: Decodable {}
