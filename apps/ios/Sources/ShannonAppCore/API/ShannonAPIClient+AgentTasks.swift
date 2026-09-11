import Foundation

extension ShannonAPIClient {
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
}
