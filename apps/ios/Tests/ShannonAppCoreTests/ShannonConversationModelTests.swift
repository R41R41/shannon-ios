import XCTest
@testable import ShannonAppCore

@MainActor
final class ShannonConversationModelTests: XCTestCase {
    func testSuccessfulTurnAppendsBothMessagesAndState() async {
        let response = TestFixtures.chatResponse(version: 3, reply: "聞いてるよ")
        let model = ShannonConversationModel(client: StubClient(response: response))
        model.draft = "こんにちは"

        await model.sendDraft()

        XCTAssertEqual(model.messages.map(\.text), ["こんにちは", "聞いてるよ"])
        XCTAssertEqual(model.state?.version, 3)
        XCTAssertNil(model.errorMessage)
        XCTAssertFalse(model.isSending)
    }

    func testEmptyDraftDoesNotCallClientOrAppend() async {
        let model = ShannonConversationModel(client: StubClient(response: TestFixtures.chatResponse()))
        model.draft = "   "

        await model.sendDraft()

        XCTAssertTrue(model.messages.isEmpty)
    }
}

private struct StubClient: ShannonAPIClientProtocol {
    let response: ChatResponseDTO
    func send(message: String, scopeKey: String) async throws -> ChatResponseDTO { response }
}

private enum TestFixtures {
    static func chatResponse(version: Int = 0, reply: String = "ok") -> ChatResponseDTO {
        ChatResponseDTO(
            mode: "local-stub",
            reply: reply,
            snapshotVersion: version,
            systemPrompt: "prompt",
            state: CompanionStateDTO(
                scopeKey: "local-owner",
                version: version,
                updatedAt: "2026-08-31T00:00:00.000Z",
                temperament: ShannonTemperamentDTO(
                    curiosity: 0.65,
                    initiative: 0.25,
                    closeness: 0.15,
                    calmness: 0.60,
                    needForContinuity: 0.70,
                    confidenceAboutUser: 0.05
                ),
                emotion: ShannonEmotionDTO(valence: 0, arousal: 0.3, openness: 0.35),
                interests: [],
                userFacts: [],
                activeMemories: []
            )
        )
    }
}

