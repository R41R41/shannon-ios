import Foundation

public struct ShannonActionThreadsDTO: Codable, Sendable {
    public let availability: String
    public let generatedAt: String
    public let count: Int
    public let threads: [Thread]
    public var othersPresent: Bool? = nil
    public struct Thread: Codable, Identifiable, Sendable {
        public let id: String
        public let kind: String
        public let title: String
        public let origin: String
        public let state: String
        public let progress: String?
        public let result: String?
        public let updatedAt: String
        public let failures: Int
        public let canResume: Bool
        public var notification: Notification? = nil
        public var hasUnacknowledgedNotice: Bool { state == "unknown" && notification?.acknowledgedAt == nil }
    }
    public struct Notification: Codable, Sendable {
        public let id: String
        public let acknowledgedAt: String?
    }
}

public protocol ShannonActionThreadsServing: Sendable {
    func loadActionThreads(scopeKey: String, othersPresent: Bool) async throws -> ShannonActionThreadsDTO
    func acknowledgeActionNotice(scopeKey: String, id: String, notificationID: String, requestID: String) async throws -> ShannonActionThreadsDTO
    func controlActionThread(scopeKey: String, id: String?, resume: Bool, requestID: String) async throws -> ShannonActionThreadsDTO
}

extension ShannonAPIClient: ShannonActionThreadsServing {
    private struct ActionControl: Encodable { let requestId: String }
    private struct NoticeControl: Encodable { let requestId: String; let notificationId: String }
    public func acknowledgeActionNotice(scopeKey: String, id: String, notificationID: String, requestID: String) async throws -> ShannonActionThreadsDTO {
        let path = "/v1/action-threads/\(try Self.pathComponent(id))/acknowledge-notice"
        return try await response(ShannonActionThreadsDTO.self, for: autonomyPost(path,
            body: NoticeControl(requestId: requestID, notificationId: notificationID), connection: currentConnection()))
    }
    public func loadActionThreads(scopeKey: String, othersPresent: Bool) async throws -> ShannonActionThreadsDTO {
        try await response(ShannonActionThreadsDTO.self, for: autonomyGet("/v1/action-threads", scopeKey: scopeKey,
            extra: [URLQueryItem(name: "audience", value: othersPresent ? "others" : "owner")]))
    }
    public func controlActionThread(scopeKey: String, id: String?, resume: Bool, requestID: String) async throws -> ShannonActionThreadsDTO {
        let path = try id.map { "/v1/action-threads/\(try Self.pathComponent($0))/\(resume ? "resume" : "stop")" } ?? "/v1/action-threads/stop-all"
        return try await response(ShannonActionThreadsDTO.self, for: autonomyPost(path,
            body: ActionControl(requestId: requestID), connection: currentConnection()))
    }
}
