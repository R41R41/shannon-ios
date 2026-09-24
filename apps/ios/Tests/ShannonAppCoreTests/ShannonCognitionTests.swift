import Foundation
import Testing
@testable import ShannonAppCore

@MainActor
struct ShannonCognitionTests {
    @Test
    func decodesOwnerVisibleIntentAndBoundedCycleReceipt() throws {
        let payload = Data(#"""
        {
          "intents": [{
            "id":"goal-1","title":"音声対話を改善したい","desiredOutcome":"音声対話を改善したい",
            "status":"active","source":"explicit-user-goal","threadId":"thread-1",
            "priority":0.8,"confidence":0.95,"createdAt":"2026-09-25T00:00:00Z","updatedAt":"2026-09-25T01:00:00Z"
          }],
          "recentCycles": [{
            "id":"cycle-1","threadId":"thread-1","channel":"voice","primaryIntentID":"goal-1",
            "recalledMemoryIDs":["memory-1"],"action":"delegate","outcome":"completed",
            "summary":"交通検索を実行した","occurredAt":"2026-09-25T01:01:00Z"
          }]
        }
        """#.utf8)

        let dashboard = try JSONDecoder().decode(ShannonCognitionDashboardDTO.self, from: payload)

        #expect(dashboard.intents.first?.status == .active)
        #expect(dashboard.intents.first?.threadId == "thread-1")
        #expect(dashboard.recentCycles.first?.channelLabel == "音声")
        #expect(dashboard.recentCycles.first?.recalledMemoryIDs == ["memory-1"])
    }

    @Test
    func statusMutationUsesServerResultAndMovesIntentBetweenSections() async throws {
        let intent = cognitionIntent(status: .active)
        let client = CognitionClient(cognition: .init(intents: [intent], recentCycles: []))
        let model = ShannonMemoryModel(client: client)
        await model.loadIfNeeded()

        #expect(model.activeIntents.map(\.id) == [intent.id])
        #expect(await model.updateIntent(intent, status: .paused))
        #expect(model.activeIntents.isEmpty)
        #expect(model.pausedIntents.map(\.id) == [intent.id])
        let mutation = await client.lastMutation
        #expect(mutation?.intentID == intent.id)
        #expect(mutation?.status == .paused)
        #expect(model.cognitionErrorMessage == nil)
    }

    @Test
    func cognitionFailureKeepsLastGoodDashboardWithoutBreakingMemories() async {
        let intent = cognitionIntent(status: .active)
        let client = CognitionClient(cognition: .init(intents: [intent], recentCycles: []))
        let model = ShannonMemoryModel(client: client)
        await model.loadIfNeeded()
        await client.setUnavailable(true)

        await model.reload()

        #expect(model.dashboard != nil)
        #expect(model.activeIntents.map(\.id) == [intent.id])
        #expect(model.errorMessage == nil)
        #expect(model.cognitionErrorMessage != nil)
    }
}

private actor CognitionClient: ShannonMemoryServing {
    struct Mutation: Sendable {
        let intentID: String
        let status: ShannonCognitiveIntentStatusDTO
    }

    private var cognition: ShannonCognitionDashboardDTO
    private var unavailable = false
    private(set) var lastMutation: Mutation?

    init(cognition: ShannonCognitionDashboardDTO) {
        self.cognition = cognition
    }

    func setUnavailable(_ value: Bool) {
        unavailable = value
    }

    func loadMemories(scopeKey: String) async throws -> ShannonMemoryDashboardDTO {
        ShannonMemoryDashboardDTO(generatedAt: "2026-09-25T00:00:00Z", items: [], sleepReports: [])
    }

    func mutateMemory(
        scopeKey: String,
        memoryID: String,
        action: ShannonMemoryActionDTO,
        text: String?
    ) async throws -> ShannonMemoryDashboardDTO {
        try await loadMemories(scopeKey: scopeKey)
    }

    func correctKnowledge(scopeKey: String, answerId: String, answer: String) async throws -> ShannonMemoryDashboardDTO {
        try await loadMemories(scopeKey: scopeKey)
    }

    func loadCognition(scopeKey: String) async throws -> ShannonCognitionDashboardDTO {
        if unavailable { throw URLError(.notConnectedToInternet) }
        return cognition
    }

    func updateCognitiveIntent(
        scopeKey: String,
        intentID: String,
        status: ShannonCognitiveIntentStatusDTO
    ) async throws -> ShannonCognitiveIntentDTO {
        if unavailable { throw URLError(.notConnectedToInternet) }
        lastMutation = Mutation(intentID: intentID, status: status)
        guard let current = cognition.intents.first(where: { $0.id == intentID }) else {
            throw URLError(.resourceUnavailable)
        }
        let updated = cognitionIntent(
            id: current.id,
            status: status,
            updatedAt: "2026-09-25T02:00:00Z"
        )
        cognition = ShannonCognitionDashboardDTO(
            intents: cognition.intents.map { $0.id == intentID ? updated : $0 },
            recentCycles: cognition.recentCycles
        )
        return updated
    }
}

private func cognitionIntent(
    id: String = "goal-1",
    status: ShannonCognitiveIntentStatusDTO,
    updatedAt: String = "2026-09-25T01:00:00Z"
) -> ShannonCognitiveIntentDTO {
    ShannonCognitiveIntentDTO(
        id: id,
        title: "音声対話を改善したい",
        desiredOutcome: "自然な日本語音声で途切れずに話せるようにする",
        status: status,
        source: "explicit-user-goal",
        sourceExperienceId: nil,
        threadId: "thread-1",
        nextStep: nil,
        priority: 0.8,
        confidence: 0.95,
        createdAt: "2026-09-25T00:00:00Z",
        updatedAt: updatedAt
    )
}
