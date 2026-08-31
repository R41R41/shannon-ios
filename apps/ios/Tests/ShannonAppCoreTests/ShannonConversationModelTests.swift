import XCTest
@testable import ShannonAppCore

@MainActor
final class ShannonConversationModelTests: XCTestCase {
    func testSuccessfulTurnAppendsBothMessagesAndState() async {
        let response = TestFixtures.chatResponse(version: 3, reply: "聞いてるよ", expression: .calm)
        let model = ShannonConversationModel(client: StubClient(response: response))
        model.draft = "こんにちは"

        await model.sendDraft()

        XCTAssertEqual(model.messages.map(\.text), ["こんにちは", "聞いてるよ"])
        XCTAssertEqual(model.messages.first?.deliveryState, .sent)
        XCTAssertEqual(model.messages.last?.emotionSnapshot?.expression, .calm)
        XCTAssertEqual(model.messages.last?.emotionSnapshot?.stateVersion, 3)
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

    func testEachReplyKeepsItsExpressionSnapshot() async {
        let client = SequenceClient(results: [
            .success(TestFixtures.chatResponse(version: 1, reply: "それは嬉しい", expression: .joyful)),
            .success(TestFixtures.chatResponse(version: 2, reply: "少し休もうか", expression: .tender)),
        ])
        let model = ShannonConversationModel(client: client)

        model.draft = "できた！"
        await model.sendDraft()
        model.draft = "ちょっと疲れた"
        await model.sendDraft()

        let replies = model.messages.filter { $0.role == .shannon }
        XCTAssertEqual(replies.map(\.emotionSnapshot?.expression), [.joyful, .tender])
        XCTAssertEqual(model.currentExpression, .tender)
    }

    func testRetryDoesNotDuplicateFailedUserMessage() async {
        let client = SequenceClient(results: [
            .failure(TestFailure.offline),
            .success(TestFixtures.chatResponse(version: 1, reply: "戻ったよ", expression: .calm)),
        ])
        let model = ShannonConversationModel(client: client)

        model.draft = "聞こえる？"
        await model.sendDraft()
        XCTAssertEqual(model.messages.count, 1)
        XCTAssertEqual(model.messages.first?.deliveryState, .failed)

        await model.retryLastFailed()

        XCTAssertEqual(model.messages.map(\.text), ["聞こえる？", "戻ったよ"])
        XCTAssertEqual(model.messages.first?.deliveryState, .sent)
        XCTAssertNil(model.errorMessage)
    }

    func testLoadsPersistedConversationAndExpressionOnce() async {
        let history = ConversationHistoryResponseDTO(
            messages: [
                StoredConversationMessageDTO(
                    id: "26F3D19A-A881-40C4-99BB-6C738E86CC05",
                    role: "user",
                    content: "昨日の話",
                    observedAt: "2026-08-30T21:00:00.000Z",
                    messageEmotion: nil,
                    stateVersion: nil
                ),
                StoredConversationMessageDTO(
                    id: "8B9CD590-9BF3-43C5-B8D4-A98685F8551E",
                    role: "assistant",
                    content: "覚えているよ",
                    observedAt: "2026-08-30T21:00:01.000Z",
                    messageEmotion: ShannonMessageEmotionDTO(
                        valence: 0.4,
                        arousal: 0.6,
                        openness: 0.5,
                        expression: .joyful
                    ),
                    stateVersion: 4
                ),
            ],
            state: TestFixtures.state(version: 5)
        )
        let client = HistoryClient(history: history)
        let model = ShannonConversationModel(client: client)

        await model.loadConversationIfNeeded()
        await model.loadConversationIfNeeded()

        XCTAssertEqual(model.messages.map(\.text), ["昨日の話", "覚えているよ"])
        XCTAssertEqual(model.messages.last?.emotionSnapshot?.expression, .joyful)
        XCTAssertEqual(model.currentExpression, .joyful)
        XCTAssertEqual(model.state?.version, 5)
        let loadCount = await client.loadCount
        XCTAssertEqual(loadCount, 1)
    }
}

private struct StubClient: ShannonAPIClientProtocol {
    let response: ChatResponseDTO
    func send(message: String, scopeKey: String) async throws -> ChatResponseDTO { response }
}

private enum TestFailure: Error {
    case offline
}

private actor SequenceClient: ShannonAPIClientProtocol {
    var results: [Result<ChatResponseDTO, TestFailure>]

    init(results: [Result<ChatResponseDTO, TestFailure>]) {
        self.results = results
    }

    func send(message: String, scopeKey: String) async throws -> ChatResponseDTO {
        try results.removeFirst().get()
    }
}

private actor HistoryClient: ShannonAPIClientProtocol {
    let history: ConversationHistoryResponseDTO
    private(set) var loadCount = 0

    init(history: ConversationHistoryResponseDTO) {
        self.history = history
    }

    func send(message: String, scopeKey: String) async throws -> ChatResponseDTO {
        TestFixtures.chatResponse()
    }

    func loadConversation(scopeKey: String) async throws -> ConversationHistoryResponseDTO {
        loadCount += 1
        return history
    }
}

private enum TestFixtures {
    static func chatResponse(
        version: Int = 0,
        reply: String = "ok",
        expression: ShannonExpressionDTO = .calm
    ) -> ChatResponseDTO {
        ChatResponseDTO(
            mode: "local-stub",
            reply: reply,
            snapshotVersion: version,
            messageEmotion: ShannonMessageEmotionDTO(
                valence: 0,
                arousal: 0.3,
                openness: 0.35,
                expression: expression
            ),
            systemPrompt: "prompt",
            state: state(version: version)
        )
    }

    static func state(version: Int) -> CompanionStateDTO {
        CompanionStateDTO(
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
    }
}
