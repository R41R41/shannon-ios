import Foundation

/// The owner's reads and controls of 目標 and 点検 (Syzygy ADR-0009 stage 2, E7; `docs/executive-ui-contract.md`). Every route
/// answers only a paired device of the owner's scope. A 404 (a server before the route) or a 403 shows the part as 「準備中」.
extension ShannonAPIClient {
    private struct ScopeRequest: Encodable { let scopeKey: String }

    public func loadShannonGoals(scopeKey: String) async throws -> ShannonGoalsDTO {
        try await response(ShannonGoalsDTO.self, for: autonomyGet("/v1/autonomy/goals", scopeKey: scopeKey))
    }

    public func loadShannonChoices(scopeKey: String, days: Int) async throws -> ShannonChoicesDTO {
        try await response(ShannonChoicesDTO.self, for: autonomyGet(
            "/v1/autonomy/choices", scopeKey: scopeKey, extra: [URLQueryItem(name: "days", value: String(days))]
        ))
    }

    public func confirmShannonGoal(scopeKey: String, id: String) async throws -> ShannonGoalsDTO {
        let connection = currentConnection()
        return try await response(ShannonGoalsDTO.self, for: autonomyPost(
            "/v1/autonomy/pursuits/\(try Self.pathComponent(id))/confirm",
            body: ScopeRequest(scopeKey: connection?.scopeKey ?? scopeKey),
            connection: connection
        ))
    }

    /// The route of 頭の中's 休ませる／やめる. Its answer (the autonomy overview) is not read here: 目標 reads its list again.
    public func setShannonGoalStatus(scopeKey: String, id: String, status: String) async throws {
        let connection = currentConnection()
        let request = try autonomyPost(
            "/v1/autonomy/pursuits/\(try Self.pathComponent(id))/status",
            body: ShannonAutonomyStatusRequestDTO(scopeKey: connection?.scopeKey ?? scopeKey, status: status),
            connection: connection
        )
        let (_, answer) = try await session.data(for: request)
        guard let http = answer as? HTTPURLResponse else { throw ShannonAPIError.invalidResponse }
        guard (200..<300).contains(http.statusCode) else { throw ShannonAPIError.rejected(status: http.statusCode) }
    }

    public func loadShannonCapabilities(scopeKey: String) async throws -> ShannonCapabilitiesDTO {
        try await response(ShannonCapabilitiesDTO.self, for: autonomyGet("/v1/autonomy/capabilities", scopeKey: scopeKey))
    }

    public func loadShannonInspection(scopeKey: String, day: String?) async throws -> ShannonInspectionDTO {
        try await response(ShannonInspectionDTO.self, for: autonomyGet(
            "/v1/autonomy/inspection", scopeKey: scopeKey, extra: day.map { [URLQueryItem(name: "day", value: $0)] } ?? []
        ))
    }
}
