import XCTest
@testable import ShannonAppCore

/// The text chat's sentence stream (docs/chat-stream-contract.md): the NDJSON lines, their ordering, and how the
/// provisional reply gives way to the stored one.
final class ShannonChatStreamTests: XCTestCase {
    // MARK: Lines

    func testParsesEveryLineTypeOfTheContract() throws {
        XCTAssertEqual(
            try ShannonChatStreamEvent.parse(line: #"{"type":"start","threadId":"t-1","audience":"owner"}"#),
            .start(threadId: "t-1", audience: "owner", turnId: nil)
        )
        XCTAssertEqual(
            try ShannonChatStreamEvent.parse(line: #"{"type":"sentence","index":0,"text":"はい、聞こえています。\n\n"}"#),
            .sentence(index: 0, text: "はい、聞こえています。\n\n")
        )
        XCTAssertEqual(
            try ShannonChatStreamEvent.parse(line: #"{"type":"error","status":502,"error":"MODEL_UNAVAILABLE"}"#),
            .error(status: 502, code: "MODEL_UNAVAILABLE")
        )
        let response = Fixture.response(reply: "はい、聞こえています。")
        XCTAssertEqual(try ShannonChatStreamEvent.parse(line: Fixture.doneLine(response)), .done(response, fallback: nil))
        XCTAssertEqual(
            try ShannonChatStreamEvent.parse(line: Fixture.doneLine(response, fallback: "command")),
            .done(response, fallback: "command")
        )
    }

    func testIgnoresUnknownTypesAndFieldsAndBlankLines() throws {
        XCTAssertEqual(try ShannonChatStreamEvent.parse(line: #"{"type":"tool","name":"x"}"#), .unknown(type: "tool"))
        XCTAssertEqual(
            try ShannonChatStreamEvent.parse(line: #"{"type":"sentence","index":1,"text":"a","extra":true}"#),
            .sentence(index: 1, text: "a")
        )
        XCTAssertNil(try ShannonChatStreamEvent.parse(line: ""))
        XCTAssertNil(try ShannonChatStreamEvent.parse(line: "  "))
    }

    func testRejectsLinesThatAreNotEvents() {
        XCTAssertThrowsError(try ShannonChatStreamEvent.parse(line: "not json"))
        XCTAssertThrowsError(try ShannonChatStreamEvent.parse(line: #"{"type":"sentence","text":"no index"}"#))
        XCTAssertThrowsError(try ShannonChatStreamEvent.parse(line: #"{"type":"done"}"#))
    }

    func testSplitsOnlyAtNewlines() {
        // U+2028 is legal unescaped inside a JSON string; AsyncLineSequence would cut the line there.
        let bytes = Array("{\"a\":\"x\u{2028}y\"}\r\n{\"b\":1}\n{\"c\":2}".utf8)
        var splitter = ShannonNDJSONLineSplitter()
        var lines = bytes.compactMap { splitter.append($0) }
        if let last = splitter.finish() { lines.append(last) }
        XCTAssertEqual(lines, ["{\"a\":\"x\u{2028}y\"}", "{\"b\":1}", "{\"c\":2}"])
    }

    // MARK: Ordering

    func testJoinsSentencesInIndexOrderAndStopsAtDone() throws {
        var assembler = ShannonChatStreamAssembler()
        XCTAssertEqual(try assembler.apply(.start(threadId: "t-1", audience: "owner", turnId: nil)), .started)
        _ = try assembler.apply(.sentence(index: 0, text: "はい。\n"))
        _ = try assembler.apply(.sentence(index: 1, text: "元気です。"))
        XCTAssertEqual(assembler.text, "はい。\n元気です。")
        XCTAssertEqual(assembler.threadId, "t-1")
        let response = Fixture.response(reply: "はい。\n元気です。")
        XCTAssertEqual(try assembler.apply(.done(response, fallback: nil)), .finished(response, fallback: nil))
        // Nothing follows a terminal line.
        XCTAssertEqual(try assembler.apply(.sentence(index: 2, text: "余計")), .ignored)
    }

    func testASentenceOutOfOrderIsABrokenStream() {
        var assembler = ShannonChatStreamAssembler()
        XCTAssertThrowsError(try assembler.apply(.sentence(index: 1, text: "b")))
    }

    func testAnErrorAfterSentencesRetractsThem() throws {
        var assembler = ShannonChatStreamAssembler()
        _ = try assembler.apply(.start(threadId: "t-1", audience: "owner", turnId: nil))
        _ = try assembler.apply(.sentence(index: 0, text: "途中まで。"))
        XCTAssertThrowsError(try assembler.apply(.error(status: 502, code: "MODEL_UNAVAILABLE"))) { error in
            let retracted = error as? ShannonChatStreamRetracted
            XCTAssertEqual(retracted?.shownText, "途中まで。")
            XCTAssertEqual(retracted?.threadId, "t-1")
            XCTAssertEqual(retracted?.turnWasNotStored, true)
        }
    }

    // MARK: Reading a body

    func testReadsAStreamAndReportsEachSentence() async throws {
        let response = Fixture.response(reply: "はい。元気です。")
        let body = [
            #"{"type":"start","threadId":"t-1","audience":"owner"}"#,
            #"{"type":"sentence","index":0,"text":"はい。"}"#,
            #"{"type":"sentence","index":1,"text":"元気です。"}"#,
            Fixture.doneLine(response),
        ].joined(separator: "\n") + "\n"
        let recorder = ProgressRecorder()
        let result = try await ShannonChatStreamReader.read(
            bytes: Fixture.bytes(body),
            contentType: "application/x-ndjson; charset=utf-8",
            onProgress: { await recorder.record($0) }
        )
        XCTAssertEqual(result, response)
        let texts = await recorder.texts
        XCTAssertEqual(texts, ["はい。", "はい。元気です。"])
        // The equality rule: the sentences joined are the reply.
        XCTAssertEqual(texts.last, result.reply)
    }

    func testReadsAFallbackTurnAndAnOlderServersJSON() async throws {
        let response = Fixture.response(reply: "タスクにしました。")
        let fallback = try await ShannonChatStreamReader.read(
            bytes: Fixture.bytes(Fixture.doneLine(response, fallback: "command") + "\n"),
            contentType: "application/x-ndjson",
            onProgress: { _ in XCTFail("a fallback turn has no sentences") }
        )
        XCTAssertEqual(fallback, response)

        let json = String(decoding: try JSONEncoder().encode(response), as: UTF8.self)
        let plain = try await ShannonChatStreamReader.read(
            bytes: Fixture.bytes(json),
            contentType: "application/json; charset=utf-8",
            onProgress: { _ in XCTFail("a JSON answer has no sentences") }
        )
        XCTAssertEqual(plain, response)
    }

    func testAStreamThatEndsWithoutDoneIsInterruptedWithWhatArrived() async {
        let body = [
            #"{"type":"start","threadId":"t-1","audience":"owner"}"#,
            #"{"type":"sentence","index":0,"text":"途中まで。"}"#,
        ].joined(separator: "\n") + "\n"
        do {
            _ = try await ShannonChatStreamReader.read(
                bytes: Fixture.bytes(body), contentType: "application/x-ndjson", onProgress: { _ in })
            XCTFail("expected an interruption")
        } catch let interrupted as ShannonChatStreamInterrupted {
            XCTAssertEqual(interrupted.partialText, "途中まで。")
            XCTAssertEqual(interrupted.threadId, "t-1")
        } catch {
            XCTFail("unexpected \(error)")
        }
    }

    func testAnErrorLineIsARetractionNotAnInterruption() async {
        let body = [
            #"{"type":"start","threadId":"t-1","audience":"owner"}"#,
            #"{"type":"sentence","index":0,"text":"見せた文。"}"#,
            #"{"type":"error","status":502,"error":"STREAM_FAILED"}"#,
        ].joined(separator: "\n") + "\n"
        do {
            _ = try await ShannonChatStreamReader.read(
                bytes: Fixture.bytes(body), contentType: "application/x-ndjson", onProgress: { _ in })
            XCTFail("expected a retraction")
        } catch let retracted as ShannonChatStreamRetracted {
            XCTAssertEqual(retracted.code, "STREAM_FAILED")
            XCTAssertFalse(retracted.turnWasNotStored)
        } catch {
            XCTFail("unexpected \(error)")
        }
    }

    // MARK: Reconciliation

    func testTheStoredReplyTakesTheProvisionalRowsPlace() {
        let provisional = UUID()
        var response = Fixture.response(reply: "はい。元気です。", expression: .joyful, turnId: "turn-9")
        response.feedback = nil
        let message = ShannonConversationModel.reconciledReply(response, provisionalID: provisional)
        XCTAssertEqual(message.id, provisional)
        XCTAssertEqual(message.role, .shannon)
        XCTAssertEqual(message.text, "はい。元気です。")
        XCTAssertEqual(message.turnID, "turn-9")
        XCTAssertEqual(message.emotionSnapshot?.expression, .joyful)
        XCTAssertEqual(message.deliveryState, .sent)
    }

    @MainActor
    func testTheReplyGrowsPerSentenceAndIsReplacedByDone() async {
        let response = Fixture.response(reply: "はい。元気です。", expression: .joyful, turnId: "turn-1")
        let seen = SeenReplies()
        let client = StreamingClient(
            sentences: ["はい。", "元気です。"],
            outcome: .success(response)
        )
        let model = ShannonConversationModel(client: client)
        await client.setProbe { @MainActor in
            seen.replies.append(model.visibleStreamingReply)
            seen.typing.append(model.showsTypingIndicator)
        }

        model.draft = "元気？"
        let sent = await model.sendDraft()

        XCTAssertTrue(sent)
        XCTAssertEqual(seen.replies.map { $0?.text }, ["はい。", "はい。元気です。"])
        XCTAssertEqual(seen.typing, [false, false], "the waiting indicator gives way at the first sentence")
        XCTAssertNil(model.streamingReply)
        XCTAssertFalse(model.isSending)
        XCTAssertEqual(model.messages.map(\.text), ["元気？", "はい。元気です。"])
        XCTAssertEqual(model.messages.first?.deliveryState, .sent)
        let reply = model.messages.last
        XCTAssertEqual(reply?.id, seen.replies.last??.id, "the row that grew is the row that stays")
        XCTAssertEqual(reply?.turnID, "turn-1")
        XCTAssertEqual(reply?.emotionSnapshot?.expression, .joyful)
        XCTAssertEqual(model.draft, "", "the draft is cleared on accept, as before")
    }

    @MainActor
    func testARetractedReplyIsDiscardedAndOffersResend() async {
        let client = StreamingClient(
            sentences: ["見せた文。"],
            outcome: .retracted(ShannonChatStreamRetracted(
                status: 502, code: "MODEL_UNAVAILABLE", threadId: "t-1", shownText: "見せた文。"))
        )
        let model = ShannonConversationModel(client: client)

        model.draft = "元気？"
        await model.sendDraft()

        XCTAssertNil(model.streamingReply)
        XCTAssertEqual(model.messages.map(\.text), ["元気？"])
        XCTAssertEqual(model.messages.first?.deliveryState, .failed)
        XCTAssertEqual(model.errorMessage, ShannonFailureCopy.streamRetracted)
        XCTAssertTrue(model.hasFailedMessage)
    }

    @MainActor
    func testACutOffReplyIsKeptMarkedAndResendFindsTheStoredTurnInsteadOfSendingTwice() async {
        let storedAt = Date().formatted(.iso8601)
        let client = StreamingClient(
            sentences: ["途中まで。"],
            outcome: .interrupted(ShannonChatStreamInterrupted(partialText: "途中まで。", threadId: "t-1", underlying: nil)),
            history: ConversationHistoryResponseDTO(
                threadId: "t-1",
                messages: [
                    StoredConversationMessageDTO(id: "u-1", role: "user", content: "元気？", observedAt: storedAt),
                    StoredConversationMessageDTO(
                        id: "a-1", role: "assistant", content: "途中まで。続きです。", observedAt: storedAt,
                        sourceExperienceId: "turn-1"),
                ],
                state: Fixture.state()
            )
        )
        let model = ShannonConversationModel(client: client)

        model.draft = "元気？"
        await model.sendDraft()

        XCTAssertEqual(model.streamingReply?.phase, .interrupted)
        XCTAssertEqual(model.streamingReply?.text, "途中まで。")
        XCTAssertEqual(model.messages.first?.deliveryState, .failed)
        XCTAssertEqual(model.errorMessage, ShannonFailureCopy.streamInterrupted)

        await model.retryLastFailed()

        let sends = await client.sendCount
        XCTAssertEqual(sends, 1, "再送 showed the turn the server finished instead of sending it again")
        XCTAssertNil(model.streamingReply)
        XCTAssertEqual(model.messages.map(\.text), ["元気？", "途中まで。続きです。"])
        XCTAssertNil(model.errorMessage)
    }

    func testAStoredTurnIsOnlyOneThisDeviceDidNotAlreadyShow() throws {
        let sentAt = try Date("2026-10-13T00:00:00Z", strategy: .iso8601)
        let stored = [
            StoredConversationMessageDTO(id: "u-0", role: "user", content: "うん", observedAt: "2026-10-13T00:00:01.000Z"),
            StoredConversationMessageDTO(
                id: "a-0", role: "assistant", content: "前の返事", observedAt: "2026-10-13T00:00:03.000Z",
                sourceExperienceId: "turn-0"),
        ]
        func exists(_ messages: [StoredConversationMessageDTO], _ text: String, known: Set<String> = [], at: Date? = nil) -> Bool {
            ShannonConversationModel.storedTurnExists(in: messages, sentText: text, sentAt: at ?? sentAt, knownIdentities: known)
        }
        XCTAssertTrue(exists(stored, " うん\n"))
        XCTAssertFalse(exists(stored, "うん", known: ["turn-0"]))
        XCTAssertFalse(exists(stored, "うん", known: ["a-0"]))
        XCTAssertFalse(exists(stored, "ちがう"))
        // His message alone (her reply not stored yet) is not a finished turn.
        XCTAssertFalse(exists(Array(stored.prefix(1)), "うん"))
        // An older turn with the same words (「おはよう」 yesterday) is not the one that was cut off.
        XCTAssertFalse(exists(stored, "うん", at: sentAt.addingTimeInterval(3_600)))
        // A server clock a few seconds behind the device still matches.
        XCTAssertTrue(exists(stored, "うん", at: sentAt.addingTimeInterval(8)))
    }
}

// MARK: - Fixtures

private enum Fixture {
    static func response(
        reply: String,
        expression: ShannonExpressionDTO = .calm,
        turnId: String? = nil
    ) -> ChatResponseDTO {
        ChatResponseDTO(
            mode: "local-stub",
            reply: reply,
            threadId: "t-1",
            snapshotVersion: 3,
            messageEmotion: ShannonMessageEmotionDTO(valence: 0.2, arousal: 0.3, openness: 0.4, expression: expression),
            systemPrompt: "",
            state: state(),
            turnId: turnId
        )
    }

    static func state() -> CompanionStateDTO {
        CompanionStateDTO(
            scopeKey: "local-owner",
            version: 3,
            updatedAt: "2026-10-13T00:00:00.000Z",
            temperament: ShannonTemperamentDTO(
                curiosity: 0.65, initiative: 0.25, closeness: 0.15,
                calmness: 0.60, needForContinuity: 0.70, confidenceAboutUser: 0.05
            ),
            emotion: ShannonEmotionDTO(valence: 0, arousal: 0.3, openness: 0.35),
            interests: [],
            userFacts: [],
            activeMemories: []
        )
    }

    static func doneLine(_ response: ChatResponseDTO, fallback: String? = nil) -> String {
        let body = String(decoding: try! JSONEncoder().encode(response), as: UTF8.self)
        let fallbackField = fallback.map { #","fallback":"\#($0)""# } ?? ""
        return #"{"type":"done","response":\#(body)\#(fallbackField)}"#
    }

    static func bytes(_ text: String) -> AsyncStream<UInt8> {
        AsyncStream { continuation in
            for byte in Array(text.utf8) { continuation.yield(byte) }
            continuation.finish()
        }
    }
}

private actor ProgressRecorder {
    private(set) var texts: [String] = []
    func record(_ progress: ShannonChatStreamProgress) { texts.append(progress.text) }
}

@MainActor
private final class SeenReplies {
    var replies: [ShannonStreamingReply?] = []
    var typing: [Bool] = []
}

/// A server that answers a text turn sentence by sentence, then with `done`, `error` or a broken connection.
private actor StreamingClient: ShannonAPIClientProtocol, ShannonChatStreamServing {
    enum Outcome: Sendable {
        case success(ChatResponseDTO)
        case retracted(ShannonChatStreamRetracted)
        case interrupted(ShannonChatStreamInterrupted)
    }

    let sentences: [String]
    let outcome: Outcome
    let history: ConversationHistoryResponseDTO?
    private(set) var sendCount = 0
    private var probe: (@MainActor @Sendable () -> Void)?

    init(sentences: [String], outcome: Outcome, history: ConversationHistoryResponseDTO? = nil) {
        self.sentences = sentences
        self.outcome = outcome
        self.history = history
    }

    func setProbe(_ probe: @escaping @MainActor @Sendable () -> Void) { self.probe = probe }

    func send(message: String, scopeKey: String, threadId: String?) async throws -> ChatResponseDTO {
        XCTFail("a streaming client is sent the turn as a stream")
        throw ShannonAPIError.invalidResponse
    }

    func sendStreaming(
        message: String,
        scopeKey: String,
        threadId: String?,
        attachments: [ShannonChatAttachmentDTO],
        webSearch: Bool,
        placeLocation: ShannonVoiceDeviceLocationDTO?,
        appLook: ShannonAppLookClientStateDTO?,
        onProgress: @escaping ShannonChatStreamProgressHandler
    ) async throws -> ChatResponseDTO {
        sendCount += 1
        var text = ""
        for (index, sentence) in sentences.enumerated() {
            text += sentence
            await onProgress(ShannonChatStreamProgress(threadId: "t-1", text: text, sentenceCount: index + 1))
            if let probe { await probe() }
        }
        switch outcome {
        case .success(let response): return response
        case .retracted(let error): throw error
        case .interrupted(let error): throw error
        }
    }

    func loadConversation(scopeKey: String, threadId: String?) async throws -> ConversationHistoryResponseDTO {
        guard let history else { throw ShannonAPIError.invalidResponse }
        return history
    }
}
