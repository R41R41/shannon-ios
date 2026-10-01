import Foundation

/// Owner-side access to bounded autonomy. There is no call that acts as Shannon.
public protocol ShannonAutonomyServing: Sendable {
    func loadAutonomy(scopeKey: String) async throws -> ShannonAutonomyOverviewDTO
    func loadAutonomyActivity(scopeKey: String, days: Int) async throws -> ShannonAutonomyActivityDTO
    func setAutonomyPaused(scopeKey: String, paused: Bool) async throws -> ShannonAutonomyOverviewDTO
    func decideAutonomyBudgetRequest(
        scopeKey: String,
        requestID: String,
        approve: Bool,
        amountYen: Double?
    ) async throws -> ShannonAutonomyOverviewDTO
    func setShannonPursuitStatus(scopeKey: String, pursuitID: String, status: String) async throws -> ShannonAutonomyOverviewDTO
    func decideShannonProposal(scopeKey: String, proposalID: String, start: Bool) async throws -> ShannonAutonomyOverviewDTO
}

extension ShannonAPIClient: ShannonAutonomyServing {
    public func loadAutonomy(scopeKey: String) async throws -> ShannonAutonomyOverviewDTO {
        try await response(ShannonAutonomyOverviewDTO.self, for: autonomyGet("/v1/autonomy", scopeKey: scopeKey))
    }

    public func loadAutonomyActivity(scopeKey: String, days: Int) async throws -> ShannonAutonomyActivityDTO {
        try await response(
            ShannonAutonomyActivityDTO.self,
            for: autonomyGet("/v1/autonomy/activity", scopeKey: scopeKey, extra: [URLQueryItem(name: "days", value: String(days))])
        )
    }

    public func setAutonomyPaused(scopeKey: String, paused: Bool) async throws -> ShannonAutonomyOverviewDTO {
        let connection = currentConnection()
        return try await response(ShannonAutonomyOverviewDTO.self, for: autonomyPost(
            "/v1/autonomy/pause",
            body: ShannonAutonomyPauseRequestDTO(scopeKey: connection?.scopeKey ?? scopeKey, paused: paused),
            connection: connection
        ))
    }

    public func decideAutonomyBudgetRequest(
        scopeKey: String,
        requestID: String,
        approve: Bool,
        amountYen: Double?
    ) async throws -> ShannonAutonomyOverviewDTO {
        let connection = currentConnection()
        return try await response(ShannonAutonomyOverviewDTO.self, for: autonomyPost(
            "/v1/autonomy/budget-requests/\(try Self.pathComponent(requestID))/decision",
            body: ShannonAutonomyBudgetDecisionRequestDTO(
                scopeKey: connection?.scopeKey ?? scopeKey,
                decision: approve ? "approve" : "decline",
                amountYen: approve ? amountYen : nil
            ),
            connection: connection
        ))
    }

    public func setShannonPursuitStatus(scopeKey: String, pursuitID: String, status: String) async throws -> ShannonAutonomyOverviewDTO {
        let connection = currentConnection()
        return try await response(ShannonAutonomyOverviewDTO.self, for: autonomyPost(
            "/v1/autonomy/pursuits/\(try Self.pathComponent(pursuitID))/status",
            body: ShannonAutonomyStatusRequestDTO(scopeKey: connection?.scopeKey ?? scopeKey, status: status),
            connection: connection
        ))
    }

    public func decideShannonProposal(scopeKey: String, proposalID: String, start: Bool) async throws -> ShannonAutonomyOverviewDTO {
        let connection = currentConnection()
        return try await response(ShannonAutonomyOverviewDTO.self, for: autonomyPost(
            "/v1/autonomy/proposals/\(try Self.pathComponent(proposalID))/decision",
            body: ShannonAutonomyDecisionRequestDTO(scopeKey: connection?.scopeKey ?? scopeKey, decision: start ? "start" : "decline"),
            connection: connection
        ))
    }

    func autonomyGet(_ path: String, scopeKey: String, extra: [URLQueryItem] = []) throws -> URLRequest {
        let connection = currentConnection()
        var components = URLComponents(url: baseURL.appending(path: path), resolvingAgainstBaseURL: false)
        components?.queryItems = [URLQueryItem(name: "scopeKey", value: connection?.scopeKey ?? scopeKey)] + extra
        guard let url = components?.url else { throw ShannonAPIError.invalidResponse }
        var request = URLRequest(url: url)
        authorize(&request, connection: connection)
        return request
    }

    func autonomyPost<Body: Encodable>(
        _ path: String,
        body: Body,
        connection: ShannonConnectionCredential?
    ) throws -> URLRequest {
        var request = URLRequest(url: baseURL.appending(path: path))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        authorize(&request, connection: connection)
        request.httpBody = try JSONEncoder().encode(body)
        return request
    }

    /// Identifiers are server-issued and contain no separator; `appending(path:)` does the percent-encoding.
    static func pathComponent(_ value: String) throws -> String {
        guard !value.isEmpty, !value.contains("/"), !value.contains("?"), !value.contains("#"),
              value != ".", value != ".." else {
            throw ShannonAPIError.invalidResponse
        }
        return value
    }
}
