import Foundation

extension ShannonAPIClient: ShannonInterestsServing {
    private struct InterestCommand: Encodable {
        let operationId: String
        let expectedRevision: Int
        let changeId: String?
    }
    public func loadInterests(scopeKey: String, cursor: Int?) async throws -> ShannonInterestsDTO {
        try await response(ShannonInterestsDTO.self, for: autonomyGet("/v1/autonomy/interests", scopeKey: scopeKey,
            extra: cursor.map { [URLQueryItem(name: "cursor", value: String($0))] } ?? []))
    }
    public func loadInterest(scopeKey: String, id: String, cursor: Int?) async throws -> ShannonInterestDetailDTO {
        try await response(ShannonInterestDetailDTO.self, for: autonomyGet("/v1/autonomy/interests/\(try Self.pathComponent(id))",
            scopeKey: scopeKey, extra: cursor.map { [URLQueryItem(name: "cursor", value: String($0))] } ?? []))
    }
    public func changeInterest(scopeKey: String, item: ShannonInterestDTO, action: ShannonInterestAction,
                               changeID: String?, operationID: String) async throws -> ShannonInterestMutationDTO {
        try await response(ShannonInterestMutationDTO.self, for: autonomyPost(
            "/v1/autonomy/interests/\(try Self.pathComponent(item.id))/\(action.rawValue)",
            body: InterestCommand(operationId: operationID, expectedRevision: item.revision, changeId: changeID), connection: currentConnection()))
    }
    public func loadInterestOperation(scopeKey: String, operationID: String) async throws -> ShannonInterestOperationDTO {
        try await response(ShannonInterestOperationDTO.self, for: autonomyGet(
            "/v1/autonomy/interests/operations/\(try Self.pathComponent(operationID))", scopeKey: scopeKey))
    }
}
