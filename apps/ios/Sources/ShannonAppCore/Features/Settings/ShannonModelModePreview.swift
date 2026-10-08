#if DEBUG
import Foundation

/// Synthetic settings QA only. The caller must already be an explicit design preview.
@MainActor final class ShannonModelModePreview: ShannonModelModeServing {
    enum Scenario: String { case haiku, sonnet, unavailable, loading, saveerror, conflict }
    private let scenario: Scenario
    private let credential: ShannonConnectionCredential
    private var snapshot: ShannonModelModeDTO
    private var readFails = false
    private var writes = 0

    static func configured(scopeKey: String, arguments: [String] = ProcessInfo.processInfo.arguments) -> ShannonModelModePreview? {
        guard let index = arguments.firstIndex(of: "-ShannonPreviewModelMode"), arguments.indices.contains(index + 1),
              let scenario = Scenario(rawValue: arguments[index + 1]) else { return nil }
        return ShannonModelModePreview(scopeKey: scopeKey, scenario: scenario)
    }

    init(scopeKey: String, scenario: Scenario) {
        self.scenario = scenario
        credential = ShannonConnectionCredential(baseURL: URL(string: "https://model-mode-preview.invalid")!,
            token: "synthetic-preview", deviceID: "synthetic-preview", scopeKey: scopeKey,
            displayName: "合成プレビュー", expiresAt: .distantFuture)
        snapshot = Self.value(scenario == .sonnet ? .sonnet : .haiku, revision: 0, sonnetAvailable: scenario != .unavailable)
    }

    func modelModeConnection() -> ShannonModelModeConnection? { ShannonModelModeConnection(credential) }
    func loadModelMode(connection: ShannonModelModeConnection) async throws -> ShannonModelModeDTO {
        if scenario == .loading { try await Task.sleep(for: .seconds(60)) }
        if readFails { readFails = false; throw URLError(.notConnectedToInternet) }
        return snapshot
    }
    func setModelMode(_ mode: ShannonModelMode, expectedRevision: Int, connection: ShannonModelModeConnection) async throws -> ShannonModelModeDTO {
        writes += 1
        if scenario == .saveerror { readFails = true; throw URLError(.networkConnectionLost) }
        if scenario == .conflict && writes == 1 {
            snapshot = Self.value(.haiku, revision: 2)
            throw ShannonModelModeAPIError.rejected(status: 409)
        }
        guard snapshot.revision == expectedRevision, snapshot.isAvailable(mode) else {
            throw ShannonModelModeAPIError.rejected(status: 409)
        }
        snapshot = Self.value(mode, revision: expectedRevision + 1)
        return snapshot
    }
    private static func value(_ mode: ShannonModelMode, revision: Int, sonnetAvailable: Bool = true) -> ShannonModelModeDTO {
        ShannonModelModeDTO(mode: mode, revision: revision, available: .init(haiku: true, sonnet: sonnetAvailable),
            models: .init(haiku: "claude-haiku-5-5", sonnet: "claude-sonnet-5-5"), appliesTo: ["conversation", "autonomy-planning"])
    }
}
#endif
