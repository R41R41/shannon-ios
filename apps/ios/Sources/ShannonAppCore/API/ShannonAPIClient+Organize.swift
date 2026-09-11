import Foundation

extension ShannonAPIClient {
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
}
