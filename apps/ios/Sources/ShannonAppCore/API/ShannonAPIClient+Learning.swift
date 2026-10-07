import Foundation

/// The owner's reads and controls of 学び (Syzygy ADR-0008 §13): her value table (`docs/cognition-ledger-contract.md`) and her
/// skills (`docs/skill-and-routing-contract.md`). Every route answers only a paired device of the owner's scope; a 403 means
/// the part is not offered (another device, or the part switched off on the server).
extension ShannonAPIClient {
    private struct RollbackRequest: Encodable { let versionId: String? }
    private struct EmptyRequest: Encodable {}

    public func loadShannonValues(scopeKey: String) async throws -> ShannonValuesDTO {
        try await response(ShannonValuesDTO.self, for: autonomyGet("/v1/autonomy/values", scopeKey: scopeKey))
    }

    public func rollbackShannonValues(scopeKey: String, versionID: String?) async throws -> ShannonValuesDTO {
        try await response(ShannonValuesDTO.self, for: autonomyPost(
            "/v1/autonomy/values/rollback", body: RollbackRequest(versionId: versionID), connection: currentConnection()
        ))
    }

    public func resumeShannonValues(scopeKey: String) async throws -> ShannonValuesDTO {
        try await response(ShannonValuesDTO.self, for: autonomyPost(
            "/v1/autonomy/values/resume", body: EmptyRequest(), connection: currentConnection()
        ))
    }

    public func loadShannonSkills(scopeKey: String) async throws -> ShannonSkillsDTO {
        try await response(ShannonSkillsDTO.self, for: autonomyGet("/v1/autonomy/skills", scopeKey: scopeKey))
    }

    public func loadShannonSkill(scopeKey: String, id: String) async throws -> ShannonSkillDetailDTO {
        try await response(ShannonSkillDetailDTO.self, for: autonomyGet(
            "/v1/autonomy/skills/\(try Self.pathComponent(id))", scopeKey: scopeKey
        ))
    }

    public func setShannonSkillPinned(scopeKey: String, id: String, pinned: Bool) async throws -> ShannonSkillDTO {
        try await response(ShannonSkillDTO.self, for: autonomyPost(
            "/v1/autonomy/skills/\(try Self.pathComponent(id))/\(pinned ? "pin" : "unpin")", body: EmptyRequest(), connection: currentConnection()
        ))
    }
}
