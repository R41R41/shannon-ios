import Foundation

public protocol ShannonChatServing: Sendable {
    func send(message: String, scopeKey: String, threadId: String?) async throws -> ChatResponseDTO
    func send(
        message: String,
        scopeKey: String,
        threadId: String?,
        attachments: [ShannonChatAttachmentDTO]
    ) async throws -> ChatResponseDTO
    func send(
        message: String,
        scopeKey: String,
        threadId: String?,
        attachments: [ShannonChatAttachmentDTO],
        webSearch: Bool
    ) async throws -> ChatResponseDTO
}

public protocol ShannonVoiceServing: Sendable {
    func transcribeVoice(scopeKey: String, recording: ShannonVoiceRecording) async throws -> ShannonVoiceTranscriptionDTO
    func createRealtimeVoiceCall(scopeKey: String, threadId: String?, offerSDP: String) async throws -> ShannonRealtimeVoiceCallDTO
    func loadVoiceIdentity(scopeKey: String) async throws -> ShannonVoiceIdentityResponseDTO
    func updateVoiceIdentity(
        scopeKey: String,
        mode: ShannonVoiceIdentityModeDTO,
        selectedVoice: String?
    ) async throws -> ShannonVoiceIdentityResponseDTO
    func loadVoicePreview(scopeKey: String, voice: String) async throws -> Data
    func commitRealtimeVoiceTurn(
        scopeKey: String,
        threadId: String?,
        userTranscript: String,
        shannonTranscript: String
    ) async throws -> ShannonRealtimeVoiceTurnResponseDTO
}

public protocol ShannonConversationServing: Sendable {
    func loadConversation(scopeKey: String, threadId: String?) async throws -> ConversationHistoryResponseDTO
    func loadThreads(scopeKey: String) async throws -> ThreadListResponseDTO
    func createThread(scopeKey: String, title: String?) async throws -> String
    func renameThread(scopeKey: String, threadId: String, title: String) async throws
    func archiveThread(scopeKey: String, threadId: String) async throws
}

public protocol ShannonMemoryServing: Sendable {
    func loadMemories(scopeKey: String) async throws -> ShannonMemoryDashboardDTO
    func mutateMemory(
        scopeKey: String,
        memoryID: String,
        action: ShannonMemoryActionDTO,
        text: String?
    ) async throws -> ShannonMemoryDashboardDTO
    func correctKnowledge(scopeKey: String, answerId: String, answer: String) async throws -> ShannonMemoryDashboardDTO
}

public protocol ShannonInitiativeServing: Sendable {
    func loadInitiatives(scopeKey: String) async throws -> ShannonInitiativeInboxDTO
    func markInitiativesRead(scopeKey: String, threadId: String?) async throws -> Int
}

public protocol ShannonWorldServing: Sendable {
    func loadWorldSources(scopeKey: String) async throws -> [ShannonWorldSourceDTO]
    func loadWorldSubscriptions(scopeKey: String) async throws -> [ShannonWorldSubscriptionDTO]
    func decideWorldSubscription(
        scopeKey: String,
        subscriptionID: String,
        decision: ShannonWorldSubscriptionDecisionDTO,
        expectedUpdatedAt: String
    ) async throws -> ShannonWorldSubscriptionDTO
}

public protocol ShannonPushServing: Sendable {
    func registerPushToken(
        scopeKey: String,
        deviceToken: String,
        environment: ShannonPushEnvironmentDTO
    ) async throws
}

public protocol ShannonDeliveryServing: Sendable {
    func loadTestFlightDelivery(scopeKey: String) async throws -> ShannonTestFlightDeliveryDashboardDTO
    func confirmTestFlightReleaseGate(
        scopeKey: String,
        buildVersion: String,
        gate: ShannonReleaseGateKeyDTO
    ) async throws -> ShannonTestFlightDeliveryDashboardDTO
}

public protocol ShannonAetherServing: Sendable {
    func createAetherProposal(scopeKey: String, title: String, content: String, reason: String) async throws -> AetherProposalResponseDTO
}

public protocol ShannonAgentTaskServing: Sendable {
    func loadAgentWorkspace(scopeKey: String, projectHint: String?) async throws -> ShannonAgentWorkspaceCatalogDTO
    func createAgentTask(scopeKey: String, task: ShannonAgentTask, idempotencyKey: String) async throws -> ShannonAgentTask
    func loadAgentTasks(scopeKey: String) async throws -> [ShannonAgentTask]
    func loadAgentTask(scopeKey: String, taskID: UUID, afterSequence: Int?) async throws -> ShannonAgentTask?
    func sendAgentTaskCommand(
        scopeKey: String,
        taskID: UUID,
        type: String,
        payload: [String: String],
        idempotencyKey: String
    ) async throws -> ShannonAgentTask
    func updateAgentTaskMetadata(
        scopeKey: String,
        taskID: UUID,
        isPinned: Bool?,
        isArchived: Bool?
    ) async throws -> ShannonAgentTask
    func loadAgentProjectProvisioning(scopeKey: String) async throws -> [ShannonAgentProjectProvisioningDTO]
    func createAgentProjectProvisioning(
        scopeKey: String,
        repositoryURL: String,
        projectKey: String,
        hostPreference: ShannonAgentRoutingPreference,
        idempotencyKey: String
    ) async throws -> [ShannonAgentProjectProvisioningDTO]
}

public protocol ShannonOrganizeServing: Sendable {
    func loadOrganizeSessions(scopeKey: String, threadId: String) async throws -> [ShannonOrganizeSessionDTO]
    func decideOrganizeItem(
        scopeKey: String,
        sessionId: String,
        itemId: String,
        expectedRevision: Int,
        decision: ShannonOrganizeDecisionDTO,
        title: String?,
        details: String?
    ) async throws -> ShannonOrganizeSessionDTO
    func decideOrganizeItemV2(
        scopeKey: String,
        sessionId: String,
        itemId: String,
        expectedRevision: Int,
        decision: ShannonOrganizeDecisionDTO,
        title: String?,
        details: String?,
        operation: ShannonOrganizeOperationDTO?,
        target: ShannonVoyagerTaskProjectionDTO?,
        projectIds: [String]?
    ) async throws -> ShannonOrganizeSessionDTO
    func searchVoyagerTasks(scopeKey: String, query: String) async throws -> [ShannonVoyagerTaskProjectionDTO]
    func loadVoyagerProjects(scopeKey: String) async throws -> [ShannonVoyagerProjectProjectionDTO]
    func applyOrganizeSession(scopeKey: String, sessionId: String, expectedRevision: Int) async throws -> ShannonOrganizeApplyResponseDTO
}

public protocol ShannonAPIClientProtocol:
    ShannonChatServing,
    ShannonVoiceServing,
    ShannonConversationServing,
    ShannonMemoryServing,
    ShannonInitiativeServing,
    ShannonWorldServing,
    ShannonPushServing,
    ShannonDeliveryServing,
    ShannonAetherServing,
    ShannonAgentTaskServing,
    ShannonOrganizeServing
{}

public extension ShannonAPIClientProtocol {
    func loadOrganizeSessions(scopeKey: String, threadId: String) async throws -> [ShannonOrganizeSessionDTO] { [] }
    func decideOrganizeItem(
        scopeKey: String,
        sessionId: String,
        itemId: String,
        expectedRevision: Int,
        decision: ShannonOrganizeDecisionDTO,
        title: String?,
        details: String?
    ) async throws -> ShannonOrganizeSessionDTO { throw ShannonAPIError.invalidResponse }
    func decideOrganizeItemV2(
        scopeKey: String,
        sessionId: String,
        itemId: String,
        expectedRevision: Int,
        decision: ShannonOrganizeDecisionDTO,
        title: String?,
        details: String?,
        operation: ShannonOrganizeOperationDTO?,
        target: ShannonVoyagerTaskProjectionDTO?,
        projectIds: [String]?
    ) async throws -> ShannonOrganizeSessionDTO {
        guard operation == nil, target == nil, projectIds == nil else { throw ShannonAPIError.invalidResponse }
        return try await decideOrganizeItem(
            scopeKey: scopeKey, sessionId: sessionId, itemId: itemId,
            expectedRevision: expectedRevision, decision: decision,
            title: title, details: details
        )
    }
    func searchVoyagerTasks(scopeKey: String, query: String) async throws -> [ShannonVoyagerTaskProjectionDTO] {
        throw ShannonAPIError.invalidResponse
    }
    func loadVoyagerProjects(scopeKey: String) async throws -> [ShannonVoyagerProjectProjectionDTO] {
        throw ShannonAPIError.invalidResponse
    }
    func applyOrganizeSession(scopeKey: String, sessionId: String, expectedRevision: Int) async throws -> ShannonOrganizeApplyResponseDTO {
        throw ShannonAPIError.invalidResponse
    }
    func send(
        message: String,
        scopeKey: String,
        threadId: String?,
        attachments: [ShannonChatAttachmentDTO]
    ) async throws -> ChatResponseDTO {
        guard attachments.isEmpty else { throw ShannonAPIError.invalidResponse }
        return try await send(message: message, scopeKey: scopeKey, threadId: threadId)
    }

    func send(
        message: String,
        scopeKey: String,
        threadId: String?,
        attachments: [ShannonChatAttachmentDTO],
        webSearch: Bool
    ) async throws -> ChatResponseDTO {
        guard !webSearch else { throw ShannonAPIError.invalidResponse }
        return try await send(
            message: message,
            scopeKey: scopeKey,
            threadId: threadId,
            attachments: attachments
        )
    }

    func transcribeVoice(scopeKey: String, recording: ShannonVoiceRecording) async throws -> ShannonVoiceTranscriptionDTO {
        throw ShannonAPIError.invalidResponse
    }

    func createRealtimeVoiceCall(
        scopeKey: String,
        threadId: String?,
        offerSDP: String
    ) async throws -> ShannonRealtimeVoiceCallDTO {
        throw ShannonAPIError.invalidResponse
    }

    func loadVoiceIdentity(scopeKey: String) async throws -> ShannonVoiceIdentityResponseDTO {
        throw ShannonAPIError.invalidResponse
    }

    func updateVoiceIdentity(
        scopeKey: String,
        mode: ShannonVoiceIdentityModeDTO,
        selectedVoice: String?
    ) async throws -> ShannonVoiceIdentityResponseDTO {
        throw ShannonAPIError.invalidResponse
    }

    func loadVoicePreview(scopeKey: String, voice: String) async throws -> Data {
        throw ShannonAPIError.invalidResponse
    }

    func commitRealtimeVoiceTurn(
        scopeKey: String,
        threadId: String?,
        userTranscript: String,
        shannonTranscript: String
    ) async throws -> ShannonRealtimeVoiceTurnResponseDTO {
        throw ShannonAPIError.invalidResponse
    }

    func loadConversation(scopeKey: String, threadId: String? = nil) async throws -> ConversationHistoryResponseDTO {
        throw ShannonAPIError.invalidResponse
    }

    func loadThreads(scopeKey: String) async throws -> ThreadListResponseDTO {
        throw ShannonAPIError.invalidResponse
    }

    func createThread(scopeKey: String, title: String?) async throws -> String {
        throw ShannonAPIError.invalidResponse
    }

    func renameThread(scopeKey: String, threadId: String, title: String) async throws {
        throw ShannonAPIError.invalidResponse
    }

    func archiveThread(scopeKey: String, threadId: String) async throws {
        throw ShannonAPIError.invalidResponse
    }

    func loadMemories(scopeKey: String) async throws -> ShannonMemoryDashboardDTO {
        throw ShannonAPIError.invalidResponse
    }

    func mutateMemory(
        scopeKey: String,
        memoryID: String,
        action: ShannonMemoryActionDTO,
        text: String? = nil
    ) async throws -> ShannonMemoryDashboardDTO {
        throw ShannonAPIError.invalidResponse
    }

    func correctKnowledge(scopeKey: String, answerId: String, answer: String) async throws -> ShannonMemoryDashboardDTO {
        throw ShannonAPIError.invalidResponse
    }

    func loadInitiatives(scopeKey: String) async throws -> ShannonInitiativeInboxDTO {
        ShannonInitiativeInboxDTO(unreadCount: 0, messages: [])
    }

    func markInitiativesRead(scopeKey: String, threadId: String?) async throws -> Int { 0 }

    func loadWorldSources(scopeKey: String) async throws -> [ShannonWorldSourceDTO] { [] }

    func loadWorldSubscriptions(scopeKey: String) async throws -> [ShannonWorldSubscriptionDTO] { [] }

    func decideWorldSubscription(
        scopeKey: String,
        subscriptionID: String,
        decision: ShannonWorldSubscriptionDecisionDTO,
        expectedUpdatedAt: String
    ) async throws -> ShannonWorldSubscriptionDTO {
        throw ShannonAPIError.invalidResponse
    }

    func registerPushToken(
        scopeKey: String,
        deviceToken: String,
        environment: ShannonPushEnvironmentDTO
    ) async throws {}

    func loadTestFlightDelivery(scopeKey: String) async throws -> ShannonTestFlightDeliveryDashboardDTO {
        throw ShannonAPIError.invalidResponse
    }

    func confirmTestFlightReleaseGate(
        scopeKey: String,
        buildVersion: String,
        gate: ShannonReleaseGateKeyDTO
    ) async throws -> ShannonTestFlightDeliveryDashboardDTO {
        throw ShannonAPIError.invalidResponse
    }

    func createAetherProposal(scopeKey: String, title: String, content: String, reason: String) async throws -> AetherProposalResponseDTO {
        throw ShannonAPIError.invalidResponse
    }

    func createAgentTask(scopeKey: String, task: ShannonAgentTask, idempotencyKey: String) async throws -> ShannonAgentTask {
        throw ShannonAPIError.invalidResponse
    }

    func loadAgentWorkspace(scopeKey: String, projectHint: String? = nil) async throws -> ShannonAgentWorkspaceCatalogDTO {
        .unavailable
    }

    func loadAgentTasks(scopeKey: String) async throws -> [ShannonAgentTask] { [] }

    func loadAgentTask(scopeKey: String, taskID: UUID, afterSequence: Int? = nil) async throws -> ShannonAgentTask? { nil }

    func sendAgentTaskCommand(
        scopeKey: String,
        taskID: UUID,
        type: String,
        payload: [String: String] = [:],
        idempotencyKey: String
    ) async throws -> ShannonAgentTask {
        throw ShannonAPIError.invalidResponse
    }

    func updateAgentTaskMetadata(
        scopeKey: String,
        taskID: UUID,
        isPinned: Bool? = nil,
        isArchived: Bool? = nil
    ) async throws -> ShannonAgentTask {
        throw ShannonAPIError.invalidResponse
    }

    func loadAgentProjectProvisioning(scopeKey: String) async throws -> [ShannonAgentProjectProvisioningDTO] { [] }

    func createAgentProjectProvisioning(
        scopeKey: String,
        repositoryURL: String,
        projectKey: String,
        hostPreference: ShannonAgentRoutingPreference,
        idempotencyKey: String
    ) async throws -> [ShannonAgentProjectProvisioningDTO] {
        throw ShannonAPIError.invalidResponse
    }
}
