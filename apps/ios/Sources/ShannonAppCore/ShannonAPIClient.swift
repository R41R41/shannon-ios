import Foundation

public protocol ShannonAPIClientProtocol: Sendable {
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
    func loadConversation(scopeKey: String, threadId: String?) async throws -> ConversationHistoryResponseDTO
    func loadThreads(scopeKey: String) async throws -> ThreadListResponseDTO
    func createThread(scopeKey: String, title: String?) async throws -> String
    func renameThread(scopeKey: String, threadId: String, title: String) async throws
    func archiveThread(scopeKey: String, threadId: String) async throws
    func loadMemories(scopeKey: String) async throws -> ShannonMemoryDashboardDTO
    func mutateMemory(
        scopeKey: String,
        memoryID: String,
        action: ShannonMemoryActionDTO,
        text: String?
    ) async throws -> ShannonMemoryDashboardDTO
    func correctKnowledge(scopeKey: String, answerId: String, answer: String) async throws -> ShannonMemoryDashboardDTO
    func loadInitiatives(scopeKey: String) async throws -> ShannonInitiativeInboxDTO
    func markInitiativesRead(scopeKey: String, threadId: String?) async throws -> Int
    func loadWorldSources(scopeKey: String) async throws -> [ShannonWorldSourceDTO]
    func loadWorldSubscriptions(scopeKey: String) async throws -> [ShannonWorldSubscriptionDTO]
    func decideWorldSubscription(
        scopeKey: String,
        subscriptionID: String,
        decision: ShannonWorldSubscriptionDecisionDTO,
        expectedUpdatedAt: String
    ) async throws -> ShannonWorldSubscriptionDTO
    func registerPushToken(
        scopeKey: String,
        deviceToken: String,
        environment: ShannonPushEnvironmentDTO
    ) async throws
    func loadTestFlightDelivery(scopeKey: String) async throws -> ShannonTestFlightDeliveryDashboardDTO
    func createAetherProposal(scopeKey: String, title: String, content: String, reason: String) async throws -> AetherProposalResponseDTO
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

    func createAetherProposal(scopeKey: String, title: String, content: String, reason: String) async throws -> AetherProposalResponseDTO {
        throw ShannonAPIError.invalidResponse
    }

    func createAgentTask(scopeKey: String, task: ShannonAgentTask, idempotencyKey: String) async throws -> ShannonAgentTask {
        throw ShannonAPIError.invalidResponse
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
}

public enum ShannonAPIError: Error, Equatable {
    case invalidResponse
    case rejected(status: Int)
    case realtimeVoiceRejected(status: Int, code: String?)
}

private struct ShannonRealtimeVoiceErrorDTO: Decodable {
    let error: String?
}

public struct ShannonAPIClient: ShannonAPIClientProtocol, Sendable {
    public let baseURL: URL
    private let apiToken: String?
    private let connectionStore: (any ShannonConnectionStoreProtocol)?
    private let session: URLSession

    public init(
        baseURL: URL = URL(string: "http://127.0.0.1:4317")!,
        apiToken: String? = nil,
        connectionStore: (any ShannonConnectionStoreProtocol)? = nil,
        session: URLSession = .shared
    ) {
        self.baseURL = baseURL
        self.apiToken = apiToken
        self.connectionStore = connectionStore
        self.session = session
    }

    public func send(message: String, scopeKey: String, threadId: String? = nil) async throws -> ChatResponseDTO {
        try await send(message: message, scopeKey: scopeKey, threadId: threadId, attachments: [], webSearch: false)
    }

    public func send(
        message: String,
        scopeKey: String,
        threadId: String? = nil,
        attachments: [ShannonChatAttachmentDTO]
    ) async throws -> ChatResponseDTO {
        try await send(
            message: message,
            scopeKey: scopeKey,
            threadId: threadId,
            attachments: attachments,
            webSearch: false
        )
    }

    public func send(
        message: String,
        scopeKey: String,
        threadId: String? = nil,
        attachments: [ShannonChatAttachmentDTO],
        webSearch: Bool
    ) async throws -> ChatResponseDTO {
        let connection = currentConnection()
        var request = URLRequest(url: baseURL.appending(path: "/v1/chat"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        authorize(&request, connection: connection)
        request.httpBody = try JSONEncoder().encode(ChatRequestDTO(
            scopeKey: connection?.scopeKey ?? scopeKey,
            message: message,
            threadId: threadId,
            attachments: attachments,
            webSearch: webSearch
        ))

        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw ShannonAPIError.invalidResponse }
        guard (200..<300).contains(http.statusCode) else { throw ShannonAPIError.rejected(status: http.statusCode) }
        return try JSONDecoder().decode(ChatResponseDTO.self, from: data)
    }

    public func transcribeVoice(
        scopeKey: String,
        recording: ShannonVoiceRecording
    ) async throws -> ShannonVoiceTranscriptionDTO {
        let connection = currentConnection()
        var request = URLRequest(url: baseURL.appending(path: "/v1/voice/transcriptions"))
        request.httpMethod = "POST"
        request.timeoutInterval = 75
        request.setValue(recording.mimeType, forHTTPHeaderField: "content-type")
        request.setValue(String(recording.durationMilliseconds), forHTTPHeaderField: "x-shannon-audio-duration-ms")
        authorize(&request, connection: connection)
        let (data, response) = try await session.upload(for: request, fromFile: recording.fileURL)
        guard let http = response as? HTTPURLResponse else { throw ShannonAPIError.invalidResponse }
        guard (200..<300).contains(http.statusCode) else { throw ShannonAPIError.rejected(status: http.statusCode) }
        return try JSONDecoder().decode(ShannonVoiceTranscriptionDTO.self, from: data)
    }

    public func createRealtimeVoiceCall(
        scopeKey: String,
        threadId: String?,
        offerSDP: String
    ) async throws -> ShannonRealtimeVoiceCallDTO {
        let connection = currentConnection()
        var request = URLRequest(url: baseURL.appending(path: "/v1/voice/realtime/calls"))
        request.httpMethod = "POST"
        request.timeoutInterval = 40
        request.setValue("application/sdp", forHTTPHeaderField: "content-type")
        if let threadId, !threadId.isEmpty {
            request.setValue(threadId, forHTTPHeaderField: "x-shannon-thread-id")
        }
        authorize(&request, connection: connection)
        request.httpBody = Data(offerSDP.utf8)
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw ShannonAPIError.invalidResponse }
        guard (200..<300).contains(http.statusCode) else {
            let payload = try? JSONDecoder().decode(ShannonRealtimeVoiceErrorDTO.self, from: data)
            throw ShannonAPIError.realtimeVoiceRejected(
                status: http.statusCode,
                code: payload?.error
            )
        }
        guard let answerSDP = String(data: data, encoding: .utf8), answerSDP.hasPrefix("v=0") else {
            throw ShannonAPIError.invalidResponse
        }
        let resolvedThreadID = http.value(forHTTPHeaderField: "x-shannon-thread-id") ?? threadId ?? ""
        guard !resolvedThreadID.isEmpty else { throw ShannonAPIError.invalidResponse }
        return ShannonRealtimeVoiceCallDTO(
            answerSDP: answerSDP,
            threadID: resolvedThreadID,
            model: http.value(forHTTPHeaderField: "x-shannon-realtime-model"),
            callID: http.value(forHTTPHeaderField: "x-shannon-realtime-call-id"),
            dailyRemainingSeconds: http.value(
                forHTTPHeaderField: "x-shannon-realtime-daily-remaining-seconds"
            ).flatMap(Int.init)
        )
    }

    public func loadVoiceIdentity(scopeKey: String) async throws -> ShannonVoiceIdentityResponseDTO {
        let connection = currentConnection()
        var components = URLComponents(
            url: baseURL.appending(path: "/v1/voice/identity"),
            resolvingAgainstBaseURL: false
        )
        components?.queryItems = [
            URLQueryItem(name: "scopeKey", value: connection?.scopeKey ?? scopeKey),
        ]
        guard let url = components?.url else { throw ShannonAPIError.invalidResponse }
        var request = URLRequest(url: url)
        authorize(&request, connection: connection)
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw ShannonAPIError.invalidResponse }
        guard (200..<300).contains(http.statusCode) else { throw ShannonAPIError.rejected(status: http.statusCode) }
        return try JSONDecoder().decode(ShannonVoiceIdentityResponseDTO.self, from: data)
    }

    public func updateVoiceIdentity(
        scopeKey: String,
        mode: ShannonVoiceIdentityModeDTO,
        selectedVoice: String?
    ) async throws -> ShannonVoiceIdentityResponseDTO {
        let connection = currentConnection()
        var request = URLRequest(url: baseURL.appending(path: "/v1/voice/identity"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        authorize(&request, connection: connection)
        request.httpBody = try JSONEncoder().encode(ShannonVoiceIdentityUpdateRequestDTO(
            scopeKey: connection?.scopeKey ?? scopeKey,
            mode: mode,
            selectedVoice: selectedVoice
        ))
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw ShannonAPIError.invalidResponse }
        guard (200..<300).contains(http.statusCode) else { throw ShannonAPIError.rejected(status: http.statusCode) }
        return try JSONDecoder().decode(ShannonVoiceIdentityResponseDTO.self, from: data)
    }

    public func loadVoicePreview(scopeKey: String, voice: String) async throws -> Data {
        let connection = currentConnection()
        var request = URLRequest(url: baseURL.appending(path: "/v1/voice/identity/preview"))
        request.httpMethod = "POST"
        request.timeoutInterval = 40
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        authorize(&request, connection: connection)
        request.httpBody = try JSONEncoder().encode(ShannonVoicePreviewRequestDTO(voice: voice))
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw ShannonAPIError.invalidResponse }
        guard (200..<300).contains(http.statusCode), http.mimeType == "audio/mpeg", !data.isEmpty else {
            throw ShannonAPIError.rejected(status: http.statusCode)
        }
        return data
    }

    public func commitRealtimeVoiceTurn(
        scopeKey: String,
        threadId: String?,
        userTranscript: String,
        shannonTranscript: String
    ) async throws -> ShannonRealtimeVoiceTurnResponseDTO {
        let connection = currentConnection()
        var request = URLRequest(url: baseURL.appending(path: "/v1/voice/realtime/turns"))
        request.httpMethod = "POST"
        request.timeoutInterval = 20
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        authorize(&request, connection: connection)
        request.httpBody = try JSONEncoder().encode(ShannonRealtimeVoiceTurnRequestDTO(
            scopeKey: connection?.scopeKey ?? scopeKey,
            threadId: threadId,
            userTranscript: userTranscript,
            shannonTranscript: shannonTranscript
        ))
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw ShannonAPIError.invalidResponse }
        guard (200..<300).contains(http.statusCode) else { throw ShannonAPIError.rejected(status: http.statusCode) }
        return try JSONDecoder().decode(ShannonRealtimeVoiceTurnResponseDTO.self, from: data)
    }

    public func loadConversation(scopeKey: String, threadId: String? = nil) async throws -> ConversationHistoryResponseDTO {
        let connection = currentConnection()
        var components = URLComponents(
            url: baseURL.appending(path: "/v1/conversation"),
            resolvingAgainstBaseURL: false
        )
        components?.queryItems = [
            URLQueryItem(name: "scopeKey", value: connection?.scopeKey ?? scopeKey),
        ]
        if let threadId, !threadId.isEmpty {
            components?.queryItems?.append(URLQueryItem(name: "threadId", value: threadId))
        }
        guard let url = components?.url else { throw ShannonAPIError.invalidResponse }

        var request = URLRequest(url: url)
        authorize(&request, connection: connection)
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw ShannonAPIError.invalidResponse }
        guard (200..<300).contains(http.statusCode) else { throw ShannonAPIError.rejected(status: http.statusCode) }
        return try JSONDecoder().decode(ConversationHistoryResponseDTO.self, from: data)
    }

    public func loadThreads(scopeKey: String) async throws -> ThreadListResponseDTO {
        let connection = currentConnection()
        var components = URLComponents(
            url: baseURL.appending(path: "/v1/threads"),
            resolvingAgainstBaseURL: false
        )
        components?.queryItems = [URLQueryItem(name: "scopeKey", value: connection?.scopeKey ?? scopeKey)]
        guard let url = components?.url else { throw ShannonAPIError.invalidResponse }

        var request = URLRequest(url: url)
        authorize(&request, connection: connection)
        return try await response(ThreadListResponseDTO.self, for: request)
    }

    public func createThread(scopeKey: String, title: String?) async throws -> String {
        let connection = currentConnection()
        var request = URLRequest(url: baseURL.appending(path: "/v1/threads"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        authorize(&request, connection: connection)
        request.httpBody = try JSONEncoder().encode(ThreadCreateRequestDTO(
            scopeKey: connection?.scopeKey ?? scopeKey,
            title: title
        ))
        let responseBody: ThreadCreateResponseDTO = try await response(ThreadCreateResponseDTO.self, for: request)
        return responseBody.threadId
    }

    public func archiveThread(scopeKey: String, threadId: String) async throws {
        let connection = currentConnection()
        var request = URLRequest(url: baseURL.appending(path: "/v1/threads/archive"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        authorize(&request, connection: connection)
        request.httpBody = try JSONEncoder().encode(ThreadArchiveRequestDTO(
            scopeKey: connection?.scopeKey ?? scopeKey,
            threadId: threadId
        ))
        let result: ThreadArchiveResponseDTO = try await response(ThreadArchiveResponseDTO.self, for: request)
        guard result.archived else { throw ShannonAPIError.invalidResponse }
    }

    public func renameThread(scopeKey: String, threadId: String, title: String) async throws {
        let connection = currentConnection()
        var request = URLRequest(url: baseURL.appending(path: "/v1/threads/title"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        authorize(&request, connection: connection)
        request.httpBody = try JSONEncoder().encode(ThreadRenameRequestDTO(
            scopeKey: connection?.scopeKey ?? scopeKey,
            threadId: threadId,
            title: title
        ))
        let result: ThreadRenameResponseDTO = try await response(ThreadRenameResponseDTO.self, for: request)
        guard result.renamed else { throw ShannonAPIError.invalidResponse }
    }

    public func loadMemories(scopeKey: String) async throws -> ShannonMemoryDashboardDTO {
        let connection = currentConnection()
        var components = URLComponents(url: baseURL.appending(path: "/v1/memories"), resolvingAgainstBaseURL: false)
        components?.queryItems = [URLQueryItem(name: "scopeKey", value: connection?.scopeKey ?? scopeKey)]
        guard let url = components?.url else { throw ShannonAPIError.invalidResponse }
        var request = URLRequest(url: url)
        authorize(&request, connection: connection)
        return try await response(ShannonMemoryDashboardDTO.self, for: request)
    }

    public func mutateMemory(
        scopeKey: String,
        memoryID: String,
        action: ShannonMemoryActionDTO,
        text: String? = nil
    ) async throws -> ShannonMemoryDashboardDTO {
        let connection = currentConnection()
        var request = URLRequest(url: baseURL.appending(path: "/v1/memories/action"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        authorize(&request, connection: connection)
        request.httpBody = try JSONEncoder().encode(ShannonMemoryMutationDTO(
            scopeKey: connection?.scopeKey ?? scopeKey,
            memoryId: memoryID,
            action: action,
            text: text
        ))
        return try await response(ShannonMemoryDashboardDTO.self, for: request)
    }

    public func correctKnowledge(scopeKey: String, answerId: String, answer: String) async throws -> ShannonMemoryDashboardDTO {
        let connection = currentConnection()
        var request = URLRequest(url: baseURL.appending(path: "/v1/knowledge/correct"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        authorize(&request, connection: connection)
        request.httpBody = try JSONEncoder().encode(ShannonKnowledgeCorrectionDTO(
            scopeKey: connection?.scopeKey ?? scopeKey,
            answerId: answerId,
            answer: answer
        ))
        return try await response(ShannonMemoryDashboardDTO.self, for: request)
    }

    public func loadInitiatives(scopeKey: String) async throws -> ShannonInitiativeInboxDTO {
        let connection = currentConnection()
        var components = URLComponents(url: baseURL.appending(path: "/v1/initiatives"), resolvingAgainstBaseURL: false)
        components?.queryItems = [URLQueryItem(name: "scopeKey", value: connection?.scopeKey ?? scopeKey)]
        guard let url = components?.url else { throw ShannonAPIError.invalidResponse }
        var request = URLRequest(url: url)
        authorize(&request, connection: connection)
        return try await response(ShannonInitiativeInboxDTO.self, for: request)
    }

    public func markInitiativesRead(scopeKey: String, threadId: String?) async throws -> Int {
        let connection = currentConnection()
        var request = URLRequest(url: baseURL.appending(path: "/v1/initiatives/read"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        authorize(&request, connection: connection)
        request.httpBody = try JSONEncoder().encode(ShannonInitiativeReadRequestDTO(
            scopeKey: connection?.scopeKey ?? scopeKey,
            threadId: threadId
        ))
        let result: ShannonInitiativeReadResponseDTO = try await response(ShannonInitiativeReadResponseDTO.self, for: request)
        return result.markedRead
    }

    public func loadWorldSubscriptions(scopeKey: String) async throws -> [ShannonWorldSubscriptionDTO] {
        let connection = currentConnection()
        var components = URLComponents(
            url: baseURL.appending(path: "/v1/world/subscriptions"),
            resolvingAgainstBaseURL: false
        )
        components?.queryItems = [
            URLQueryItem(name: "scopeKey", value: connection?.scopeKey ?? scopeKey),
        ]
        guard let url = components?.url else { throw ShannonAPIError.invalidResponse }
        var request = URLRequest(url: url)
        authorize(&request, connection: connection)
        return try await response(ShannonWorldSubscriptionListDTO.self, for: request).subscriptions
    }

    public func loadWorldSources(scopeKey: String) async throws -> [ShannonWorldSourceDTO] {
        let connection = currentConnection()
        var components = URLComponents(
            url: baseURL.appending(path: "/v1/world/sources"),
            resolvingAgainstBaseURL: false
        )
        components?.queryItems = [
            URLQueryItem(name: "scopeKey", value: connection?.scopeKey ?? scopeKey),
        ]
        guard let url = components?.url else { throw ShannonAPIError.invalidResponse }
        var request = URLRequest(url: url)
        authorize(&request, connection: connection)
        return try await response(ShannonWorldSourceListDTO.self, for: request).sources
    }

    public func decideWorldSubscription(
        scopeKey: String,
        subscriptionID: String,
        decision: ShannonWorldSubscriptionDecisionDTO,
        expectedUpdatedAt: String
    ) async throws -> ShannonWorldSubscriptionDTO {
        let connection = currentConnection()
        let encodedID = subscriptionID.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed)
            ?? subscriptionID
        var request = URLRequest(
            url: baseURL.appending(path: "/v1/world/subscriptions/\(encodedID)/decision")
        )
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        authorize(&request, connection: connection)
        request.httpBody = try JSONEncoder().encode(ShannonWorldSubscriptionDecisionRequestDTO(
            scopeKey: connection?.scopeKey ?? scopeKey,
            decision: decision,
            expectedUpdatedAt: expectedUpdatedAt
        ))
        return try await response(ShannonWorldSubscriptionDTO.self, for: request)
    }

    public func registerPushToken(
        scopeKey: String,
        deviceToken: String,
        environment: ShannonPushEnvironmentDTO
    ) async throws {
        let connection = currentConnection()
        var request = URLRequest(url: baseURL.appending(path: "/v1/push/register"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        authorize(&request, connection: connection)
        request.httpBody = try JSONEncoder().encode(ShannonPushRegistrationRequestDTO(
            deviceToken: deviceToken,
            environment: environment
        ))
        let result: ShannonPushRegistrationResponseDTO = try await response(
            ShannonPushRegistrationResponseDTO.self,
            for: request
        )
        guard result.registered else { throw ShannonAPIError.invalidResponse }
    }

    public func loadTestFlightDelivery(scopeKey: String) async throws -> ShannonTestFlightDeliveryDashboardDTO {
        let connection = currentConnection()
        var components = URLComponents(
            url: baseURL.appending(path: "/v1/testflight/delivery"),
            resolvingAgainstBaseURL: false
        )
        components?.queryItems = [URLQueryItem(name: "scopeKey", value: connection?.scopeKey ?? scopeKey)]
        guard let url = components?.url else { throw ShannonAPIError.invalidResponse }
        var request = URLRequest(url: url)
        authorize(&request, connection: connection)
        return try await response(ShannonTestFlightDeliveryDashboardDTO.self, for: request)
    }

    public func createAetherProposal(scopeKey: String, title: String, content: String, reason: String) async throws -> AetherProposalResponseDTO {
        let connection = currentConnection()
        var request = URLRequest(url: baseURL.appending(path: "/v1/aether/proposals"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        authorize(&request, connection: connection)
        request.httpBody = try JSONEncoder().encode(AetherProposalRequestDTO(
            scopeKey: connection?.scopeKey ?? scopeKey,
            title: title,
            content: content,
            reason: reason
        ))
        return try await response(AetherProposalResponseDTO.self, for: request)
    }

    public func createAgentTask(
        scopeKey: String,
        task: ShannonAgentTask,
        idempotencyKey: String
    ) async throws -> ShannonAgentTask {
        let connection = currentConnection()
        var request = URLRequest(url: baseURL.appending(path: "/v1/agent/tasks"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        authorize(&request, connection: connection)
        request.httpBody = try JSONEncoder().encode(ShannonAgentTaskCreateRequestDTO(
            scopeKey: connection?.scopeKey ?? scopeKey,
            taskId: task.id.uuidString,
            idempotencyKey: idempotencyKey,
            conversationThreadID: task.conversationThreadID,
            sourceMessageID: task.sourceMessageID?.uuidString,
            title: task.title,
            goal: task.goal,
            summary: task.summary,
            plan: task.plan,
            hostHint: task.hostHint,
            projectHint: task.projectHint
        ))
        let envelope: ShannonAgentTaskEnvelopeDTO = try await response(ShannonAgentTaskEnvelopeDTO.self, for: request)
        return try ShannonAgentTask(remote: envelope.task)
    }

    public func loadAgentTasks(scopeKey: String) async throws -> [ShannonAgentTask] {
        let connection = currentConnection()
        var components = URLComponents(url: baseURL.appending(path: "/v1/agent/tasks"), resolvingAgainstBaseURL: false)
        components?.queryItems = [URLQueryItem(name: "scopeKey", value: connection?.scopeKey ?? scopeKey)]
        guard let url = components?.url else { throw ShannonAPIError.invalidResponse }
        var request = URLRequest(url: url)
        authorize(&request, connection: connection)
        let result: ShannonAgentTaskListDTO = try await response(ShannonAgentTaskListDTO.self, for: request)
        return try result.tasks.map(ShannonAgentTask.init(remote:))
    }

    public func loadAgentTask(
        scopeKey: String,
        taskID: UUID,
        afterSequence: Int? = nil
    ) async throws -> ShannonAgentTask? {
        let connection = currentConnection()
        var components = URLComponents(
            url: baseURL.appending(path: "/v1/agent/tasks/\(taskID.uuidString)"),
            resolvingAgainstBaseURL: false
        )
        components?.queryItems = [URLQueryItem(name: "scopeKey", value: connection?.scopeKey ?? scopeKey)]
        if let afterSequence {
            components?.queryItems?.append(URLQueryItem(name: "afterSequence", value: String(afterSequence)))
        }
        guard let url = components?.url else { throw ShannonAPIError.invalidResponse }
        var request = URLRequest(url: url)
        authorize(&request, connection: connection)
        let (data, urlResponse) = try await session.data(for: request)
        guard let http = urlResponse as? HTTPURLResponse else { throw ShannonAPIError.invalidResponse }
        if http.statusCode == 304 { return nil }
        guard (200..<300).contains(http.statusCode) else { throw ShannonAPIError.rejected(status: http.statusCode) }
        let envelope = try JSONDecoder().decode(ShannonAgentTaskEnvelopeDTO.self, from: data)
        return try ShannonAgentTask(remote: envelope.task)
    }

    public func sendAgentTaskCommand(
        scopeKey: String,
        taskID: UUID,
        type: String,
        payload: [String: String] = [:],
        idempotencyKey: String
    ) async throws -> ShannonAgentTask {
        let connection = currentConnection()
        var request = URLRequest(url: baseURL.appending(path: "/v1/agent/tasks/\(taskID.uuidString)/commands"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        authorize(&request, connection: connection)
        request.httpBody = try JSONEncoder().encode(ShannonAgentTaskCommandRequestDTO(
            scopeKey: connection?.scopeKey ?? scopeKey,
            idempotencyKey: idempotencyKey,
            type: type,
            payload: payload
        ))
        let envelope: ShannonAgentTaskEnvelopeDTO = try await response(ShannonAgentTaskEnvelopeDTO.self, for: request)
        return try ShannonAgentTask(remote: envelope.task)
    }

    public func loadOrganizeSessions(scopeKey: String, threadId: String) async throws -> [ShannonOrganizeSessionDTO] {
        let connection = currentConnection()
        var components = URLComponents(url: baseURL.appending(path: "/v1/organize/sessions"), resolvingAgainstBaseURL: false)
        components?.queryItems = [
            URLQueryItem(name: "scopeKey", value: connection?.scopeKey ?? scopeKey),
            URLQueryItem(name: "threadId", value: threadId),
        ]
        guard let url = components?.url else { throw ShannonAPIError.invalidResponse }
        var request = URLRequest(url: url)
        authorize(&request, connection: connection)
        return try await response(ShannonOrganizeSessionListDTO.self, for: request).sessions
    }

    public func decideOrganizeItem(
        scopeKey: String,
        sessionId: String,
        itemId: String,
        expectedRevision: Int,
        decision: ShannonOrganizeDecisionDTO,
        title: String? = nil,
        details: String? = nil
    ) async throws -> ShannonOrganizeSessionDTO {
        try await decideOrganizeItemV2(
            scopeKey: scopeKey, sessionId: sessionId, itemId: itemId,
            expectedRevision: expectedRevision, decision: decision,
            title: title, details: details, operation: nil, target: nil, projectIds: nil
        )
    }

    public func decideOrganizeItemV2(
        scopeKey: String,
        sessionId: String,
        itemId: String,
        expectedRevision: Int,
        decision: ShannonOrganizeDecisionDTO,
        title: String? = nil,
        details: String? = nil,
        operation: ShannonOrganizeOperationDTO? = nil,
        target: ShannonVoyagerTaskProjectionDTO? = nil,
        projectIds: [String]? = nil
    ) async throws -> ShannonOrganizeSessionDTO {
        let connection = currentConnection()
        var request = URLRequest(url: baseURL.appending(path: "/v1/organize/sessions/\(sessionId)/items/\(itemId)/decision"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        authorize(&request, connection: connection)
        request.httpBody = try JSONEncoder().encode(ShannonOrganizeDecisionRequestDTO(
            scopeKey: connection?.scopeKey ?? scopeKey,
            expectedRevision: expectedRevision,
            decision: decision,
            title: title,
            details: details,
            operation: operation,
            target: target,
            projectIds: projectIds
        ))
        return try await response(ShannonOrganizeSessionEnvelopeDTO.self, for: request).session
    }

    public func searchVoyagerTasks(scopeKey: String, query: String) async throws -> [ShannonVoyagerTaskProjectionDTO] {
        let connection = currentConnection()
        var components = URLComponents(url: baseURL.appending(path: "/v1/integrations/voyager/tasks"), resolvingAgainstBaseURL: false)
        components?.queryItems = [
            URLQueryItem(name: "scopeKey", value: connection?.scopeKey ?? scopeKey),
            URLQueryItem(name: "query", value: query),
            URLQueryItem(name: "limit", value: "8"),
        ]
        guard let url = components?.url else { throw ShannonAPIError.invalidResponse }
        var request = URLRequest(url: url)
        authorize(&request, connection: connection)
        return try await response(ShannonVoyagerTaskProjectionListDTO.self, for: request).items
    }

    public func loadVoyagerProjects(scopeKey: String) async throws -> [ShannonVoyagerProjectProjectionDTO] {
        let connection = currentConnection()
        var components = URLComponents(url: baseURL.appending(path: "/v1/integrations/voyager/projects"), resolvingAgainstBaseURL: false)
        components?.queryItems = [
            URLQueryItem(name: "scopeKey", value: connection?.scopeKey ?? scopeKey),
            URLQueryItem(name: "limit", value: "20"),
        ]
        guard let url = components?.url else { throw ShannonAPIError.invalidResponse }
        var request = URLRequest(url: url)
        authorize(&request, connection: connection)
        return try await response(ShannonVoyagerProjectProjectionListDTO.self, for: request).items
    }

    public func applyOrganizeSession(
        scopeKey: String,
        sessionId: String,
        expectedRevision: Int
    ) async throws -> ShannonOrganizeApplyResponseDTO {
        let connection = currentConnection()
        var request = URLRequest(url: baseURL.appending(path: "/v1/organize/sessions/\(sessionId)/apply"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        authorize(&request, connection: connection)
        request.httpBody = try JSONEncoder().encode(ShannonOrganizeApplyRequestDTO(
            scopeKey: connection?.scopeKey ?? scopeKey,
            expectedRevision: expectedRevision
        ))
        return try await response(ShannonOrganizeApplyResponseDTO.self, for: request)
    }

    private func currentConnection() -> ShannonConnectionCredential? {
        guard let credential = try? connectionStore?.load(),
              credential.baseURL == baseURL,
              credential.expiresAt > Date() else { return nil }
        return credential
    }

    private func authorize(_ request: inout URLRequest, connection: ShannonConnectionCredential?) {
        if let connection {
            request.setValue("Bearer \(connection.token)", forHTTPHeaderField: "authorization")
            return
        }
        guard let apiToken, !apiToken.isEmpty, !apiToken.contains("$(") else { return }
        request.setValue("Bearer \(apiToken)", forHTTPHeaderField: "authorization")
    }

    private func response<Response: Decodable>(_ type: Response.Type, for request: URLRequest) async throws -> Response {
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw ShannonAPIError.invalidResponse }
        guard (200..<300).contains(http.statusCode) else { throw ShannonAPIError.rejected(status: http.statusCode) }
        return try JSONDecoder().decode(type, from: data)
    }
}
