import XCTest
@testable import ShannonAppCore

@MainActor
final class ShannonTurnCaptureTests: XCTestCase {
    private var calendar: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "Asia/Tokyo")!
        return calendar
    }
    // Thursday 2026-09-24 10:00 in Tokyo.
    private let now = Date(timeIntervalSince1970: 1_790_211_600)

    func testCaptureLinesSayWhatWasTakenInWithADateRelativeToToday() {
        let promise = ShannonTurnCaptureDTO(
            id: "c1", kind: .commitment, text: "プレゼンの練習", itemId: "prospective-1",
            dueDate: "2026-09-25", dueHint: "明日の朝", timeZone: "Asia/Tokyo", status: "active"
        )
        XCTAssertEqual(ShannonTurnCapturePresentation.line(promise, now: now, calendar: calendar), "約束にしました：明日 プレゼンの練習")
        // Two days later the same record must not still say 「明日」.
        XCTAssertEqual(
            ShannonTurnCapturePresentation.line(promise, now: now.addingTimeInterval(2 * 86_400), calendar: calendar),
            "約束にしました：昨日 プレゼンの練習"
        )
        let timed = ShannonTurnCaptureDTO(
            id: "c2", kind: .commitment, text: "起こして", itemId: "prospective-2",
            note: "時刻ちょうどにはお知らせできません。1日1回の声かけの枠でお知らせします。",
            dueDate: "2026-09-25", dueAt: "2026-09-24T23:00:00.000Z", timeZone: "Asia/Tokyo"
        )
        XCTAssertEqual(ShannonTurnCapturePresentation.line(timed, now: now, calendar: calendar), "約束にしました：明日 8時 起こして")
        XCTAssertTrue(ShannonTurnCapturePresentation.accessibilityLabel(timed, now: now, calendar: calendar)
            .contains("時刻ちょうどにはお知らせできません"))
        let vague = ShannonTurnCaptureDTO(id: "c3", kind: .commitment, text: "部屋の掃除", itemId: "p3", dueHint: "あとで")
        XCTAssertEqual(ShannonTurnCapturePresentation.line(vague, now: now, calendar: calendar), "約束にしました：あとで 部屋の掃除")
        let far = ShannonTurnCaptureDTO(id: "c4", kind: .commitment, text: "家賃を払う", itemId: "p4", dueDate: "2026-10-31")
        XCTAssertEqual(ShannonTurnCapturePresentation.line(far, now: now, calendar: calendar), "約束にしました：10月31日 家賃を払う")
    }

    func testKnowledgeGoalAndNoticeWording() {
        let learned = ShannonTurnCaptureDTO(id: "k1", kind: .knowledge, text: "寿司は光り物が好き", itemId: "f1", change: "created")
        XCTAssertEqual(ShannonTurnCapturePresentation.line(learned), "覚えました：寿司は光り物が好き")
        let revised = ShannonTurnCaptureDTO(
            id: "k2", kind: .knowledge, text: "寿司が苦手", itemId: "f1", change: "updated", previousText: "寿司が好き"
        )
        XCTAssertEqual(ShannonTurnCapturePresentation.line(revised), "覚え直しました：寿司が苦手（前は「寿司が好き」）")
        let known = ShannonTurnCaptureDTO(id: "k3", kind: .knowledge, text: "寿司が好き", itemId: "f1", change: "confirmed")
        XCTAssertEqual(ShannonTurnCapturePresentation.line(known), "覚えています：寿司が好き")
        let goal = ShannonTurnCaptureDTO(id: "g1", kind: .intent, text: "Shannon Deskを今月中に配信したい", itemId: "i1")
        XCTAssertEqual(ShannonTurnCapturePresentation.line(goal), "目的にしました：Shannon Deskを今月中に配信したい")
        XCTAssertEqual(ShannonTurnCapturePresentation.undoTitle(goal), "この目的を取り下げる")
        let notice = ShannonTurnCaptureDTO(id: "n1", kind: .notice, text: "時刻ちょうどにお知らせすることは、まだできません。")
        XCTAssertEqual(ShannonTurnCapturePresentation.line(notice), "時刻ちょうどにお知らせすることは、まだできません。")
        XCTAssertFalse(notice.canUndo)
        let done = ShannonTurnCaptureDTO(id: "c5", kind: .commitment, text: "病院に行く", itemId: "p5", status: "completed")
        XCTAssertEqual(ShannonTurnCapturePresentation.line(done), "完了した約束：病院に行く")
        XCTAssertFalse(done.canUndo)
    }

    func testHistoryFromOlderServersAndNewerKindsStillDecodes() throws {
        let older = #"{"id":"m1","role":"assistant","content":"はい","observedAt":"2026-09-24T01:00:00.000Z"}"#
        let message = try JSONDecoder().decode(StoredConversationMessageDTO.self, from: Data(older.utf8))
        XCTAssertNil(message.captures)
        XCTAssertNil(message.reminder)
        XCTAssertEqual(ShannonConversationModel.conversationMessage(message)?.captures, [])

        let newer = #"""
        {"id":"m2","role":"assistant","content":"はい","observedAt":"2026-09-24T01:00:00.000Z","sourceExperienceId":"turn-1",
         "captures":[{"id":"c","kind":"future-kind","text":"新しい種類","createdAt":"2026-09-24T01:00:00.000Z","status":"active"}],
         "reminder":{"commitmentId":"p1","state":"pending","text":"明日プレゼンの練習しよう"}}
        """#
        let decoded = try JSONDecoder().decode(StoredConversationMessageDTO.self, from: Data(newer.utf8))
        let converted = ShannonConversationModel.conversationMessage(decoded)
        XCTAssertEqual(converted?.turnID, "turn-1")
        XCTAssertEqual(converted?.captures.first?.kind, .notice)
        XCTAssertEqual(converted?.reminder?.offersActions, true)
        // A user message never carries a capture line, whatever the payload says.
        let user = #"{"id":"m3","role":"user","content":"x","observedAt":"2026-09-24T01:00:00.000Z","captures":[{"id":"c","kind":"notice","text":"x"}]}"#
        XCTAssertEqual(ShannonConversationModel.conversationMessage(
            try JSONDecoder().decode(StoredConversationMessageDTO.self, from: Data(user.utf8)))?.captures, [])
    }

    func testCapturesArriveAfterTheReplyWithoutReplacingMessages() async {
        let reply = ConversationMessage(role: .shannon, text: "わかりました。", turnID: "turn-1")
        let legacy = ConversationMessage(role: .shannon, text: "以前の返答")
        let client = CaptureClient()
        let model = ShannonConversationModel(
            client: client, messages: [ConversationMessage(role: .user, text: "明日病院に行く"), reply, legacy],
            usesDisplayCache: false
        )
        model.selectedThreadId = "thread"
        XCTAssertFalse(ShannonTurnCaptureList.hasContent(reply))

        await model.refreshCaptures()
        XCTAssertEqual(model.messages.map(\.captures.count), [0, 0, 0])

        await client.setCaptures([.init(turnId: "turn-1", captures: [CaptureClient.promise])])
        await model.refreshCaptures()
        XCTAssertEqual(model.messages[1].id, reply.id)
        XCTAssertEqual(model.messages[1].captures, [CaptureClient.promise])
        XCTAssertTrue(ShannonTurnCaptureList.hasContent(model.messages[1]))
        XCTAssertEqual(model.messages[2], legacy)

        // Once the owner forgets or cancels the item, the server stops returning it and the line goes away.
        await client.setCaptures([])
        await model.refreshCaptures()
        XCTAssertEqual(model.messages[1].captures, [])
        XCTAssertFalse(ShannonTurnCaptureList.hasContent(model.messages[1]))
    }

    func testCachedCapturesSurviveRelaunchThroughTheDisplayCache() throws {
        let message = ConversationMessage(
            role: .shannon, text: "わかりました。", turnID: "turn-1", captures: [CaptureClient.promise],
            reminder: ShannonReminderDTO(commitmentId: "p1", state: "pending", text: "約束")
        )
        let data = try JSONEncoder().encode(ShannonConversationCache.CachedMessage(message))
        let restored = try JSONDecoder().decode(ShannonConversationCache.CachedMessage.self, from: data).message
        XCTAssertEqual(restored.captures, [CaptureClient.promise])
        XCTAssertEqual(restored.turnID, "turn-1")
        XCTAssertEqual(restored.reminder?.commitmentId, "p1")
        // A cache written by an older build has none of the new keys.
        let legacy = #"{"id":"\#(UUID().uuidString)","role":"shannon","text":"x","sentAt":0,"deliveryState":"sent"}"#
        XCTAssertEqual(try JSONDecoder().decode(ShannonConversationCache.CachedMessage.self, from: Data(legacy.utf8)).message.captures, [])
    }

    func testUndoUsesTheExistingMemoryControlsForEachKind() async {
        let client = CaptureClient()
        let model = ShannonConversationModel(client: client, usesDisplayCache: false)
        model.selectedThreadId = "thread"
        let fact = ShannonTurnCaptureDTO(id: "k", kind: .knowledge, text: "紅茶が好き", itemId: "fact-1")
        let goal = ShannonTurnCaptureDTO(id: "g", kind: .intent, text: "配信したい", itemId: "intent-1")
        let notice = ShannonTurnCaptureDTO(id: "n", kind: .notice, text: "お知らせ")

        let promiseUndone = await model.undoCapture(CaptureClient.promise)
        let factUndone = await model.undoCapture(fact)
        let goalUndone = await model.undoCapture(goal)
        let noticeUndone = await model.undoCapture(notice)

        XCTAssertTrue(promiseUndone && factUndone && goalUndone)
        XCTAssertFalse(noticeUndone)
        let calls = await client.calls
        XCTAssertEqual(calls, ["memory:prospective-1:dismiss", "memory:fact-1:forget", "intent:intent-1:dismissed"])
        XCTAssertTrue(model.pendingCaptureActionIDs.isEmpty)
    }

    func testReminderActionsCompleteOrSnoozeAndReportAnOlderServerHonestly() async {
        let client = CaptureClient()
        let model = ShannonConversationModel(client: client, usesDisplayCache: false)
        model.selectedThreadId = "thread"
        let reminder = ShannonReminderDTO(commitmentId: "prospective-1", state: "pending", text: "明日プレゼンの練習しよう")

        let completed = await model.completeReminder(reminder)
        XCTAssertTrue(completed)
        await client.rejectNextMutation()
        let snoozed = await model.snoozeReminder(reminder)
        XCTAssertFalse(snoozed)
        XCTAssertEqual(model.captureActionError, "あとでに変更できませんでした。約束はそのまま残っています。")
        let calls = await client.calls
        XCTAssertEqual(calls, ["memory:prospective-1:complete", "memory:prospective-1:snooze"])

        XCTAssertNil(ShannonTurnCaptureList.reminderStatus(reminder))
        XCTAssertEqual(
            ShannonTurnCaptureList.reminderStatus(.init(commitmentId: "p", state: "completed", text: ""))?.text,
            "この約束は完了にしました"
        )
        XCTAssertNotNil(ShannonTurnCaptureList.reminderStatus(.init(commitmentId: "p", state: "snoozed", text: "")))
        let superseded = ConversationMessage(
            role: .shannon, text: "x", reminder: .init(commitmentId: "p", state: "superseded", text: "")
        )
        XCTAssertFalse(ShannonTurnCaptureList.hasContent(superseded))
    }
}

private actor CaptureClient: ShannonAPIClientProtocol {
    static let promise = ShannonTurnCaptureDTO(
        id: "capture-1", kind: .commitment, text: "病院に行く", itemId: "prospective-1", dueDate: "2026-09-25", status: "active"
    )
    private var turns: [ShannonConversationCapturesDTO.Turn] = []
    private var rejectNext = false
    private(set) var calls: [String] = []

    func setCaptures(_ turns: [ShannonConversationCapturesDTO.Turn]) { self.turns = turns }
    func rejectNextMutation() { rejectNext = true }

    func send(message: String, scopeKey: String, threadId: String?) async throws -> ChatResponseDTO {
        throw ShannonAPIError.invalidResponse
    }

    func loadConversationCaptures(scopeKey: String, threadId: String) async throws -> ShannonConversationCapturesDTO {
        ShannonConversationCapturesDTO(threadId: threadId, turns: turns)
    }

    func mutateMemory(
        scopeKey: String, memoryID: String, action: ShannonMemoryActionDTO, text: String?
    ) async throws -> ShannonMemoryDashboardDTO {
        calls.append("memory:\(memoryID):\(action.rawValue)")
        if rejectNext {
            rejectNext = false
            throw ShannonAPIError.rejected(status: 400)
        }
        return ShannonMemoryDashboardDTO(generatedAt: "now", items: [], sleepReports: [])
    }

    func updateCognitiveIntent(
        scopeKey: String, intentID: String, status: ShannonCognitiveIntentStatusDTO
    ) async throws -> ShannonCognitiveIntentDTO {
        calls.append("intent:\(intentID):\(status.rawValue)")
        return ShannonCognitiveIntentDTO(
            id: intentID, title: "配信したい", desiredOutcome: "配信したい", status: status, source: "explicit-user-goal",
            sourceExperienceId: nil, threadId: nil, nextStep: nil, planSteps: nil, linkedTaskId: nil, verifiedWork: nil,
            priority: 0.8, confidence: 0.9, createdAt: "2026-09-24T01:00:00Z", updatedAt: "2026-09-24T01:00:00Z"
        )
    }
}
