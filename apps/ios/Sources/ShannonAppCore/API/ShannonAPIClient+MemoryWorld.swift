import Foundation

extension ShannonAPIClient {
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
}
