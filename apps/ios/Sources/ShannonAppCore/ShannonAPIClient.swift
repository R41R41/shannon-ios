import Foundation

public protocol ShannonAPIClientProtocol: Sendable {
    func send(message: String, scopeKey: String, threadId: String?) async throws -> ChatResponseDTO
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
    func markInitiativesRead(scopeKey: String) async throws -> Int
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
}

public extension ShannonAPIClientProtocol {
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

    func markInitiativesRead(scopeKey: String) async throws -> Int { 0 }

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
        let connection = currentConnection()
        var request = URLRequest(url: baseURL.appending(path: "/v1/chat"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        authorize(&request, connection: connection)
        request.httpBody = try JSONEncoder().encode(ChatRequestDTO(
            scopeKey: connection?.scopeKey ?? scopeKey,
            message: message,
            threadId: threadId
        ))

        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw ShannonAPIError.invalidResponse }
        guard (200..<300).contains(http.statusCode) else { throw ShannonAPIError.rejected(status: http.statusCode) }
        return try JSONDecoder().decode(ChatResponseDTO.self, from: data)
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

    public func markInitiativesRead(scopeKey: String) async throws -> Int {
        let connection = currentConnection()
        var request = URLRequest(url: baseURL.appending(path: "/v1/initiatives/read"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        authorize(&request, connection: connection)
        request.httpBody = try JSONEncoder().encode(ShannonInitiativeReadRequestDTO(
            scopeKey: connection?.scopeKey ?? scopeKey
        ))
        let result: ShannonInitiativeReadResponseDTO = try await response(ShannonInitiativeReadResponseDTO.self, for: request)
        return result.markedRead
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
