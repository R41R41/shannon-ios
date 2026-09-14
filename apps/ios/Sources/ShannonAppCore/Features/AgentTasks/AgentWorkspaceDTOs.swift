import Foundation

public enum ShannonAgentHostKind: String, Codable, CaseIterable, Sendable {
    case local
    case cloud

    public var japaneseName: String {
        switch self {
        case .local: "このMac"
        case .cloud: "クラウド"
        }
    }
}

public enum ShannonAgentHostStatus: String, Codable, Sendable {
    case available
    case busy
    case offline

    public var japaneseName: String {
        switch self {
        case .available: "利用可能"
        case .busy: "作業中"
        case .offline: "オフライン"
        }
    }
}

public enum ShannonAgentRoutingPreference: String, Codable, CaseIterable, Sendable, Identifiable {
    case auto
    case local
    case cloud

    public var id: String { rawValue }

    public var japaneseName: String {
        switch self {
        case .auto: "自動"
        case .local: "このMac"
        case .cloud: "クラウド"
        }
    }
}

public enum ShannonAgentReasoningEffort: String, Codable, CaseIterable, Sendable, Identifiable {
    case low
    case medium
    case high
    case xhigh
    case max
    case ultra

    public var id: String { rawValue }

    public var japaneseName: String {
        switch self {
        case .low: "低"
        case .medium: "標準"
        case .high: "高"
        case .xhigh: "最高"
        case .max: "最大"
        case .ultra: "Ultra"
        }
    }
}

public struct ShannonAgentModelDTO: Codable, Equatable, Identifiable, Sendable {
    public let id: String
    public let displayName: String
    public let description: String?
    public let supportedReasoningEfforts: [ShannonAgentReasoningEffort]
    public let defaultReasoningEffort: ShannonAgentReasoningEffort?

    public init(
        id: String,
        displayName: String,
        description: String? = nil,
        supportedReasoningEfforts: [ShannonAgentReasoningEffort],
        defaultReasoningEffort: ShannonAgentReasoningEffort? = nil
    ) {
        self.id = id
        self.displayName = displayName
        self.description = description
        self.supportedReasoningEfforts = supportedReasoningEfforts
        self.defaultReasoningEffort = defaultReasoningEffort
    }
}

public struct ShannonAgentHostDTO: Codable, Equatable, Identifiable, Sendable {
    public let hostId: String
    public let displayName: String
    public let kind: ShannonAgentHostKind
    public let capabilities: [String]
    public let projects: [String]
    public let models: [ShannonAgentModelDTO]
    public let status: ShannonAgentHostStatus
    public let lastSeenAt: String

    public var id: String { hostId }
}

public struct ShannonAgentProjectDTO: Codable, Equatable, Identifiable, Sendable {
    public let key: String
    public let availableHostIds: [String]
    public let isGitRepository: Bool
    public let currentBranch: String?
    public let files: [String]
    public let changes: [ShannonAgentWorkspaceChangeDTO]

    public var id: String { key }

    public init(
        key: String,
        availableHostIds: [String],
        isGitRepository: Bool = false,
        currentBranch: String? = nil,
        files: [String] = [],
        changes: [ShannonAgentWorkspaceChangeDTO] = []
    ) {
        self.key = key
        self.availableHostIds = availableHostIds
        self.isGitRepository = isGitRepository
        self.currentBranch = currentBranch
        self.files = files
        self.changes = changes
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        key = try container.decode(String.self, forKey: .key)
        availableHostIds = try container.decode([String].self, forKey: .availableHostIds)
        isGitRepository = try container.decodeIfPresent(Bool.self, forKey: .isGitRepository) ?? false
        currentBranch = try container.decodeIfPresent(String.self, forKey: .currentBranch)
        files = try container.decodeIfPresent([String].self, forKey: .files) ?? []
        changes = try container.decodeIfPresent([ShannonAgentWorkspaceChangeDTO].self, forKey: .changes) ?? []
    }
}

public struct ShannonAgentWorkspaceChangeDTO: Codable, Equatable, Identifiable, Sendable {
    public let path: String
    public let status: String
    public let additions: Int
    public let deletions: Int

    public var id: String { path }

    public init(path: String, status: String, additions: Int, deletions: Int) {
        self.path = path
        self.status = status
        self.additions = additions
        self.deletions = deletions
    }
}

public struct ShannonAgentWorkspaceRoutingDTO: Codable, Equatable, Sendable {
    public let defaultPreference: ShannonAgentRoutingPreference
    public let resolvedHostId: String?
    public let explanation: String
}

public struct ShannonAgentWorkspaceCatalogDTO: Codable, Equatable, Sendable {
    public let routing: ShannonAgentWorkspaceRoutingDTO
    public let hosts: [ShannonAgentHostDTO]
    public let projects: [ShannonAgentProjectDTO]
    public let models: [ShannonAgentModelDTO]

    public static let unavailable = ShannonAgentWorkspaceCatalogDTO(
        routing: .init(
            defaultPreference: .auto,
            resolvedHostId: nil,
            explanation: "作業ホストへ接続すると、利用できるプロジェクトとモデルが表示されます。"
        ),
        hosts: [],
        projects: [],
        models: []
    )
}

public enum ShannonAgentProjectProvisioningStatus: String, Codable, Sendable {
    case queued
    case provisioning
    case ready
    case failed

    public var japaneseName: String {
        switch self {
        case .queued: "追加待ち"
        case .provisioning: "取得中"
        case .ready: "利用可能"
        case .failed: "失敗"
        }
    }

    public var isTerminal: Bool { self == .ready || self == .failed }
}

public struct ShannonAgentProjectProvisioningDTO: Codable, Equatable, Identifiable, Sendable {
    public let id: String
    public let repositoryURL: String
    public let projectKey: String
    public let assignedHostID: String
    public let status: ShannonAgentProjectProvisioningStatus
    public let errorMessage: String?
    public let createdAt: String
    public let updatedAt: String
}

public struct ShannonAgentProjectProvisioningEnvelopeDTO: Codable, Equatable, Sendable {
    public let request: ShannonAgentProjectProvisioningDTO
    public let requests: [ShannonAgentProjectProvisioningDTO]?
    public let created: Bool?
}

public struct ShannonAgentProjectProvisioningListDTO: Codable, Equatable, Sendable {
    public let requests: [ShannonAgentProjectProvisioningDTO]
}

public struct ShannonAgentProjectProvisioningCreateDTO: Codable, Equatable, Sendable {
    public let scopeKey: String
    public let idempotencyKey: String
    public let repositoryURL: String
    public let projectKey: String
    public let hostPreference: ShannonAgentRoutingPreference
}

public enum ShannonAgentDevelopmentOptions {
    public static func normalizedModelID(
        _ selectedModelID: String,
        models: [ShannonAgentModelDTO]
    ) -> String {
        guard !selectedModelID.isEmpty else { return "" }
        return models.contains(where: { $0.id == selectedModelID }) ? selectedModelID : ""
    }

    public static func normalizedReasoningEffort(
        _ selectedEffort: ShannonAgentReasoningEffort,
        modelID: String,
        models: [ShannonAgentModelDTO]
    ) -> ShannonAgentReasoningEffort {
        guard let model = models.first(where: { $0.id == modelID }),
              !model.supportedReasoningEfforts.isEmpty,
              !model.supportedReasoningEfforts.contains(selectedEffort)
        else { return selectedEffort }
        return model.defaultReasoningEffort ?? model.supportedReasoningEfforts[0]
    }

    public static func selectedHost(
        from hosts: [ShannonAgentHostDTO],
        preference: ShannonAgentRoutingPreference,
        resolvedHostID: String?
    ) -> ShannonAgentHostDTO? {
        switch preference {
        case .auto:
            return hosts.first { $0.hostId == resolvedHostID }
                ?? hosts.first { $0.kind == .local && $0.status != .offline }
                ?? hosts.first { $0.status != .offline }
        case .local:
            return hosts.first { $0.kind == .local }
        case .cloud:
            return hosts.first { $0.kind == .cloud }
        }
    }
}
