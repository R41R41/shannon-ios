import Foundation

public enum ShannonConversationDisplayMode: String, CaseIterable, Equatable, Sendable {
    case scroll
    case dialogue

    public var japaneseName: String {
        switch self {
        case .scroll: "スクロール"
        case .dialogue: "対話"
        }
    }

    public var symbolName: String {
        switch self {
        case .scroll: "text.bubble"
        case .dialogue: "person.crop.rectangle"
        }
    }

    public var switchActionTitle: String {
        switch self {
        case .scroll: "対話"
        case .dialogue: "履歴"
        }
    }

    public var switchActionSymbolName: String {
        switch self {
        case .scroll: "person.crop.rectangle"
        case .dialogue: "text.bubble"
        }
    }
}

public enum ShannonAppearanceMode: String, CaseIterable, Equatable, Identifiable, Sendable {
    case system
    case light
    case dark

    public static let storageKey = "shannon.appearance-mode"
    public var id: String { rawValue }

    public var japaneseName: String {
        switch self {
        case .system: "端末に合わせる"
        case .light: "ライト"
        case .dark: "ダーク"
        }
    }

    public var symbolName: String {
        switch self {
        case .system: "circle.lefthalf.filled"
        case .light: "sun.max.fill"
        case .dark: "moon.fill"
        }
    }
}

public struct ShannonTemperamentDTO: Codable, Equatable, Sendable {
    public let curiosity: Double
    public let initiative: Double
    public let closeness: Double
    public let calmness: Double
    public let needForContinuity: Double
    public let confidenceAboutUser: Double
}

public struct ShannonEmotionDTO: Codable, Equatable, Sendable {
    public let valence: Double
    public let arousal: Double
    public let openness: Double
}

public enum ShannonExpressionDTO: String, Codable, CaseIterable, Equatable, Sendable {
    case joyful
    case excited
    case amused
    case laughing
    case bashful
    case embarrassed
    case relieved
    case surprised
    case curious
    case thinking
    case confused
    case determined
    case tender
    case calm
    case jealous
    case wry
    case exasperated
    case annoyed
    case concerned
    case sad
    case sleepy
    case neutral
}

public struct ShannonMessageEmotionDTO: Codable, Equatable, Sendable {
    public let valence: Double
    public let arousal: Double
    public let openness: Double
    public let expression: ShannonExpressionDTO
}

public struct UserFactDTO: Codable, Equatable, Identifiable, Sendable {
    public let id: String
    public let statement: String
    public let confidence: Double
    public let observedAt: String
    public let evidence: String?
}

public struct ActiveMemoryDTO: Codable, Equatable, Identifiable, Sendable {
    public let id: String
    public let summary: String
    public let relevance: Double
    public let observedAt: String
}

public struct CompanionStateDTO: Codable, Equatable, Sendable {
    public let scopeKey: String
    public let version: Int
    public let updatedAt: String
    public let temperament: ShannonTemperamentDTO
    public let emotion: ShannonEmotionDTO
    public let interests: [String]
    public let userFacts: [UserFactDTO]
    public let activeMemories: [ActiveMemoryDTO]
}

public struct ChatRequestDTO: Codable, Equatable, Sendable {
    public let scopeKey: String
    public let message: String
    public let threadId: String?
    public let attachments: [ShannonChatAttachmentDTO]?
    public let webSearch: Bool?

    public init(
        scopeKey: String,
        message: String,
        threadId: String? = nil,
        attachments: [ShannonChatAttachmentDTO] = [],
        webSearch: Bool = false
    ) {
        self.scopeKey = scopeKey
        self.message = message
        self.threadId = threadId
        self.attachments = attachments.isEmpty ? nil : attachments
        self.webSearch = webSearch ? true : nil
    }
}

public struct ShannonChatAttachmentDTO: Codable, Equatable, Sendable {
    public let name: String
    public let mimeType: String
    public let text: String

    public init(name: String, mimeType: String, text: String) {
        self.name = name
        self.mimeType = mimeType
        self.text = text
    }
}

public struct ShannonGeneratedArtifactDTO: Codable, Equatable, Sendable {
    public let name: String
    public let mimeType: String
    public let content: String
    public let summary: String?

    public init(name: String, mimeType: String, content: String, summary: String? = nil) {
        self.name = name
        self.mimeType = mimeType
        self.content = content
        self.summary = summary
    }
}

public struct ChatThreadDTO: Codable, Equatable, Sendable {
    public let threadId: String
    public let title: String
    public let createdAt: String
    public let updatedAt: String
    public let messageCount: Int
    public let summary: String?
    public let sections: [String]?

    public init(
        threadId: String,
        title: String,
        createdAt: String,
        updatedAt: String,
        messageCount: Int,
        summary: String? = nil,
        sections: [String]? = nil
    ) {
        self.threadId = threadId
        self.title = title
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.messageCount = messageCount
        self.summary = summary
        self.sections = sections
    }
}

public struct ShannonUIBlockDTO: Codable, Equatable, Sendable {
    public let type: String
    public let proposalId: String?
    public let title: String?
    public let goal: String?
    public let hostHint: String?
    public let projectHint: String?
    public let risk: String?
    public let session: ShannonOrganizeSessionDTO?

    public init(
        type: String = "agent_task_proposal",
        proposalId: String? = nil,
        title: String? = nil,
        goal: String? = nil,
        hostHint: String? = nil,
        projectHint: String? = nil,
        risk: String? = nil,
        session: ShannonOrganizeSessionDTO? = nil
    ) {
        self.type = type
        self.proposalId = proposalId
        self.title = title
        self.goal = goal
        self.hostHint = hostHint
        self.projectHint = projectHint
        self.risk = risk
        self.session = session
    }
}

public enum ShannonOrganizeDecisionDTO: String, Codable, Equatable, Sendable {
    case proposed, accepted, rejected, deferred
}

public enum ShannonOrganizeDestinationStatusDTO: String, Codable, Equatable, Sendable {
    case pending, applied, failed
}

public enum ShannonOrganizeSessionStateDTO: String, Codable, Equatable, Sendable {
    case readyForReview = "ready_for_review"
    case partiallyApplied = "partially_applied"
    case applied
}

public enum ShannonOrganizeOperationDTO: String, Codable, Equatable, Hashable, Sendable {
    case create, update
}

public enum ShannonOrganizeUpdateFieldDTO: String, Codable, Equatable, Hashable, Sendable {
    case title, details, projectIds
}

public struct ShannonVoyagerTaskProjectionDTO: Codable, Equatable, Identifiable, Sendable {
    public let id: String
    public let title: String
    public let details: String
    public let status: String
    public let projectIds: [String]
    public let revision: Int
    public let updatedAt: String

    public init(id: String, title: String, details: String, status: String, projectIds: [String], revision: Int, updatedAt: String) {
        self.id = id
        self.title = title
        self.details = details
        self.status = status
        self.projectIds = projectIds
        self.revision = revision
        self.updatedAt = updatedAt
    }
}

public struct ShannonVoyagerProjectProjectionDTO: Codable, Equatable, Identifiable, Sendable {
    public let id: String
    public let title: String
    public let revision: Int
    public let updatedAt: String

    public init(id: String, title: String, revision: Int, updatedAt: String) {
        self.id = id
        self.title = title
        self.revision = revision
        self.updatedAt = updatedAt
    }
}

public struct ShannonVoyagerTaskProjectionListDTO: Codable, Equatable, Sendable {
    public let items: [ShannonVoyagerTaskProjectionDTO]
}

public struct ShannonVoyagerProjectProjectionListDTO: Codable, Equatable, Sendable {
    public let items: [ShannonVoyagerProjectProjectionDTO]
}

public struct ShannonVoyagerTaskReferenceDTO: Codable, Equatable, Identifiable, Sendable {
    public var id: String { resourceId }
    public let system: String
    public let resourceType: String
    public let resourceId: String
    public let title: String
    public let summary: String?
    public let updatedAt: String
    public let href: String?
}

public struct ShannonOrganizeItemDTO: Codable, Equatable, Identifiable, Sendable {
    public let id: String
    public let title: String
    public let details: String
    public let operation: ShannonOrganizeOperationDTO?
    public let target: ShannonVoyagerTaskProjectionDTO?
    public let projectIds: [String]?
    public let targetQuery: String?
    public let updateFields: [ShannonOrganizeUpdateFieldDTO]?
    public let projectSelectionRequired: Bool?
    public let decision: ShannonOrganizeDecisionDTO
    public let destinationStatus: ShannonOrganizeDestinationStatusDTO
    public let requestId: String
    public let idempotencyKey: String
    public let result: ShannonVoyagerTaskReferenceDTO?
    public let errorCode: String?

    public init(
        id: String,
        title: String,
        details: String,
        operation: ShannonOrganizeOperationDTO? = nil,
        target: ShannonVoyagerTaskProjectionDTO? = nil,
        projectIds: [String]? = nil,
        targetQuery: String? = nil,
        updateFields: [ShannonOrganizeUpdateFieldDTO]? = nil,
        projectSelectionRequired: Bool? = nil,
        decision: ShannonOrganizeDecisionDTO,
        destinationStatus: ShannonOrganizeDestinationStatusDTO,
        requestId: String,
        idempotencyKey: String,
        result: ShannonVoyagerTaskReferenceDTO?,
        errorCode: String?
    ) {
        self.id = id
        self.title = title
        self.details = details
        self.operation = operation
        self.target = target
        self.projectIds = projectIds
        self.targetQuery = targetQuery
        self.updateFields = updateFields
        self.projectSelectionRequired = projectSelectionRequired
        self.decision = decision
        self.destinationStatus = destinationStatus
        self.requestId = requestId
        self.idempotencyKey = idempotencyKey
        self.result = result
        self.errorCode = errorCode
    }
}

public struct ShannonOrganizeSessionDTO: Codable, Equatable, Identifiable, Sendable {
    public let id: String
    public let scopeKey: String
    public let threadId: String
    public let state: ShannonOrganizeSessionStateDTO
    public let revision: Int
    public let sourceMessageIds: [String]
    public let commandThroughMessageId: String?
    public let items: [ShannonOrganizeItemDTO]
    public let createdAt: String
    public let updatedAt: String
    public let appliedAt: String?
}

public struct ShannonOrganizeSessionEnvelopeDTO: Codable, Equatable, Sendable {
    public let session: ShannonOrganizeSessionDTO
}

public struct ShannonOrganizeSessionListDTO: Codable, Equatable, Sendable {
    public let sessions: [ShannonOrganizeSessionDTO]
}

public struct ShannonOrganizeDecisionRequestDTO: Codable, Equatable, Sendable {
    public let scopeKey: String
    public let expectedRevision: Int
    public let decision: ShannonOrganizeDecisionDTO
    public let title: String?
    public let details: String?
    public let operation: ShannonOrganizeOperationDTO?
    public let target: ShannonVoyagerTaskProjectionDTO?
    public let projectIds: [String]?

    public init(
        scopeKey: String,
        expectedRevision: Int,
        decision: ShannonOrganizeDecisionDTO,
        title: String?,
        details: String?,
        operation: ShannonOrganizeOperationDTO? = nil,
        target: ShannonVoyagerTaskProjectionDTO? = nil,
        projectIds: [String]? = nil
    ) {
        self.scopeKey = scopeKey
        self.expectedRevision = expectedRevision
        self.decision = decision
        self.title = title
        self.details = details
        self.operation = operation
        self.target = target
        self.projectIds = projectIds
    }
}

public struct ShannonOrganizeApplyRequestDTO: Codable, Equatable, Sendable {
    public let scopeKey: String
    public let expectedRevision: Int
}

public struct ShannonOrganizeApplyResponseDTO: Codable, Equatable, Sendable {
    public let session: ShannonOrganizeSessionDTO
    public let appliedCount: Int
    public let tasks: [ShannonVoyagerTaskReferenceDTO]
}

public struct ShannonAgentTimelineEventDTO: Codable, Equatable, Sendable {
    public let id: String
    public let sequence: Int
    public let title: String
    public let detail: String?
    public let occurredAt: String
    public let tone: ShannonAgentEventTone
    public let activity: ShannonAgentTimelineActivity?
}

public struct ShannonAgentApprovalDTO: Codable, Equatable, Sendable {
    public let id: String
    public let externalRequestID: String
    public let kind: ShannonAgentApprovalKind
    public let title: String
    public let reason: String
    public let resource: String?
    public let requestedAt: String
}

public struct ShannonAgentChangeSummaryDTO: Codable, Equatable, Sendable {
    public let id: String
    public let displayName: String
    public let summary: String
    public let additions: Int
    public let deletions: Int
}

public struct ShannonAgentTestResultDTO: Codable, Equatable, Sendable {
    public let id: String
    public let name: String
    public let status: ShannonAgentTestStatus
    public let detail: String?
}

public struct ShannonAgentTaskRemoteDTO: Codable, Equatable, Sendable {
    public let id: String
    public let conversationThreadID: String
    public let sourceMessageID: String?
    public let title: String
    public let goal: String
    public let status: ShannonAgentTaskStatus
    public let summary: String
    public let currentAction: String?
    public let plan: [ShannonAgentPlanItem]
    public let timeline: [ShannonAgentTimelineEventDTO]
    public let pendingApproval: ShannonAgentApprovalDTO?
    public let changes: [ShannonAgentChangeSummaryDTO]
    public let tests: [ShannonAgentTestResultDTO]
    public let createdAt: String
    public let updatedAt: String
    public let latestSequence: Int
}

public struct ShannonAgentTaskEnvelopeDTO: Codable, Equatable, Sendable {
    public let task: ShannonAgentTaskRemoteDTO
    public let created: Bool?
}

public struct ShannonAgentTaskListDTO: Codable, Equatable, Sendable {
    public let tasks: [ShannonAgentTaskRemoteDTO]
}

public struct ShannonAgentTaskCreateRequestDTO: Codable, Equatable, Sendable {
    public let scopeKey: String
    public let taskId: String
    public let idempotencyKey: String
    public let conversationThreadID: String
    public let sourceMessageID: String?
    public let title: String
    public let goal: String
    public let summary: String
    public let plan: [ShannonAgentPlanItem]
    public let hostHint: String?
    public let projectHint: String?
}

public struct ShannonAgentTaskCommandRequestDTO: Codable, Equatable, Sendable {
    public let scopeKey: String
    public let idempotencyKey: String
    public let type: String
    public let payload: [String: String]
}

public struct ChatResponseDTO: Codable, Equatable, Sendable {
    public let thread: ChatThreadDTO?
    public let mode: String
    public let reply: String
    public let threadId: String
    public let snapshotVersion: Int
    public let messageEmotion: ShannonMessageEmotionDTO
    public let systemPrompt: String
    public let state: CompanionStateDTO
    public let uiBlocks: [ShannonUIBlockDTO]?
    public let artifacts: [ShannonGeneratedArtifactDTO]?

    public init(
        mode: String,
        reply: String,
        threadId: String,
        snapshotVersion: Int,
        messageEmotion: ShannonMessageEmotionDTO,
        systemPrompt: String,
        state: CompanionStateDTO,
        uiBlocks: [ShannonUIBlockDTO]? = nil,
        artifacts: [ShannonGeneratedArtifactDTO]? = nil,
        thread: ChatThreadDTO? = nil
    ) {
        self.thread = thread
        self.mode = mode
        self.reply = reply
        self.threadId = threadId
        self.snapshotVersion = snapshotVersion
        self.messageEmotion = messageEmotion
        self.systemPrompt = systemPrompt
        self.state = state
        self.uiBlocks = uiBlocks
        self.artifacts = artifacts
    }
}

public struct ShannonRealtimeVoiceCallDTO: Equatable, Sendable {
    public let answerSDP: String
    public let threadID: String
    public let model: String?
    public let callID: String?
    public let dailyRemainingSeconds: Int?

    public init(
        answerSDP: String,
        threadID: String,
        model: String? = nil,
        callID: String? = nil,
        dailyRemainingSeconds: Int? = nil
    ) {
        self.answerSDP = answerSDP
        self.threadID = threadID
        self.model = model
        self.callID = callID
        self.dailyRemainingSeconds = dailyRemainingSeconds
    }
}

public enum ShannonVoiceIdentityModeDTO: String, Codable, CaseIterable, Equatable, Sendable {
    case automatic
    case manual

    public var japaneseName: String {
        switch self {
        case .automatic: "シャノンに任せる"
        case .manual: "自分で選ぶ"
        }
    }
}

public struct ShannonVoiceCandidateDTO: Codable, Equatable, Identifiable, Sendable {
    public let id: String
    public let name: String

    public init(id: String, name: String) {
        self.id = id
        self.name = name
    }
}

public struct ShannonVoiceIdentityPreferenceDTO: Codable, Equatable, Sendable {
    public let mode: ShannonVoiceIdentityModeDTO
    public let selectedVoice: String?
    public let effectiveVoice: String
    public let updatedAt: String?

    public init(
        mode: ShannonVoiceIdentityModeDTO,
        selectedVoice: String?,
        effectiveVoice: String,
        updatedAt: String?
    ) {
        self.mode = mode
        self.selectedVoice = selectedVoice
        self.effectiveVoice = effectiveVoice
        self.updatedAt = updatedAt
    }
}

public struct ShannonVoiceIdentityResponseDTO: Codable, Equatable, Sendable {
    public let preference: ShannonVoiceIdentityPreferenceDTO
    public let candidates: [ShannonVoiceCandidateDTO]

    public init(
        preference: ShannonVoiceIdentityPreferenceDTO,
        candidates: [ShannonVoiceCandidateDTO]
    ) {
        self.preference = preference
        self.candidates = candidates
    }
}

public struct ShannonVoiceIdentityUpdateRequestDTO: Codable, Equatable, Sendable {
    public let scopeKey: String
    public let mode: ShannonVoiceIdentityModeDTO
    public let selectedVoice: String?

    public init(scopeKey: String, mode: ShannonVoiceIdentityModeDTO, selectedVoice: String?) {
        self.scopeKey = scopeKey
        self.mode = mode
        self.selectedVoice = selectedVoice
    }
}

public struct ShannonVoicePreviewRequestDTO: Codable, Equatable, Sendable {
    public let voice: String

    public init(voice: String) {
        self.voice = voice
    }
}

public struct ShannonRealtimeVoiceTurnRequestDTO: Codable, Equatable, Sendable {
    public let scopeKey: String
    public let threadId: String?
    public let userTranscript: String
    public let shannonTranscript: String
}

public struct ShannonRealtimeVoiceTurnResponseDTO: Codable, Equatable, Sendable {
    public let threadId: String
    public let messageEmotion: ShannonMessageEmotionDTO
    public let state: CompanionStateDTO
}

public struct StoredConversationMessageDTO: Codable, Equatable, Sendable {
    public let id: String
    public let role: String
    public let content: String
    public let observedAt: String
    public let messageEmotion: ShannonMessageEmotionDTO?
    public let stateVersion: Int?
    public let artifacts: [ShannonGeneratedArtifactDTO]?
    public let sourceAttribution: ShannonSourceAttributionDTO?

    public init(
        id: String,
        role: String,
        content: String,
        observedAt: String,
        messageEmotion: ShannonMessageEmotionDTO? = nil,
        stateVersion: Int? = nil,
        artifacts: [ShannonGeneratedArtifactDTO]? = nil,
        sourceAttribution: ShannonSourceAttributionDTO? = nil
    ) {
        self.id = id
        self.role = role
        self.content = content
        self.observedAt = observedAt
        self.messageEmotion = messageEmotion
        self.stateVersion = stateVersion
        self.artifacts = artifacts
        self.sourceAttribution = sourceAttribution
    }
}

public struct ShannonSourceAttributionDTO: Codable, Equatable, Sendable {
    public let title: String
    public let url: String
    public let reason: String

    public init(title: String, url: String, reason: String) {
        self.title = title
        self.url = url
        self.reason = reason
    }
}

public struct ConversationHistoryResponseDTO: Codable, Equatable, Sendable {
    public let threadId: String
    public let messages: [StoredConversationMessageDTO]
    public let state: CompanionStateDTO
}

public struct ThreadListResponseDTO: Codable, Equatable, Sendable {
    public let threads: [ChatThreadDTO]
}

public struct ThreadCreateRequestDTO: Codable, Equatable, Sendable {
    public let scopeKey: String
    public let title: String?

    public init(scopeKey: String, title: String? = nil) {
        self.scopeKey = scopeKey
        self.title = title
    }
}

public struct ThreadCreateResponseDTO: Codable, Equatable, Sendable {
    public let threadId: String
}

public struct ThreadArchiveRequestDTO: Codable, Equatable, Sendable {
    public let scopeKey: String
    public let threadId: String
}

public struct ThreadArchiveResponseDTO: Codable, Equatable, Sendable {
    public let archived: Bool
}

public struct ThreadRenameRequestDTO: Codable, Equatable, Sendable {
    public let scopeKey: String
    public let threadId: String
    public let title: String

    public init(scopeKey: String, threadId: String, title: String) {
        self.scopeKey = scopeKey
        self.threadId = threadId
        self.title = title
    }
}

public struct ThreadRenameResponseDTO: Codable, Equatable, Sendable {
    public let renamed: Bool
}

public struct ShannonInitiativeMessageDTO: Codable, Equatable, Identifiable, Sendable {
    public let id: String
    public let threadId: String
    public let content: String
    public let expression: ShannonExpressionDTO
    public let sourceTitle: String
    public let sourceURL: String
    public let createdAt: String
    public let readAt: String?
}

public struct ShannonInitiativeInboxDTO: Codable, Equatable, Sendable {
    public let unreadCount: Int
    public let messages: [ShannonInitiativeMessageDTO]
}

public struct ShannonInitiativeReadRequestDTO: Codable, Equatable, Sendable {
    public let scopeKey: String
}

public struct ShannonInitiativeReadResponseDTO: Codable, Equatable, Sendable {
    public let markedRead: Int
}

public enum ShannonPushEnvironmentDTO: String, Codable, Equatable, Sendable {
    case sandbox
    case production
}

public struct ShannonPushRegistrationRequestDTO: Codable, Equatable, Sendable {
    public let deviceToken: String
    public let environment: ShannonPushEnvironmentDTO

    public init(deviceToken: String, environment: ShannonPushEnvironmentDTO) {
        self.deviceToken = deviceToken
        self.environment = environment
    }
}

public struct ShannonPushRegistrationResponseDTO: Codable, Equatable, Sendable {
    public let registered: Bool
}

public enum ShannonTestFlightConditionDTO: String, Codable, Equatable, Sendable {
    case healthy
    case waiting
    case attention
}

public enum ShannonTestFlightDeliveryStatusDTO: String, Codable, Equatable, Sendable {
    case distributed
    case alreadyCurrent = "already-current"
    case noValidBuild = "no-valid-build"
    case failed
}

public enum ShannonTestFlightNotificationStatusDTO: String, Codable, Equatable, Sendable {
    case notNeeded = "not-needed"
    case pending
    case sent
    case suppressed
}

public struct ShannonTestFlightDeliveryHistoryItemDTO: Codable, Equatable, Identifiable, Sendable {
    public let id: String
    public let status: ShannonTestFlightDeliveryStatusDTO
    public let buildVersion: String?
    public let checkedAt: String
    public let failureCode: String?
    public let notificationStatus: ShannonTestFlightNotificationStatusDTO

    public init(
        id: String,
        status: ShannonTestFlightDeliveryStatusDTO,
        buildVersion: String?,
        checkedAt: String,
        failureCode: String?,
        notificationStatus: ShannonTestFlightNotificationStatusDTO
    ) {
        self.id = id
        self.status = status
        self.buildVersion = buildVersion
        self.checkedAt = checkedAt
        self.failureCode = failureCode
        self.notificationStatus = notificationStatus
    }
}

public struct ShannonTestFlightDeliveryDashboardDTO: Codable, Equatable, Sendable {
    public let condition: ShannonTestFlightConditionDTO
    public let latestBuildVersion: String?
    public let lastCheckedAt: String?
    public let activeFailureCode: String?
    public let history: [ShannonTestFlightDeliveryHistoryItemDTO]

    public init(
        condition: ShannonTestFlightConditionDTO,
        latestBuildVersion: String?,
        lastCheckedAt: String?,
        activeFailureCode: String?,
        history: [ShannonTestFlightDeliveryHistoryItemDTO]
    ) {
        self.condition = condition
        self.latestBuildVersion = latestBuildVersion
        self.lastCheckedAt = lastCheckedAt
        self.activeFailureCode = activeFailureCode
        self.history = history
    }
}

public struct AetherProposalRequestDTO: Codable, Equatable, Sendable {
    public let scopeKey: String
    public let title: String
    public let content: String
    public let reason: String
}

public struct AetherProposalResponseDTO: Codable, Equatable, Sendable {
    public let id: String
    public let operation: String
    public let title: String
    public let content: String
    public let reason: String
    public let createdAt: String
}

public enum ShannonMemoryKindDTO: String, Codable, CaseIterable, Equatable, Sendable {
    case userFact = "user-fact"
    case interest
    case experience
    case relationship

    public var japaneseName: String {
        switch self {
        case .userFact: "あなたについて"
        case .interest: "シャノンの興味"
        case .experience: "思い出"
        case .relationship: "ふたりの関係"
        }
    }

    public var symbolName: String {
        switch self {
        case .userFact: "person.text.rectangle"
        case .interest: "sparkles"
        case .experience: "bubble.left.and.bubble.right"
        case .relationship: "heart.text.square"
        }
    }
}

public enum ShannonMemoryStatusDTO: String, Codable, Equatable, Sendable {
    case active
    case forgotten
    case rejected
}

public struct ShannonMemoryEvidenceDTO: Codable, Equatable, Sendable {
    public let quote: String
    public let observedAt: String
    public let source: String
}

public struct ShannonMemoryItemDTO: Codable, Equatable, Identifiable, Sendable {
    public let id: String
    public let kind: ShannonMemoryKindDTO
    public let text: String
    public let confidence: Double?
    public let relevance: Double?
    public let status: ShannonMemoryStatusDTO
    public let pinned: Bool
    public let createdAt: String
    public let updatedAt: String
    public let changeReason: String
    public let evidence: [ShannonMemoryEvidenceDTO]
}

public struct ShannonSleepChangeDTO: Codable, Equatable, Identifiable, Sendable {
    public let kind: ShannonMemoryKindDTO
    public let memoryId: String
    public let text: String
    public let reason: String
    public let evidence: String?

    public var id: String { "\(kind.rawValue):\(memoryId):\(text)" }
}

public struct ShannonSleepContradictionDTO: Codable, Equatable, Identifiable, Sendable {
    public let kind: ShannonMemoryKindDTO
    public let memoryId: String
    public let currentText: String
    public let candidateText: String
    public let reason: String
    public let evidence: String

    public var id: String { "\(kind.rawValue):\(memoryId):\(candidateText)" }
}

public struct ShannonSleepReportDTO: Codable, Equatable, Identifiable, Sendable {
    public let dayKey: String
    public let completedAt: String
    public let learned: [ShannonSleepChangeDTO]
    public let updated: [ShannonSleepChangeDTO]
    public let interestChanges: [ShannonSleepChangeDTO]
    public let contradictions: [ShannonSleepContradictionDTO]

    public var id: String { "\(dayKey):\(completedAt)" }
}

public struct ShannonMemoryDashboardDTO: Codable, Equatable, Sendable {
    public let generatedAt: String
    public let currentState: CompanionStateDTO?
    public let knowledge: [ShannonKnowledgeAnswerDTO]?
    public let personalityProfile: ShannonPersonalityProfileDTO?
    public let activity: [ShannonActivityItemDTO]?
    public let world: [ShannonWorldItemDTO]?
    public let usage: ShannonLlmUsageSummaryDTO?
    public let evaluation: ShannonInitiativeEvaluationDTO?
    public let dailyMind: ShannonDailyMindDTO?
    public let items: [ShannonMemoryItemDTO]
    public let sleepReports: [ShannonSleepReportDTO]

    public init(
        generatedAt: String,
        currentState: CompanionStateDTO? = nil,
        knowledge: [ShannonKnowledgeAnswerDTO]? = nil,
        personalityProfile: ShannonPersonalityProfileDTO? = nil,
        activity: [ShannonActivityItemDTO]? = nil,
        world: [ShannonWorldItemDTO]? = nil,
        usage: ShannonLlmUsageSummaryDTO? = nil,
        evaluation: ShannonInitiativeEvaluationDTO? = nil,
        dailyMind: ShannonDailyMindDTO? = nil,
        items: [ShannonMemoryItemDTO],
        sleepReports: [ShannonSleepReportDTO]
    ) {
        self.generatedAt = generatedAt
        self.currentState = currentState
        self.knowledge = knowledge
        self.personalityProfile = personalityProfile
        self.activity = activity
        self.world = world
        self.usage = usage
        self.evaluation = evaluation
        self.dailyMind = dailyMind
        self.items = items
        self.sleepReports = sleepReports
    }
}

public struct ShannonDailyMindDTO: Codable, Equatable, Sendable {
    public let scopeKey: String
    public let dayKey: String
    public let topic: String
    public let reason: String
    public let sourceItemId: String?
    public let sourceTitle: String?
    public let sourceURL: String?
    public let openingLine: String?
    public let createdAt: String
    public let expiresAt: String
}

public struct ShannonInitiativeEvaluationDTO: Codable, Equatable, Sendable {
    public let windowDays: Int
    public let runs: Int
    public let eligibleRuns: Int
    public let delivered: Int
    public let deliveryRate: Double
    public let candidatesConsidered: Int
    public let repeatedCandidatesSuppressed: Int?
    public let deliveredBySource: [ShannonInitiativeSourceCountDTO]?
    public let stopped: [String: Int]
}

public struct ShannonInitiativeSourceCountDTO: Codable, Equatable, Sendable {
    public let sourceTitle: String
    public let count: Int
}

public struct ShannonPersonalityProfileDTO: Codable, Equatable, Sendable {
    public let version: Int
    public let analysis: String
    public let createdAt: String
}

public struct ShannonKnowledgeEvidenceDTO: Codable, Equatable, Sendable {
    public let quote: String
    public let source: String
    public let observedAt: String
}

public struct ShannonKnowledgeAnswerDTO: Codable, Equatable, Identifiable, Sendable {
    public let answerId: String
    public let questionKey: String
    public let category: String
    public let question: String
    public let answer: String
    public let confidence: Double
    public let source: String
    public let confirmed: Bool
    public let updatedAt: String
    public let evidence: [ShannonKnowledgeEvidenceDTO]

    public var id: String { answerId }
}

public struct ShannonActivityItemDTO: Codable, Equatable, Identifiable, Sendable {
    public let id: String
    public let type: String
    public let title: String
    public let detail: String?
    public let occurredAt: String
}

public struct ShannonWorldItemDTO: Codable, Equatable, Identifiable, Sendable {
    public let id: String
    public let sourceId: String
    public let sourceTitle: String
    public let title: String
    public let url: String
    public let summary: String?
    public let author: String?
    public let publishedAt: String?
    public let discoveredAt: String
}

public struct ShannonLlmUsageRowDTO: Codable, Equatable, Identifiable, Sendable {
    public let lane: String
    public let calls: Int
    public let inputTokens: Int
    public let cachedInputTokens: Int
    public let outputTokens: Int
    public let totalTokens: Int
    public let estimatedCostUsd: Double

    public var id: String { lane }
}

public struct ShannonLlmUsageSummaryDTO: Codable, Equatable, Sendable {
    public let monthKey: String
    public let dayKey: String?
    public let estimatedCostUsd: Double
    public let backgroundCostUsd: Double
    public let todayBackgroundCostUsd: Double?
    public let backgroundBudgetUsd: Double
    public let backgroundRemainingUsd: Double
    public let rows: [ShannonLlmUsageRowDTO]
}

public enum ShannonMemoryActionDTO: String, Codable, Equatable, Sendable {
    case correct
    case forget
    case pin
    case unpin
    case reject
    case restore
}

public struct ShannonMemoryMutationDTO: Codable, Equatable, Sendable {
    public let scopeKey: String
    public let memoryId: String
    public let action: ShannonMemoryActionDTO
    public let text: String?

    public init(scopeKey: String, memoryId: String, action: ShannonMemoryActionDTO, text: String? = nil) {
        self.scopeKey = scopeKey
        self.memoryId = memoryId
        self.action = action
        self.text = text
    }
}

public struct ShannonKnowledgeCorrectionDTO: Codable, Equatable, Sendable {
    public let scopeKey: String
    public let answerId: String
    public let answer: String
}

public struct ConversationMessage: Equatable, Identifiable, Sendable {
    public enum Role: Equatable, Sendable {
        case user
        case shannon
    }

    public enum DeliveryState: Equatable, Sendable {
        case sending
        case sent
        case failed
    }

    public struct EmotionSnapshot: Equatable, Sendable {
        public let valence: Double
        public let arousal: Double
        public let openness: Double
        public let expression: ShannonExpressionDTO
        public let stateVersion: Int

        public init(
            valence: Double,
            arousal: Double,
            openness: Double,
            expression: ShannonExpressionDTO,
            stateVersion: Int
        ) {
            self.valence = valence
            self.arousal = arousal
            self.openness = openness
            self.expression = expression
            self.stateVersion = stateVersion
        }
    }

    public let id: UUID
    public let role: Role
    public let text: String
    public let sentAt: Date
    public let deliveryState: DeliveryState
    public let emotionSnapshot: EmotionSnapshot?
    public let artifacts: [ShannonGeneratedArtifactDTO]
    public let sourceAttribution: ShannonSourceAttributionDTO?

    public init(
        id: UUID = UUID(),
        role: Role,
        text: String,
        sentAt: Date = Date(),
        deliveryState: DeliveryState = .sent,
        emotionSnapshot: EmotionSnapshot? = nil,
        artifacts: [ShannonGeneratedArtifactDTO] = [],
        sourceAttribution: ShannonSourceAttributionDTO? = nil
    ) {
        self.id = id
        self.role = role
        self.text = text
        self.sentAt = sentAt
        self.deliveryState = deliveryState
        self.emotionSnapshot = emotionSnapshot
        self.artifacts = artifacts
        self.sourceAttribution = sourceAttribution
    }

    public func withDeliveryState(_ deliveryState: DeliveryState) -> ConversationMessage {
        ConversationMessage(
            id: id,
            role: role,
            text: text,
            sentAt: sentAt,
            deliveryState: deliveryState,
            emotionSnapshot: emotionSnapshot,
            artifacts: artifacts,
            sourceAttribution: sourceAttribution
        )
    }
}

enum ShannonConversationTimelineItem: Identifiable, Equatable {
    case day(Date)
    case message(ConversationMessage)

    var id: String {
        switch self {
        case .day(let date): "day:\(date.timeIntervalSinceReferenceDate)"
        case .message(let message): "message:\(message.id.uuidString)"
        }
    }
}

enum ShannonConversationTimeline {
    static func items(
        from messages: [ConversationMessage],
        calendar: Calendar = .current
    ) -> [ShannonConversationTimelineItem] {
        var result: [ShannonConversationTimelineItem] = []
        var latestDay: Date?

        for message in messages {
            let day = calendar.startOfDay(for: message.sentAt)
            if latestDay != day {
                result.append(.day(day))
                latestDay = day
            }
            result.append(.message(message))
        }
        return result
    }
}
