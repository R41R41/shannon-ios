import Foundation

public enum ShannonAgentApprovalKind: String, Codable, Equatable, Sendable {
    case command
    case fileChange = "file_change"
    case network
    case permission

    public var japaneseName: String {
        switch self {
        case .command: "コマンド実行"
        case .fileChange: "ファイル変更"
        case .network: "外部接続"
        case .permission: "権限"
        }
    }

    public var symbolName: String {
        switch self {
        case .command: "terminal"
        case .fileChange: "doc.badge.gearshape"
        case .network: "network"
        case .permission: "lock.shield"
        }
    }
}

/// Which approval choices use hold-to-confirm. Frequent one-off command and file
/// approvals stay a single tap; widening scope (for the whole task) or granting
/// external access or permissions needs a hold, or a tap followed by confirmation.
/// Declining is always a single tap.
public enum ShannonAgentApprovalScope: Equatable, Sendable {
    case once
    case session
}

extension ShannonAgentApprovalKind {
    public func requiresHoldToConfirm(_ scope: ShannonAgentApprovalScope) -> Bool {
        switch (self, scope) {
        case (_, .session): true
        case (.network, .once), (.permission, .once): true
        case (.command, .once), (.fileChange, .once): false
        }
    }
}

public struct ShannonAgentApproval: Codable, Equatable, Identifiable, Sendable {
    public let id: UUID
    public let externalRequestID: String
    public var kind: ShannonAgentApprovalKind
    public var title: String
    public var reason: String
    public var resource: String?
    public var requestedAt: Date

    public init(
        id: UUID = UUID(),
        externalRequestID: String,
        kind: ShannonAgentApprovalKind,
        title: String,
        reason: String,
        resource: String? = nil,
        requestedAt: Date = Date()
    ) {
        self.id = id
        self.externalRequestID = externalRequestID
        self.kind = kind
        self.title = title
        self.reason = reason
        self.resource = resource
        self.requestedAt = requestedAt
    }
}

public struct ShannonAgentChangeSummary: Codable, Equatable, Identifiable, Sendable {
    public let id: UUID
    public var displayName: String
    public var path: String?
    public var summary: String
    public var additions: Int
    public var deletions: Int
    public var diffPreview: String?

    public init(
        id: UUID = UUID(),
        displayName: String,
        path: String? = nil,
        summary: String,
        additions: Int = 0,
        deletions: Int = 0,
        diffPreview: String? = nil
    ) {
        self.id = id
        self.displayName = displayName
        self.path = path
        self.summary = summary
        self.additions = additions
        self.deletions = deletions
        self.diffPreview = diffPreview
    }
}

public enum ShannonAgentTestStatus: String, Codable, Equatable, Sendable {
    case pending
    case passed
    case failed
}

public struct ShannonAgentTestResult: Codable, Equatable, Identifiable, Sendable {
    public let id: UUID
    public var name: String
    public var status: ShannonAgentTestStatus
    public var detail: String?

    public init(
        id: UUID = UUID(),
        name: String,
        status: ShannonAgentTestStatus,
        detail: String? = nil
    ) {
        self.id = id
        self.name = name
        self.status = status
        self.detail = detail
    }
}
