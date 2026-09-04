import XCTest
@testable import ShannonAppCore

@MainActor
final class ShannonMemoryModelTests: XCTestCase {
    func testLoadsAllFourMemoryKindsAndLatestSleepReport() async {
        let dashboard = MemoryFixtures.dashboard()
        let client = MemoryClient(loadResult: .success(dashboard), mutationResult: .success(dashboard))
        let model = ShannonMemoryModel(client: client)

        await model.loadIfNeeded()

        XCTAssertEqual(Set(model.activeItems.map(\.kind)), Set(ShannonMemoryKindDTO.allCases))
        XCTAssertEqual(model.latestSleepReport?.learned.first?.text, "ユーザーは紅茶が好き")
        XCTAssertNil(model.errorMessage)
    }

    func testCorrectionReplacesDashboardWithDurableServerResult() async {
        let before = MemoryFixtures.dashboard()
        let correctedItem = MemoryFixtures.item(kind: .userFact, text: "ユーザーはアールグレイが好き")
        let after = ShannonMemoryDashboardDTO(generatedAt: "later", items: [correctedItem], sleepReports: [])
        let client = MemoryClient(loadResult: .success(before), mutationResult: .success(after))
        let model = ShannonMemoryModel(client: client)
        await model.loadIfNeeded()

        let changed = await model.act(on: before.items[0], action: .correct, text: correctedItem.text)

        XCTAssertTrue(changed)
        XCTAssertEqual(model.activeItems.first?.text, correctedItem.text)
        let mutation = await client.lastMutation
        XCTAssertEqual(mutation?.action, .correct)
        XCTAssertEqual(mutation?.text, correctedItem.text)
    }
}

private actor MemoryClient: ShannonAPIClientProtocol {
    struct Mutation: Sendable {
        let action: ShannonMemoryActionDTO
        let text: String?
    }
    let loadResult: Result<ShannonMemoryDashboardDTO, TestMemoryError>
    let mutationResult: Result<ShannonMemoryDashboardDTO, TestMemoryError>
    private(set) var lastMutation: Mutation?

    init(
        loadResult: Result<ShannonMemoryDashboardDTO, TestMemoryError>,
        mutationResult: Result<ShannonMemoryDashboardDTO, TestMemoryError>
    ) {
        self.loadResult = loadResult
        self.mutationResult = mutationResult
    }

    func send(message: String, scopeKey: String, threadId: String?) async throws -> ChatResponseDTO {
        throw TestMemoryError.failed
    }
    func loadMemories(scopeKey: String) async throws -> ShannonMemoryDashboardDTO { try loadResult.get() }
    func mutateMemory(
        scopeKey: String,
        memoryID: String,
        action: ShannonMemoryActionDTO,
        text: String?
    ) async throws -> ShannonMemoryDashboardDTO {
        lastMutation = Mutation(action: action, text: text)
        return try mutationResult.get()
    }
}

private enum TestMemoryError: Error { case failed }

private enum MemoryFixtures {
    static func item(kind: ShannonMemoryKindDTO, text: String? = nil) -> ShannonMemoryItemDTO {
        ShannonMemoryItemDTO(
            id: "\(kind.rawValue)-id",
            kind: kind,
            text: text ?? kind.japaneseName,
            confidence: kind == .userFact || kind == .relationship ? 0.65 : nil,
            relevance: kind == .experience ? 0.8 : nil,
            status: .active,
            pinned: false,
            createdAt: "2026-08-31T00:00:00.000Z",
            updatedAt: "2026-08-31T00:00:00.000Z",
            changeReason: "テスト",
            evidence: []
        )
    }

    static func dashboard() -> ShannonMemoryDashboardDTO {
        let learned = ShannonSleepChangeDTO(
            kind: .userFact,
            memoryId: "user-fact-id",
            text: "ユーザーは紅茶が好き",
            reason: "学習",
            evidence: "僕は紅茶が好き"
        )
        return ShannonMemoryDashboardDTO(
            generatedAt: "2026-09-01T03:00:00.000Z",
            items: ShannonMemoryKindDTO.allCases.map { item(kind: $0) },
            sleepReports: [ShannonSleepReportDTO(
                dayKey: "2026-08-31",
                completedAt: "2026-09-01T03:00:00.000Z",
                learned: [learned],
                updated: [],
                interestChanges: [],
                contradictions: []
            )]
        )
    }
}
