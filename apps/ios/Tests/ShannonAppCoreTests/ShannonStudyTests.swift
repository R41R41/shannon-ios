import XCTest
@testable import ShannonAppCore

@MainActor
final class ShannonStudyTests: XCTestCase {
    // MARK: Decoding the server contract

    func testDecodesTheStudyListAndKeepsAnUnshownStoryTitleless() throws {
        let overview = try JSONDecoder().decode(ShannonStudyOverviewDTO.self, from: Data(studyJSON.utf8))
        XCTAssertEqual(overview.reactions.map(\.label), ["好き", "もう少し", "よく分からない"])
        let hidden = overview.pieces[0]
        XCTAssertTrue(hidden.hidden)
        XCTAssertNil(hidden.title)
        XCTAssertEqual(hidden.displayTitle, "作っているものがあります")
        XCTAssertEqual(hidden.symbolName, "lock.doc")
        let shown = overview.pieces[1]
        XCTAssertEqual(shown.displayTitle, "傘のある駅")
        XCTAssertEqual(shown.statusLine, "物語 ・ 見せた ・ 第2稿")
        let note = overview.pieces[2]
        XCTAssertEqual(note.statusLine, "メモ ・ 見せてもいい")
        XCTAssertEqual(note.symbolName, "note.text")
        let putAway = ShannonStudyPieceCardDTO(
            id: "x", kind: "story", kindLabel: "物語", status: "put_away", statusLabel: "しまった", hidden: true, updatedAt: "a"
        )
        XCTAssertEqual(putAway.displayTitle, "しまったものがあります")
    }

    func testDecodesAPieceWithItsVersionsSourcesAndFeedback() throws {
        let piece = try JSONDecoder().decode(ShannonStudyPieceDetailDTO.self, from: Data(pieceJSON.utf8))
        XCTAssertEqual(piece.title, "傘のある駅")
        XCTAssertEqual(piece.body, "駅のベンチに、だれかの傘が立てかけてあった。")
        XCTAssertEqual(piece.versions.map(\.changeNote), ["気配を書きました。", "終わりを足しました。"])
        XCTAssertEqual(piece.feedback.first?.statusLabel, "次に直す時に渡します")
        XCTAssertEqual(piece.card.statusLine, "物語 ・ 見せた ・ 第2稿")
        XCTAssertTrue(piece.canReact)
    }

    func testDecodesTheLoopStateAndFallsBackForAnOlderServer() throws {
        let overview = try JSONDecoder().decode(ShannonAutonomyOverviewDTO.self, from: Data(overviewWithLoopJSON.utf8))
        XCTAssertEqual(overview.stateLabel, "今日は予算を使い切りました")
        XCTAssertEqual(overview.stateSymbol, "yensign.circle")
        XCTAssertTrue(overview.stateDetail.contains("明日まで止まっています"))
        for (state, label) in [("preparing", "準備中"), ("running", "動いています"), ("paused", "一時停止中")] {
            let loop = ShannonAutonomyLoopDTO(state: state, label: label)
            XCTAssertFalse(loop.detail.isEmpty)
            XCTAssertFalse(loop.symbolName.isEmpty)
        }
        // A server without the loop sends no `loop`: the switch wording stays.
        let older = ShannonAutonomyOverviewDTO(
            control: ShannonAutonomyControlDTO(state: "disabled", enabled: false, paused: false),
            budget: ShannonAutonomyBudgetDTO(dayKey: "d", baseCapYen: 1_000, extraYen: 0, capYen: 1_000, spentYen: 0, remainingYen: 1_000, exhausted: false, yenPerUsd: 160)
        )
        XCTAssertEqual(older.stateLabel, "準備中")
        let entry = ShannonAutonomyActivityEntryDTO(
            id: "a", occurredAt: "t", dayKey: "d", kind: "action", actor: "shannon", summary: "メモを書きました。",
            domain: "aether_study", domainLabel: "Aetherの書斎", outcome: "done", link: "shannon-study://piece-1"
        )
        XCTAssertEqual(entry.studyPieceID, "piece-1")
        XCTAssertNil(ShannonAutonomyActivityEntryDTO(
            id: "b", occurredAt: "t", dayKey: "d", kind: "action", actor: "shannon", summary: "読みました。",
            domain: "public_read", domainLabel: "公開情報を読む", outcome: "done", link: "https://example.org/"
        ).studyPieceID)
    }

    func testAMessageCarriesTheLinkToAPieceThroughTheCache() throws {
        let stored = try JSONDecoder().decode(StoredConversationMessageDTO.self, from: Data("""
        { "id": "m1", "role": "assistant", "content": "ライ氏、短い物語を書きました。", "observedAt": "2026-10-02T01:00:00.000Z",
          "studyPiece": { "id": "piece-1", "title": "傘のある駅" } }
        """.utf8))
        XCTAssertEqual(stored.studyPiece, ShannonStudyPieceLinkDTO(id: "piece-1", title: "傘のある駅"))
        let message = ConversationMessage(role: .shannon, text: stored.content, studyPiece: stored.studyPiece)
        XCTAssertEqual(message.withDeliveryState(.sent).studyPiece?.id, "piece-1")
        XCTAssertEqual(message.with(captures: [], reminder: nil).studyPiece?.id, "piece-1")
        let cached = ShannonConversationCache.CachedMessage(message)
        let restored = try JSONDecoder().decode(
            ShannonConversationCache.CachedMessage.self, from: JSONEncoder().encode(cached)
        ).message
        XCTAssertEqual(restored.studyPiece, stored.studyPiece)
        // An older message has none.
        let plain = try JSONDecoder().decode(StoredConversationMessageDTO.self, from: Data("""
        { "id": "m2", "role": "assistant", "content": "こんにちは", "observedAt": "2026-10-02T01:00:00.000Z" }
        """.utf8))
        XCTAssertNil(plain.studyPiece)
    }

    // MARK: Model

    func testLoadsTheStudyAndGroupsIt() async throws {
        let client = StudyClient(overview: try decoded(ShannonStudyOverviewDTO.self, studyJSON), piece: try decoded(ShannonStudyPieceDetailDTO.self, pieceJSON))
        let model = ShannonStudyModel(scopeKey: "owner-a", client: client)
        XCTAssertEqual(model.summary, "まだありません")
        await model.loadIfNeeded()
        XCTAssertEqual(model.stories.count, 2)
        XCTAssertEqual(model.notes.count, 1)
        XCTAssertEqual(model.summary, "物語 2 ・ メモ 1")
        XCTAssertNil(model.errorMessage)
        await model.loadPiece("piece-2")
        XCTAssertEqual(model.details["piece-2"]?.body, "駅のベンチに、だれかの傘が立てかけてあった。")
    }

    func testAnOlderServerHidesTheStudy() async {
        let model = ShannonStudyModel(client: StudyClient(overview: nil, piece: nil, loadError: ShannonAPIError.rejected(status: 404)))
        await model.reload()
        XCTAssertFalse(model.isSupported)
        XCTAssertNil(model.errorMessage)
        XCTAssertFalse(ShannonStudyModel(client: nil).isSupported)
        let failing = ShannonStudyModel(client: StudyClient(overview: nil, piece: nil, loadError: ShannonAPIError.rejected(status: 503)))
        await failing.reload()
        XCTAssertTrue(failing.isSupported)
        XCTAssertEqual(failing.errorMessage, "書斎を読み込めませんでした。接続を確認して、もう一度お試しください。")
    }

    func testAReactionIsShownOnlyAfterTheServerStoredIt() async throws {
        let client = StudyClient(overview: try decoded(ShannonStudyOverviewDTO.self, studyJSON), piece: try decoded(ShannonStudyPieceDetailDTO.self, pieceJSON))
        let model = ShannonStudyModel(client: client)
        await model.reload()
        await model.loadPiece("piece-2")

        await client.failNextMutation()
        var stored = await model.react(to: "piece-2", reaction: "more", comment: "終わりが気になります。")
        XCTAssertFalse(stored)
        XCTAssertEqual(model.errorMessage, "感想を送れませんでした。保存されていません。少し待ってもう一度お試しください。")

        stored = await model.react(to: "piece-2", reaction: "more", comment: "  終わりが気になります。\n")
        XCTAssertTrue(stored)
        XCTAssertNil(model.errorMessage)
        var sent = await client.reactions
        XCTAssertEqual(sent.map(\.reaction), ["more"])
        XCTAssertEqual(sent.first?.comment, "終わりが気になります。")

        // A reaction without words is sent without a comment; one that is too long is not sent at all.
        _ = await model.react(to: "piece-2", reaction: "like", comment: "   ")
        sent = await client.reactions
        XCTAssertEqual(sent.count, 2)
        XCTAssertNil(sent[1].comment)
        stored = await model.react(to: "piece-2", reaction: "like", comment: String(repeating: "あ", count: 401))
        XCTAssertFalse(stored)
        XCTAssertEqual(model.errorMessage, "感想は400文字までです。")
        sent = await client.reactions
        XCTAssertEqual(sent.count, 2)
    }

    func testAskingHerToPutAPieceAwayUpdatesTheList() async throws {
        let client = StudyClient(overview: try decoded(ShannonStudyOverviewDTO.self, studyJSON), piece: try decoded(ShannonStudyPieceDetailDTO.self, pieceJSON))
        let model = ShannonStudyModel(client: client)
        await model.reload()
        await model.putAway("piece-2")
        XCTAssertEqual(model.details["piece-2"]?.status, "put_away")
        XCTAssertEqual(model.putAway.map(\.id), ["piece-2"])
        XCTAssertEqual(model.stories.map(\.id), ["piece-1"])
        let ids = await client.putAwayIDs
        XCTAssertEqual(ids, ["piece-2"])
    }

    func testTheAutonomyModelCarriesTheStudyOnlyForAClientThatServesIt() {
        XCTAssertTrue(ShannonAutonomyModel(client: ShannonAPIClient()).study.isSupported)
        XCTAssertFalse(ShannonAutonomyModel(client: nil).study.isSupported)
    }

    // MARK: Requests

    func testClientReadsReactsAndAsksButHasNoCallThatWritesHerText() async throws {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StudyURLProtocol.self]
        StudyURLProtocol.payloads = (studyJSON, pieceJSON)
        defer { StudyURLProtocol.reset() }
        let client = ShannonAPIClient(
            baseURL: URL(string: "https://shannon.example/companion")!, apiToken: "token", session: URLSession(configuration: configuration)
        )
        _ = try await client.loadStudy(scopeKey: "owner")
        _ = try await client.loadStudyPiece(scopeKey: "owner", pieceID: "piece-2")
        _ = try await client.reactToStudyPiece(scopeKey: "owner", pieceID: "piece-2", reaction: "unclear", comment: "最後が分かりませんでした。")
        _ = try await client.reactToStudyPiece(scopeKey: "owner", pieceID: "piece-2", reaction: "like", comment: nil)
        _ = try await client.putAwayStudyPiece(scopeKey: "owner", pieceID: "piece-2")
        XCTAssertEqual(StudyURLProtocol.seen, [
            "GET /companion/v1/autonomy/study?scopeKey=owner",
            "GET /companion/v1/autonomy/study/pieces/piece-2?scopeKey=owner",
            "POST /companion/v1/autonomy/study/pieces/piece-2/reaction",
            "POST /companion/v1/autonomy/study/pieces/piece-2/reaction",
            "POST /companion/v1/autonomy/study/pieces/piece-2/put-away",
        ])
        XCTAssertEqual(StudyURLProtocol.bodies[0]["reaction"] as? String, "unclear")
        XCTAssertEqual(StudyURLProtocol.bodies[0]["comment"] as? String, "最後が分かりませんでした。")
        XCTAssertNil(StudyURLProtocol.bodies[1]["comment"])
        XCTAssertEqual(Set(StudyURLProtocol.bodies[2].keys), ["scopeKey"])
        do {
            _ = try await client.loadStudyPiece(scopeKey: "owner", pieceID: "../../pause")
            XCTFail("an identifier with a separator must not become a path")
        } catch {
            XCTAssertEqual(error as? ShannonAPIError, .invalidResponse)
        }
    }

    private func decoded<Value: Decodable>(_ type: Value.Type, _ json: String) throws -> Value {
        try JSONDecoder().decode(type, from: Data(json.utf8))
    }
}

private actor StudyClient: ShannonStudyServing {
    private let overview: ShannonStudyOverviewDTO?
    private var piece: ShannonStudyPieceDetailDTO?
    private let loadError: Error?
    private var failsNextMutation = false
    private(set) var reactions: [(reaction: String, comment: String?)] = []
    private(set) var putAwayIDs: [String] = []

    init(overview: ShannonStudyOverviewDTO?, piece: ShannonStudyPieceDetailDTO?, loadError: Error? = nil) {
        self.overview = overview
        self.piece = piece
        self.loadError = loadError
    }

    func failNextMutation() { failsNextMutation = true }

    func loadStudy(scopeKey: String) async throws -> ShannonStudyOverviewDTO {
        if let loadError { throw loadError }
        guard let overview else { throw ShannonAPIError.invalidResponse }
        return overview
    }

    func loadStudyPiece(scopeKey: String, pieceID: String) async throws -> ShannonStudyPieceDetailDTO {
        guard let piece else { throw ShannonAPIError.rejected(status: 404) }
        return piece
    }

    func reactToStudyPiece(scopeKey: String, pieceID: String, reaction: String, comment: String?) async throws -> ShannonStudyPieceDetailDTO {
        if failsNextMutation { failsNextMutation = false; throw ShannonAPIError.rejected(status: 503) }
        reactions.append((reaction, comment))
        guard let piece else { throw ShannonAPIError.invalidResponse }
        return piece
    }

    func putAwayStudyPiece(scopeKey: String, pieceID: String) async throws -> ShannonStudyPieceDetailDTO {
        putAwayIDs.append(pieceID)
        guard let piece else { throw ShannonAPIError.invalidResponse }
        let away = try JSONDecoder().decode(ShannonStudyPieceDetailDTO.self, from: Data(
            pieceJSON.replacingOccurrences(of: "\"status\": \"shown\"", with: "\"status\": \"put_away\"").utf8
        ))
        self.piece = away
        return away.id == piece.id ? away : piece
    }
}

private final class StudyURLProtocol: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var payloads = ("", "")
    nonisolated(unsafe) static var seen: [String] = []
    nonisolated(unsafe) static var bodies: [[String: Any]] = []

    static func reset() {
        seen = []
        bodies = []
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let url = request.url!
        let method = request.httpMethod ?? "GET"
        Self.seen.append("\(method) \(url.path)\(method == "GET" ? "?\(url.query ?? "")" : "")")
        if method == "POST" {
            var data = request.httpBody ?? Data()
            if data.isEmpty, let stream = request.httpBodyStream {
                stream.open()
                var buffer = [UInt8](repeating: 0, count: 4_096)
                while stream.hasBytesAvailable {
                    let count = stream.read(&buffer, maxLength: buffer.count)
                    if count <= 0 { break }
                    data.append(buffer, count: count)
                }
                stream.close()
            }
            Self.bodies.append((try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:])
        }
        let body = url.path.hasSuffix("/study") ? Self.payloads.0 : Self.payloads.1
        let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil, headerFields: ["content-type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

/// The shape `GET /v1/autonomy/study` returns (services/api/src/mind/action/ownTime/studyDesk.ts `StudyOverview`).
private let studyJSON = """
{
  "pieces": [
    { "id": "piece-1", "kind": "story", "kindLabel": "物語", "status": "draft", "statusLabel": "下書き", "hidden": true, "title": null, "excerpt": null, "version": null, "revising": false, "updatedAt": "2026-10-02T03:00:00.000Z" },
    { "id": "piece-2", "kind": "story", "kindLabel": "物語", "status": "shown", "statusLabel": "見せた", "hidden": false, "title": "傘のある駅", "excerpt": "駅のベンチに、だれかの傘が…", "version": 2, "revising": false, "updatedAt": "2026-10-02T02:00:00.000Z" },
    { "id": "piece-3", "kind": "note", "kindLabel": "メモ", "status": "ready", "statusLabel": "見せてもいい", "hidden": false, "title": "夕方の駅が懐かしい理由", "excerpt": "光の色と人の少なさが…", "version": 1, "revising": false, "updatedAt": "2026-10-02T01:00:00.000Z" }
  ],
  "reactions": [{ "id": "like", "label": "好き" }, { "id": "more", "label": "もう少し" }, { "id": "unclear", "label": "よく分からない" }]
}
"""

/// The shape `GET /v1/autonomy/study/pieces/{id}` returns (`StudyPieceDetail`).
private let pieceJSON = """
{
  "id": "piece-2", "kind": "story", "kindLabel": "物語", "status": "shown", "statusLabel": "見せた", "hidden": false,
  "title": "傘のある駅", "excerpt": "駅のベンチに、だれかの傘が…", "version": 2, "revising": false, "updatedAt": "2026-10-02T02:00:00.000Z",
  "body": "駅のベンチに、だれかの傘が立てかけてあった。",
  "sources": [],
  "versions": [
    { "version": 1, "changeNote": "気配を書きました。", "createdAt": "2026-10-02T01:00:00.000Z" },
    { "version": 2, "changeNote": "終わりを足しました。", "createdAt": "2026-10-02T02:00:00.000Z" }
  ],
  "feedback": [{ "id": "f1", "version": 1, "reaction": "like", "reactionLabel": "好き", "comment": "傘がいいです。", "createdAt": "2026-10-02T01:30:00.000Z", "used": false }],
  "canReact": true, "canPutAway": true
}
"""

private let overviewWithLoopJSON = """
{
  "control": { "state": "active", "enabled": true, "paused": false, "changedAt": null },
  "loop": { "state": "budget_exhausted", "label": "今日は予算を使い切りました", "heartbeatAt": "2026-10-02T01:00:00.000Z" },
  "budget": { "dayKey": "2026-10-02", "baseCapYen": 1000, "extraYen": 0, "capYen": 1000, "spentYen": 1000, "remainingYen": 0, "exhausted": true, "yenPerUsd": 160 },
  "budgetRequest": null, "maximumExtraYen": 3000, "pursuits": [], "modelChoices": [], "proposals": []
}
"""
