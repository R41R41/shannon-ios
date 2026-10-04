import XCTest
@testable import ShannonAppCore

private final class FakeNowClient: ShannonYousuServing, @unchecked Sendable {
    var now: Result<ShannonNowDTO, Error> = .failure(ShannonAPIError.rejected(status: 404))
    var ownTime: Result<ShannonNowOwnTimeDTO, Error> = .failure(ShannonAPIError.rejected(status: 404))
    var study: Result<ShannonNowStudyDTO, Error> = .failure(ShannonAPIError.rejected(status: 404))

    func loadOps(scopeKey: String) async throws -> ShannonOpsReading { throw ShannonAPIError.rejected(status: 404) }
    func sendOpsCommand(scopeKey: String, idempotencyKey: String, type: ShannonOpsCommandType, target: String) async -> ShannonOpsSendOutcome { .unknownDelivery }
    func loadShannonNow(scopeKey: String) async throws -> ShannonNowDTO { try now.get() }
    func loadShannonOwnTime(scopeKey: String) async throws -> ShannonNowOwnTimeDTO { try ownTime.get() }
    func loadShannonStudyWaiting(scopeKey: String) async throws -> ShannonNowStudyDTO { try study.get() }
    func loadShannonRecentActivity(scopeKey: String) async throws -> ShannonAutonomyActivityDTO { throw ShannonAPIError.rejected(status: 404) }
    func opsReportScope(scopeKey: String) -> String? { nil }
}

final class ShannonYousuNowTests: XCTestCase {
    private func decode<Value: Decodable>(_ type: Value.Type, _ json: String) throws -> Value {
        try JSONDecoder().decode(type, from: Data(json.utf8))
    }

    private static let answer = """
    { "schemaVersion": 1, "generatedAt": "2026-10-03T07:00:00.000Z",
      "feeling": { "mood": { "expression": "calm" }, "present": { "expression": "joyful", "intensity": 0.62 },
        "lingering": [ { "expression": "sad", "strength": 0.3, "startedAt": "2026-10-03T05:00:00.000Z" },
                       { "expression": "a_face_of_a_later_server", "strength": 0.5, "startedAt": "2026-10-03T05:00:00.000Z" } ] },
      "body": { "known": true, "present": false, "lastReadAt": "2026-10-03T06:40:00.000Z", "freshSeconds": 75, "camera": false },
      "looks": [ { "id": "l1", "at": "2026-10-03T06:40:00.000Z", "askedBy": "owner", "surface": "body", "outcome": "seen" },
                 { "id": "l2", "at": "2026-10-03T04:05:00.000Z", "askedBy": "herself", "surface": "body", "outcome": "refused", "code": "camera_off" },
                 { "id": "l3", "at": "2026-10-02T04:05:00.000Z", "askedBy": "unknown", "surface": "app", "outcome": "an_outcome_of_a_later_server", "code": "a_code_of_a_later_server" },
                 { "broken": true } ],
      "touches": [ { "id": "t1", "at": "2026-10-03T06:12:00.000Z", "kind": "pet", "count": 2, "answered": true },
                   { "id": "t2", "at": "2026-10-03T06:00:00.000Z", "kind": "a_touch_of_a_later_server" } ],
      "reachOuts": [ { "id": "r1", "at": "2026-10-03T05:50:00.000Z", "reason": "share",
          "deliveries": [ { "surface": "body", "outcome": "spoken", "at": "2026-10-03T05:50:04.000Z" },
                          { "surface": "body", "outcome": "spoken", "at": "2026-10-03T05:50:05.000Z" },
                          { "surface": "app", "outcome": "read", "at": "2026-10-03T06:20:00.000Z" } ] },
        { "id": "r2", "at": "2026-10-03T03:00:00.000Z", "reason": "follow_up",
          "deliveries": [ { "surface": "earphones", "outcome": "spoken", "device": "iphone", "at": "x" }, { "surface": "call", "outcome": "an_outcome_of_a_later_server" },
                          { "surface": "a_surface_of_a_later_server" }, { "outcome": "no surface" } ] },
        { "id": "r3", "at": "2026-10-03T02:00:00.000Z", "deliveries": [] } ],
      "limits": { "items": 30, "days": 14 }, "a_field_of_a_later_server": { "x": 1 } }
    """

    func testTheAnswerDecodesWithValuesThisAppDoesNotKnow() throws {
        let now = try decode(ShannonNowDTO.self, Self.answer)
        XCTAssertEqual(now.feeling.mood?.face?.japaneseName, ShannonExpressionDTO.calm.japaneseName)
        XCTAssertEqual(now.feeling.present?.face?.expression, .joyful)
        XCTAssertEqual(now.feeling.lingering.count, 2)
        XCTAssertNil(now.feeling.lingering[1].face)
        XCTAssertEqual(now.looks.map(\.id), ["l1", "l2", "l3"])
        XCTAssertEqual(now.touches.count, 2)
        XCTAssertEqual(now.reachOuts[1].deliveries.count, 3)
        // An answer with nothing in it is an empty page, not an error.
        let empty = try decode(ShannonNowDTO.self, "{}")
        XCTAssertFalse(empty.body.known)
        XCTAssertTrue(ShannonNowText.timeline(empty).isEmpty)
    }

    func testTheTimelineMixesEverythingNewestFirstAndInventsNothing() throws {
        let events = ShannonNowText.timeline(try decode(ShannonNowDTO.self, Self.answer))
        XCTAssertEqual(events.map(\.id), ["look-l1", "touch-t1", "touch-t2", "reach-out-r1", "look-l2", "reach-out-r2", "reach-out-r3", "look-l3"])
        let byID = Dictionary(uniqueKeysWithValues: events.map { ($0.id, $0) })
        XCTAssertEqual(byID["look-l1"]?.title, "部屋を見た")
        XCTAssertEqual(byID["look-l1"]?.detail, "あなたの頼み")
        XCTAssertEqual(byID["look-l2"]?.title, "見るのを断った")
        XCTAssertEqual(byID["look-l2"]?.detail, "シャノンが見たくなって・カメラが切だった")
        // An outcome and a code of a later server: a neutral line, no reason made up.
        XCTAssertEqual(byID["look-l3"]?.title, "見ようとした")
        XCTAssertEqual(byID["look-l3"]?.detail, "アプリのカメラ")
        XCTAssertEqual(byID["touch-t1"]?.title, "撫でられた（2回）")
        XCTAssertEqual(byID["touch-t1"]?.detail, "ひとこと返した")
        XCTAssertEqual(byID["touch-t2"]?.title, "触れられた")
        XCTAssertNil(byID["touch-t2"]?.detail)
        // Two bodies that both spoke it are said once.
        XCTAssertEqual(byID["reach-out-r1"]?.title, "話しかけた")
        XCTAssertEqual(byID["reach-out-r1"]?.detail, "体の声で届いた・トークで読んだ")
        XCTAssertEqual(byID["reach-out-r2"]?.title, "もう一度話しかけた")
        XCTAssertEqual(byID["reach-out-r2"]?.detail, "イヤホンで届いた（iPhone）・電話・ほかの方法")
        XCTAssertEqual(byID["reach-out-r3"]?.detail, "届き方は、まだ分かりません")
    }

    func testDeliveryWording() {
        func label(_ surface: String, _ outcome: String?, _ device: String? = nil) -> String {
            ShannonNowText.deliveryLabel(.init(surface: surface, outcome: outcome, device: device))
        }
        XCTAssertEqual(label("body", "shown"), "体に表示された")
        XCTAssertEqual(label("body", "away"), "席を外していて、体では届かなかった")
        XCTAssertEqual(label("body", "hidden"), "体の窓が出ていなくて、届かなかった")
        XCTAssertEqual(label("body", "muted"), "体の「話しかける」が切で、届かなかった")
        XCTAssertEqual(label("body", "later"), "体")
        XCTAssertEqual(label("earphones", "spoken", "mac"), "イヤホンで届いた（Mac）")
        XCTAssertEqual(label("earphones", "spoken"), "イヤホンで届いた")
        // An outcome this app does not know is never worded as delivered.
        XCTAssertEqual(label("earphones", "missed"), "イヤホン")
        XCTAssertEqual(label("call", "answered"), "電話で届いた")
        XCTAssertEqual(label("call", "unanswered"), "電話に出なかった")
        XCTAssertEqual(label("call", "declined"), "電話を断った")
        XCTAssertEqual(label("call", "failed"), "電話がつながらなかった")
        XCTAssertEqual(label("call", "ringing"), "電話を鳴らしているところ")
        XCTAssertEqual(label("call", "an_outcome_of_a_later_server"), "電話")
    }

    func testFeelingAndBodyLines() throws {
        let now = Date(timeIntervalSince1970: 1_790_000_000)
        let iso = { (seconds: TimeInterval) in now.addingTimeInterval(-seconds).formatted(Date.ISO8601FormatStyle(includingFractionalSeconds: true)) }
        XCTAssertEqual(ShannonNowText.lingeringLabel(.init(expression: "sad", strength: 0.3, startedAt: iso(2 * 3600 + 60)), now: now),
                       "少し\(ShannonExpressionDTO.sad.japaneseName)（2時間前から）")
        XCTAssertEqual(ShannonNowText.lingeringLabel(.init(expression: "sad", strength: 0.7, startedAt: iso(3 * 86_400)), now: now),
                       "\(ShannonExpressionDTO.sad.japaneseName)（3日前から）")
        XCTAssertEqual(ShannonNowText.lingeringLabel(.init(expression: "joyful", feeling: "proud", strength: 0.7, startedAt: iso(10)), now: now), "得意げ")
        XCTAssertNil(ShannonNowText.lingeringLabel(.init(expression: "later", strength: 0.7), now: now))

        XCTAssertEqual(ShannonNowText.bodyLine(.init(known: false, present: false)), "デスクトップの体のようすは、まだ届いていません")
        XCTAssertEqual(ShannonNowText.bodyLine(.init(known: true, present: true)), "体はデスクトップに出ています")
        XCTAssertTrue(ShannonNowText.bodyLine(.init(known: true, present: false, lastReadAt: iso(600)), now: now).hasPrefix("体はいま、デスクトップに出ていません（最後は "))
        XCTAssertEqual(ShannonNowText.cameraLine(.init(known: true, present: true, camera: true)), "カメラ：見てよい")
        XCTAssertEqual(ShannonNowText.cameraLine(.init(known: true, present: true, camera: false)), "カメラ：切")
        XCTAssertNil(ShannonNowText.cameraLine(.init(known: true, present: true)))
        XCTAssertEqual(ShannonYousuTime.ago(iso(20), now: now), "たったいま")
        XCTAssertEqual(ShannonYousuTime.ago(iso(22 * 60), now: now), "22分前")
        XCTAssertEqual(ShannonNowText.dayTitle(iso(0), now: now), "今日")
    }

    @MainActor
    func testEachPartIsReadOnItsOwn() async throws {
        let client = FakeNowClient()
        let model = ShannonNowModel(scopeKey: "owner", client: client)
        // An older server, or a device that is not the owner's: the page has no such parts and no error.
        client.now = .failure(ShannonAPIError.rejected(status: 403))
        await model.reload()
        XCTAssertNil(model.now)
        XCTAssertFalse(model.nowIsAvailable)
        XCTAssertNil(model.errorMessage)
        XCTAssertTrue(model.timeline.isEmpty)
        XCTAssertTrue(model.waitingItems.isEmpty)

        client.now = .success(try decode(ShannonNowDTO.self, Self.answer))
        client.ownTime = .success(try decode(ShannonNowOwnTimeDTO.self, """
        { "control": { "state": "active", "enabled": true, "paused": false, "changedAt": null },
          "loop": { "state": "running", "label": "動いています" },
          "budget": { "dayKey": "2026-10-03", "baseCapYen": 1000, "extraYen": 0, "capYen": 1000, "spentYen": 420, "remainingYen": 580, "exhausted": false, "yenPerUsd": 150 },
          "budgetRequest": { "id": "b1", "dayKey": "2026-10-03", "reason": "r", "requestedYen": 200, "status": "pending", "approvedYen": 0, "createdAt": "x" },
          "proposals": [ { "id": "p1", "origin": "shannon", "title": "目次を作る", "goal": "g", "reason": "r", "status": "proposed", "createdAt": "x" },
                         { "id": "p2", "origin": "shannon", "title": "済み", "goal": "g", "reason": "r", "status": "started", "createdAt": "x" } ],
          "session": { "state": "resting", "label": "15:30まで休憩中", "until": "2026-10-03T06:30:00.000Z", "reason": "少し考えを寝かせたいです" },
          "maximumExtraYen": 500, "pursuits": [], "modelChoices": [] }
        """))
        client.study = .success(try decode(ShannonNowStudyDTO.self, """
        { "pieces": [ { "id": "s1", "title": "灯台と白い猫", "awaitingReaction": true }, { "id": "s2", "title": null, "awaitingReaction": false }, { "id": "s3" } ], "reactions": [] }
        """))
        await model.reload()
        XCTAssertTrue(model.nowIsAvailable)
        XCTAssertEqual(model.timeline.count, 8)
        XCTAssertEqual(model.ownTimeLine, "15:30まで休憩中")
        XCTAssertEqual(model.restReason, "少し考えを寝かせたいです")
        XCTAssertEqual(model.waitingItems.map(\.id), ["piece-s1", "budget-b1", "proposal-p1"])
        XCTAssertEqual(ShannonNowText.waitingSummary(model.waitingItems), "感想 1・判断 2")
        XCTAssertEqual(ShannonNowText.waitingSummary(model.waitingItems + [.init(id: "t", kind: .approval, title: "t", detail: "d")]), "感想 1・判断 2・許可 1")
        // One list for the card, ようす, the 「シャノン」 tile and the top-left dot: hers, then work waiting for a permission.
        let approval = ShannonNowWaitingItem(id: "t", kind: .approval, title: "t", detail: "d")
        XCTAssertEqual(model.waiting(approvals: [approval]).map(\.id), ["piece-s1", "budget-b1", "proposal-p1", "t"])
        XCTAssertEqual(model.waiting(approvals: []).count, 3)

        // A reading that was cancelled (the page went away) claims nothing.
        client.now = .failure(URLError(.cancelled))
        await model.reload()
        XCTAssertEqual(model.timeline.count, 8)
        XCTAssertNil(model.errorMessage)
        let fresh = ShannonNowModel(scopeKey: "owner", client: client)
        await fresh.reload()
        XCTAssertFalse(fresh.didLoad)
        XCTAssertNil(fresh.errorMessage)

        // A reading that fails keeps what was shown and says so.
        client.now = .failure(URLError(.timedOut))
        await model.reload()
        XCTAssertEqual(model.timeline.count, 8)
        XCTAssertNotNil(model.errorMessage)
    }

    func testLinks() {
        // ようす is シャノンのいま only; 運用 is 「設定 › 管理 › 運用」, also for the older link.
        XCTAssertEqual(ShannonYousuLink.request(from: URL(string: "shannon://yousu")!), .yousu)
        XCTAssertEqual(ShannonYousuLink.request(from: URL(string: "SHANNON://Yousu/Now")!), .yousu)
        XCTAssertEqual(ShannonYousuLink.request(from: URL(string: "shannon://yousu/ops")!), .ops)
        XCTAssertEqual(ShannonYousuLink.request(from: URL(string: "shannon://admin/ops")!), .ops)
        XCTAssertEqual(ShannonYousuLink.request(from: URL(string: "shannon://Admin/OPS")!), .ops)
        XCTAssertEqual(ShannonYousuLink.url(.ops).absoluteString, "shannon://admin/ops")
        XCTAssertEqual(ShannonYousuLink.request(from: ShannonYousuLink.url(.yousu)), .yousu)
        XCTAssertEqual(ShannonYousuLink.request(from: ShannonYousuLink.url(.ops)), .ops)
        // Anything else stays what it was: a pairing link, or nothing.
        for other in [
            "shannon://connect?code=ABCDEF012345", "shannon://yousu/other", "shannon://yousu/ops/extra", "https://yousu/ops",
            "shannon://pair/yousu", "shannon://admin", "shannon://admin/devices", "https://admin/ops",
        ] {
            XCTAssertNil(ShannonYousuLink.request(from: URL(string: other)!), other)
        }
    }

    func testALinkMakesItsPlaceSeenAndNeverClosesWhatItCannot() {
        typealias Route = ShannonLinkRoute
        let none = ShannonDialogueCovers(
            threadList: false, settings: false, callScreen: false, workTask: false,
            fileImporter: false, photoPicker: false, fromWords: false, cameraExplanation: false
        )
        func covers(_ change: (inout ShannonDialogueCovers) -> Void) -> ShannonDialogueCovers {
            var value = none
            change(&value)
            return value
        }
        func route(_ request: ShannonYousuLink.Request, _ covers: ShannonDialogueCovers, elsewhere: Bool = false, detail: Bool = false) -> Route {
            Route.make(request, covers: covers, callScreenElsewhere: elsewhere, settingsDetail: detail)
        }
        for request in [ShannonYousuLink.Request.yousu, .ops] {
            // A call screen, the root's or one shown from inside Settings, the thread list or a work task: wait.
            XCTAssertEqual(route(request, covers { $0.callScreen = true }), Route(waits: true))
            XCTAssertEqual(route(request, covers { $0.settings = true }, elsewhere: true), Route(waits: true))
            XCTAssertEqual(route(request, covers { $0.threadList = true }, elsewhere: true), Route(waits: true))
            XCTAssertEqual(route(request, covers { $0.workTask = true }, elsewhere: true), Route(waits: true))
            // Anything else up that a link cannot close: wait until it is gone. Every such cover, one at a time.
            for cover: WritableKeyPath<ShannonDialogueCovers, Bool> in [\.fileImporter, \.photoPicker, \.fromWords, \.cameraExplanation] {
                XCTAssertEqual(route(request, covers { $0[keyPath: cover] = true }), Route(waits: true))
            }
            // A page of Settings' own over it.
            XCTAssertEqual(route(request, covers { $0.settings = true }, detail: true), Route(waits: true))
        }
        // ようす is a page of the workspace: whatever the link may close, closes.
        XCTAssertEqual(route(.yousu, covers { $0.settings = true }), Route(closesSettings: true))
        XCTAssertEqual(
            route(.yousu, covers { $0.threadList = true; $0.workTask = true }), Route(closesThreadList: true, closesWorkTask: true)
        )
        XCTAssertEqual(route(.yousu, none), Route())
        // 運用 is in Settings: what is over the workspace gives way, and Settings comes up on the next try.
        XCTAssertEqual(route(.ops, covers { $0.workTask = true }), Route(closesWorkTask: true, opensAfterClosing: true))
        XCTAssertEqual(route(.ops, covers { $0.threadList = true }), Route(closesThreadList: true, opensAfterClosing: true))
        XCTAssertEqual(route(.ops, covers { $0.settings = true }), Route())
        XCTAssertEqual(route(.ops, none), Route())
    }

    func testAWaitingLinkIsDroppedOnceItIsAFewMinutesOld() {
        let start = Date(timeIntervalSince1970: 1_000)
        let link = ShannonDeferredLink(request: .ops, since: start)
        XCTAssertFalse(link.isStale(at: start.addingTimeInterval(ShannonDeferredLink.lifetime)))
        XCTAssertTrue(link.isStale(at: start.addingTimeInterval(ShannonDeferredLink.lifetime + 1)))
    }

    func testTheTilesAndTheTopLeftButtonSayWhatTheyMark() {
        XCTAssertEqual(ShannonThreadListDestination(title: "設定", symbol: "x", badge: nil, attention: true, action: {}).accessibilityLabel, "設定、確かめたいことがあります")
        XCTAssertEqual(
            ShannonThreadListDestination(title: "設定", symbol: "x", badge: nil, attention: true, attentionReason: "Notionが不調", action: {}).accessibilityLabel,
            "設定、運用：Notionが不調"
        )
        XCTAssertEqual(ShannonThreadListDestination(title: "設定", symbol: "x", badge: nil, action: {}).accessibilityLabel, "設定")
        XCTAssertEqual(ShannonThreadListDestination(title: "シャノン", symbol: "x", badge: 2, action: {}).accessibilityLabel, "シャノン、2件")
        XCTAssertEqual(ShannonEntryMarks.accessibilityValue(unread: 0, waiting: 0), "未確認なし")
        // A work task waiting for a permission and already unread is said once, as unread.
        let approval = ShannonNowWaitingItem(id: "task-1", kind: .approval, title: "t", detail: "d")
        let story = ShannonNowWaitingItem(id: "piece-1", kind: .reaction, title: "s", detail: "d")
        XCTAssertEqual(ShannonEntryMarks.waitingNotUnread([story, approval], unreadTaskIDs: ["task-1"]), 1)
        XCTAssertEqual(ShannonEntryMarks.waitingNotUnread([story, approval], unreadTaskIDs: []), 2)
        XCTAssertEqual(ShannonEntryMarks.waitingNotUnread([.init(id: "task-1", kind: .reaction, title: "s", detail: "d")], unreadTaskIDs: ["task-1"]), 1)
        XCTAssertEqual(
            ShannonEntryMarks.accessibilityValue(unread: 3, waiting: 1, opsAttention: "報告が届いていません"),
            "未確認3件、シャノンが待っていること1件、運用：報告が届いていません"
        )
    }

    func testATouchIsToldWithItsPartAndSurfaceWhenTheServerKnowsThem() throws {
        XCTAssertEqual(ShannonNowText.event(ShannonNowTouchDTO(id: "a", at: "t", kind: "poke", count: 2, phrase: "頬をつつかれた", place: "（iPhoneで）")).title, "頬をつつかれた（2回）（iPhoneで）")
        XCTAssertEqual(ShannonNowText.event(ShannonNowTouchDTO(id: "b", at: "t", kind: "pet", phrase: "頭をなでられた")).title, "頭をなでられた")
        XCTAssertEqual(ShannonNowText.event(ShannonNowTouchDTO(id: "c", at: "t", kind: "holdHand", place: "（Macで）")).title, "手をつないだ（Macで）")
        // An older server says neither: the words are what they were.
        XCTAssertEqual(ShannonNowText.event(ShannonNowTouchDTO(id: "d", at: "t", kind: "poke", count: 3)).title, "つつかれた（3回）")
        let json = #"{"id":"e","at":"2026-10-03T06:12:00.000Z","kind":"poke","count":1,"answered":false,"region":"face","surface":"iphone","phrase":"頬をつつかれた","place":"（iPhoneで）"}"#
        let decoded = try JSONDecoder().decode(ShannonNowTouchDTO.self, from: Data(json.utf8))
        XCTAssertEqual(decoded.phrase, "頬をつつかれた")
        XCTAssertEqual(decoded.place, "（iPhoneで）")
        let older = try JSONDecoder().decode(ShannonNowTouchDTO.self, from: Data(#"{"id":"f","at":"t","kind":"pet"}"#.utf8))
        XCTAssertNil(older.phrase)
    }
}
