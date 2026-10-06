import XCTest
@testable import ShannonAppCore

@MainActor
final class ShannonAutonomyTests: XCTestCase {
    // MARK: Decoding the server contract

    func testDecodesTheOverviewTheServerSends() throws {
        let overview = try JSONDecoder().decode(ShannonAutonomyOverviewDTO.self, from: Data(overviewJSON.utf8))
        XCTAssertEqual(overview.control.state, "active")
        XCTAssertEqual(overview.control.stateLabel, "動いてよい状態")
        XCTAssertEqual(overview.budget.usedLabel, "120.50円 / 1,300円")
        XCTAssertEqual(overview.budget.fraction, 120.5 / 1_300, accuracy: 0.0001)
        XCTAssertEqual(overview.budgetRequest?.isPending, true)
        XCTAssertEqual(overview.pursuits.map(\.origin), ["seed", "seed", "self"])
        XCTAssertEqual(overview.pursuits[0].title, "人を感動させる物語を作ること")
        XCTAssertEqual(overview.pursuits[0].kindLabel, "目標")
        XCTAssertEqual(overview.pursuits[2].links, [ShannonPursuitLinkDTO(label: "下書き", url: "aether://study/draft-1")])
        XCTAssertEqual(overview.modelChoices.first?.modelLabel, "Gemini 3.8 Flash")
        XCTAssertEqual(overview.modelChoices.first?.chosenByLabel, "既定")
        XCTAssertEqual(overview.proposals.first?.coreAreaSummary, "基幹部分：感情・人格")
        XCTAssertEqual(overview.proposals.first?.origin, "shannon")
        XCTAssertEqual(overview.proposals.first?.isWaiting, true)
    }

    func testDecodesTheActivityRecordAndPresentsEachEntry() throws {
        let activity = try JSONDecoder().decode(ShannonAutonomyActivityDTO.self, from: Data(activityJSON.utf8))
        XCTAssertEqual(activity.control.stateLabel, "一時停止中")
        XCTAssertEqual(activity.days.map(\.dayKey), ["2026-10-02"])
        XCTAssertEqual(activity.days[0].summary, "したこと1件、承認が必要1件。使った費用は12.80円です。")
        let action = activity.days[0].entries[0]
        XCTAssertEqual(action.metadataLine, "シャノン ・ 考える・書く ・ した ・ gpt-5.6-luna ・ 12.80円")
        XCTAssertEqual(action.symbolName, "checkmark.circle")
        let proposal = activity.days[0].entries[1]
        XCTAssertEqual(proposal.metadataLine, "シャノン ・ 基幹部分 ・ 承認が必要 ・ 承認待ち")
        let pause = activity.days[0].entries[2]
        XCTAssertEqual(pause.metadataLine, "あなた ・ 設定と承認 ・ 一時停止")
        XCTAssertNil(pause.approvalLabel)
    }

    func testFormatsYenDaysAndState() {
        XCTAssertEqual(ShannonAutonomyFormat.yen(1_000), "1,000円")
        XCTAssertEqual(ShannonAutonomyFormat.yen(0), "0円")
        XCTAssertEqual(ShannonAutonomyFormat.yen(12.8), "12.80円")
        XCTAssertEqual(ShannonAutonomyFormat.dayTitle("2026-10-02"), "10月2日（金）")
        XCTAssertEqual(ShannonAutonomyFormat.dayTitle("broken"), "broken")
        let disabled = ShannonAutonomyControlDTO(state: "disabled", enabled: false, paused: false)
        XCTAssertEqual(disabled.stateLabel, "準備中")
        XCTAssertEqual(disabled.stateDetail, "自分から動く仕組みは、まだサーバーで有効になっていません。")
        let paused = ShannonAutonomyControlDTO(state: "paused", enabled: true, paused: true)
        XCTAssertTrue(paused.stateDetail.contains("会話・音声・記憶・あなたが始めた作業は、これまでどおり動きます"))
    }

    func testOwnerMayOnlyRestOrDropHerOwnOpenPursuits() {
        let seed = pursuit(id: "seed-goal-moving-story", origin: "seed", status: "active")
        let own = pursuit(id: "p1", origin: "self", status: "active")
        let resting = pursuit(id: "p2", origin: "self", status: "resting")
        let dropped = pursuit(id: "p3", origin: "conversation", status: "dropped")
        XCTAssertEqual([seed.ownerCanRest, seed.ownerCanDrop], [false, false])
        XCTAssertEqual([own.ownerCanRest, own.ownerCanDrop], [true, true])
        XCTAssertEqual([resting.ownerCanRest, resting.ownerCanDrop], [false, true])
        XCTAssertEqual([dropped.ownerCanRest, dropped.ownerCanDrop], [false, false])
    }

    // MARK: Model

    func testLoadsOverviewAndRecordAndSummarisesWhatWaits() async throws {
        let client = AutonomyClient(overview: try decodedOverview(), activity: try decodedActivity())
        let model = ShannonAutonomyModel(scopeKey: "owner-a", client: client)
        XCTAssertEqual(model.summary, "未取得")
        await model.loadIfNeeded()
        XCTAssertTrue(model.isSupported)
        XCTAssertEqual(model.waitingCount, 2)
        XCTAssertEqual(model.summary, "確認待ち 2件")
        XCTAssertEqual(model.featuredPursuits.count, 3)
        XCTAssertEqual(model.days.count, 1)
        XCTAssertNil(model.errorMessage)
        let scopes = await client.scopes
        XCTAssertEqual(scopes, ["owner-a", "owner-a"])
    }

    func testAnOlderServerHidesTheSurfacesInsteadOfShowingAnError() async {
        let client = AutonomyClient(overview: nil, activity: nil, loadError: ShannonAPIError.rejected(status: 404))
        let model = ShannonAutonomyModel(client: client)
        await model.reload()
        XCTAssertFalse(model.isSupported)
        XCTAssertNil(model.errorMessage)
        XCTAssertNil(model.overview)
        let detached = ShannonAutonomyModel(client: nil)
        await detached.reload()
        XCTAssertFalse(detached.isSupported)
    }

    func testAConnectionFailureKeepsTheSurfaceAndExplains() async {
        let client = AutonomyClient(overview: nil, activity: nil, loadError: ShannonAPIError.rejected(status: 503))
        let model = ShannonAutonomyModel(client: client)
        await model.reload()
        XCTAssertTrue(model.isSupported)
        XCTAssertEqual(model.errorMessage, "シャノンの活動を読み込めませんでした。接続を確認して、もう一度お試しください。")
    }

    func testThePauseSwitchChangesOnlyAfterTheServerStoredIt() async throws {
        let client = AutonomyClient(overview: try decodedOverview(), activity: try decodedActivity())
        let model = ShannonAutonomyModel(client: client)
        await model.reload()
        XCTAssertEqual(model.control?.paused, false)

        await client.failNextMutation()
        await model.setPaused(true)
        XCTAssertEqual(model.control?.paused, false)
        XCTAssertEqual(model.errorMessage, "一時停止を保存できませんでした。シャノンはまだ止まっていません。もう一度お試しください。")

        await model.setPaused(true)
        XCTAssertEqual(model.control?.paused, true)
        XCTAssertEqual(model.control?.stateLabel, "一時停止中")
        XCTAssertNil(model.errorMessage)
        XCTAssertEqual(model.summary, "確認待ち 2件")
        await model.setPaused(true) // already paused: no request
        let pauses = await client.pauses
        XCTAssertEqual(pauses, [true, true])
    }

    func testApprovesABudgetRequestWithTheChosenAmount() async throws {
        let client = AutonomyClient(overview: try decodedOverview(), activity: try decodedActivity())
        let model = ShannonAutonomyModel(client: client)
        await model.reload()
        let request = try XCTUnwrap(model.pendingBudgetRequest)
        await model.decideBudgetRequest(request, approve: true, amountYen: 300)
        let decision = await client.lastBudgetDecision
        XCTAssertEqual(decision?.requestID, "request-1")
        XCTAssertEqual(decision?.approve, true)
        XCTAssertEqual(decision?.amountYen, 300)
        XCTAssertNil(model.pendingBudgetRequest)
        XCTAssertEqual(model.overview?.budgetRequest?.statusLabel, "今日だけ300円増やしました")
        XCTAssertEqual(model.waitingCount, 1)
    }

    func testAConflictReloadsAndExplains() async throws {
        let client = AutonomyClient(overview: try decodedOverview(), activity: try decodedActivity())
        let model = ShannonAutonomyModel(client: client)
        await model.reload()
        let proposal = try XCTUnwrap(model.waitingProposals.first)
        await client.failNextMutation(with: ShannonAPIError.rejected(status: 409))
        await model.decideProposal(proposal, start: true)
        XCTAssertEqual(model.errorMessage, "この提案は別の端末で決められました。最新の状態を読み直しました。")
        XCTAssertNil(model.decidingID)
    }

    func testStartsAProposalOnlyOnTheOwnersDecision() async throws {
        let client = AutonomyClient(overview: try decodedOverview(), activity: try decodedActivity())
        let model = ShannonAutonomyModel(client: client)
        await model.reload()
        var proposalDecisions = await client.proposalDecisions
        XCTAssertTrue(proposalDecisions.isEmpty)
        let proposal = try XCTUnwrap(model.waitingProposals.first)
        await model.decideProposal(proposal, start: true)
        proposalDecisions = await client.proposalDecisions
        XCTAssertEqual(proposalDecisions.map(\.start), [true])
        XCTAssertTrue(model.waitingProposals.isEmpty)
    }

    func testNeverSendsAChangeForASeedOrClosedPursuit() async throws {
        let client = AutonomyClient(overview: try decodedOverview(), activity: try decodedActivity())
        let model = ShannonAutonomyModel(client: client)
        await model.reload()
        await model.setPursuit(model.pursuits[0], status: "dropped")
        await model.setPursuit(model.pursuits[0], status: "resting")
        await model.setPursuit(model.pursuits[2], status: "done")
        await model.setPursuit(model.pursuits[2], status: "active")
        var statuses = await client.pursuitStatuses
        XCTAssertTrue(statuses.isEmpty)
        await model.setPursuit(model.pursuits[2], status: "resting")
        statuses = await client.pursuitStatuses
        XCTAssertEqual(statuses.map(\.status), ["resting"])
        XCTAssertEqual(model.pursuits[2].status, "resting")
    }

    func testTheMemoryModelCarriesAutonomyOnlyForAClientThatServesIt() {
        XCTAssertFalse(ShannonMemoryModel(client: MemoryOnlyClient()).autonomy.isSupported)
        XCTAssertTrue(ShannonMemoryModel(client: ShannonAPIClient()).autonomy.isSupported)
    }

    // MARK: Requests

    func testClientSendsOwnerDecisionsToTheAutonomyRoutes() async throws {
        let baseURL = URL(string: "https://shannon.example/companion")!
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [AutonomyURLProtocol.self]
        // The stub answers off the main actor, so it holds its own copies of the fixtures.
        AutonomyURLProtocol.payloads = (overviewJSON, activityJSON)
        defer { AutonomyURLProtocol.reset() }
        let client = ShannonAPIClient(baseURL: baseURL, apiToken: "token", session: URLSession(configuration: configuration))

        _ = try await client.loadAutonomy(scopeKey: "owner")
        _ = try await client.loadAutonomyActivity(scopeKey: "owner", days: 14)
        _ = try await client.setAutonomyPaused(scopeKey: "owner", paused: true)
        _ = try await client.decideAutonomyBudgetRequest(scopeKey: "owner", requestID: "request-1", approve: true, amountYen: 300)
        _ = try await client.decideAutonomyBudgetRequest(scopeKey: "owner", requestID: "request-1", approve: false, amountYen: 300)
        _ = try await client.setShannonPursuitStatus(scopeKey: "owner", pursuitID: "p1", status: "resting")
        _ = try await client.decideShannonProposal(scopeKey: "owner", proposalID: "proposal-1", start: false)

        XCTAssertEqual(AutonomyURLProtocol.seen, [
            "GET /companion/v1/autonomy?scopeKey=owner",
            "GET /companion/v1/autonomy/activity?scopeKey=owner&days=14",
            "POST /companion/v1/autonomy/pause",
            "POST /companion/v1/autonomy/budget-requests/request-1/decision",
            "POST /companion/v1/autonomy/budget-requests/request-1/decision",
            "POST /companion/v1/autonomy/pursuits/p1/status",
            "POST /companion/v1/autonomy/proposals/proposal-1/decision",
        ])
        do {
            _ = try await client.setShannonPursuitStatus(scopeKey: "owner", pursuitID: "../pause", status: "resting")
            XCTFail("an identifier with a separator must not become a path")
        } catch {
            XCTAssertEqual(error as? ShannonAPIError, .invalidResponse)
        }
        XCTAssertEqual(AutonomyURLProtocol.seen.count, 7)
        XCTAssertEqual(AutonomyURLProtocol.bodies.count, 5)
        XCTAssertEqual(AutonomyURLProtocol.bodies[0]["paused"] as? Bool, true)
        XCTAssertEqual(AutonomyURLProtocol.bodies[1]["decision"] as? String, "approve")
        XCTAssertEqual(AutonomyURLProtocol.bodies[1]["amountYen"] as? Double, 300)
        XCTAssertEqual(AutonomyURLProtocol.bodies[2]["decision"] as? String, "decline")
        XCTAssertNil(AutonomyURLProtocol.bodies[2]["amountYen"])
        XCTAssertEqual(AutonomyURLProtocol.bodies[3]["status"] as? String, "resting")
        XCTAssertEqual(AutonomyURLProtocol.bodies[4]["decision"] as? String, "decline")
        XCTAssertTrue(AutonomyURLProtocol.bodies.allSatisfy { $0["scopeKey"] as? String == "owner" })
    }

    // MARK: Fixtures

    private func decodedOverview() throws -> ShannonAutonomyOverviewDTO {
        try JSONDecoder().decode(ShannonAutonomyOverviewDTO.self, from: Data(overviewJSON.utf8))
    }

    private func decodedActivity() throws -> ShannonAutonomyActivityDTO {
        try JSONDecoder().decode(ShannonAutonomyActivityDTO.self, from: Data(activityJSON.utf8))
    }

    private func pursuit(id: String, origin: String, status: String) -> ShannonPursuitDTO {
        ShannonPursuitDTO(id: id, kind: "work", title: "題名", why: "理由です。", status: status, origin: origin, createdAt: "a", updatedAt: "a")
    }
}

/// The shape `GET /v1/autonomy` returns (services/api/src/mind/action/ownTime/autonomyService.ts `AutonomyOverview`).
private let overviewJSON = """
{
  "control": { "state": "active", "enabled": true, "paused": false, "changedAt": null },
  "budget": { "dayKey": "2026-10-02", "baseCapYen": 1000, "extraYen": 300, "capYen": 1300, "spentYen": 120.5, "remainingYen": 1179.5, "exhausted": false, "yenPerUsd": 160 },
  "budgetRequest": { "id": "request-1", "dayKey": "2026-10-02", "reason": "第一稿を書き切りたいです", "requestedYen": 500, "status": "pending", "approvedYen": 0, "createdAt": "2026-10-02T01:00:00.000Z" },
  "maximumExtraYen": 3000,
  "pursuits": [
    { "id": "seed-goal-moving-story", "kind": "goal", "title": "人を感動させる物語を作ること", "why": "物語を通じて人間を知りたい、世界を知りたいからです。", "status": "active", "origin": "seed", "links": [], "createdAt": "2026-10-02T01:00:00.000Z", "updatedAt": "2026-10-02T01:00:00.000Z" },
    { "id": "seed-motive-know-people-and-world", "kind": "question", "title": "人間と世界を知りたい", "why": "これがボクの動機です。", "status": "active", "origin": "seed", "links": [], "createdAt": "2026-10-02T01:00:00.000Z", "updatedAt": "2026-10-02T01:00:00.000Z" },
    { "id": "p1", "kind": "work", "title": "雨の日の短い物語", "why": "雨の音から始まる話を書いてみたいからです。", "status": "active", "origin": "self", "links": [{ "label": "下書き", "url": "aether://study/draft-1" }], "createdAt": "2026-10-02T01:00:00.000Z", "updatedAt": "2026-10-02T01:00:00.000Z" }
  ],
  "modelChoices": [
    { "purpose": "prose", "purposeLabel": "日本語の文章", "modelId": "gemini-3.8-flash", "modelLabel": "Gemini 3.8 Flash", "chosenBy": "default", "recommendation": "日本語の文章にはGeminiを勧める、というのが持ち主の推奨です（品質は未検証）。" }
  ],
  "proposals": [
    { "id": "proposal-1", "origin": "shannon", "title": "感情の決め方を見直したい", "goal": "物語を読んだ後の気持ちが顔に出るようにする。", "reason": "読んで感じたことを覚えておきたいからです。", "coreAreas": ["emotion", "persona"], "coreAreaLabels": ["感情", "人格"], "status": "proposed", "createdAt": "2026-10-02T01:00:00.000Z" }
  ],
  "task": { "id": "ignored-extra-key" }
}
"""

/// The shape `GET /v1/autonomy/activity` returns.
private let activityJSON = """
{
  "control": { "state": "paused", "enabled": true, "paused": true, "changedAt": "2026-10-02T03:00:00.000Z" },
  "days": [
    { "dayKey": "2026-10-02", "summary": "したこと1件、承認が必要1件。使った費用は12.80円です。", "counts": { "done": 1, "needsApproval": 1, "refused": 0, "failed": 0 }, "costYen": 12.8, "entries": [
      { "id": "a3", "sequence": 3, "occurredAt": "2026-10-02T02:00:00.000Z", "dayKey": "2026-10-02", "kind": "action", "actor": "shannon", "summary": "物語の構成を三つ考えました。", "domain": "thinking", "domainLabel": "考える・書く", "model": "gpt-5.6-luna", "costYen": 12.8, "outcome": "done", "approval": "not_needed", "relatedId": "a0" },
      { "id": "a2", "sequence": 2, "occurredAt": "2026-10-02T01:30:00.000Z", "dayKey": "2026-10-02", "kind": "proposal", "actor": "shannon", "summary": "改修「感情の決め方を見直したい」を所有者に提案しました。", "detail": "読んで感じたことを覚えておきたいからです。", "domain": "core", "domainLabel": "基幹部分", "costYen": 0, "outcome": "needs_approval", "link": "shannon-proposal://proposal-1", "approval": "needed" },
      { "id": "a1", "sequence": 1, "occurredAt": "2026-10-02T01:00:00.000Z", "dayKey": "2026-10-02", "kind": "control", "actor": "owner", "summary": "所有者が自律活動を一時停止しました。", "domain": "system", "domainLabel": "設定と承認", "costYen": 0, "outcome": "paused", "approval": "not_needed" }
    ] }
  ]
}
"""

private actor AutonomyClient: ShannonAutonomyServing {
    struct BudgetDecision: Sendable { let requestID: String; let approve: Bool; let amountYen: Double? }
    struct ProposalDecision: Sendable { let proposalID: String; let start: Bool }
    struct PursuitStatus: Sendable { let pursuitID: String; let status: String }

    private var overview: ShannonAutonomyOverviewDTO?
    private let activity: ShannonAutonomyActivityDTO?
    private let loadError: (any Error)?
    private var mutationError: (any Error)?
    private(set) var scopes: [String] = []
    private(set) var pauses: [Bool] = []
    private(set) var lastBudgetDecision: BudgetDecision?
    private(set) var proposalDecisions: [ProposalDecision] = []
    private(set) var pursuitStatuses: [PursuitStatus] = []

    init(overview: ShannonAutonomyOverviewDTO?, activity: ShannonAutonomyActivityDTO?, loadError: (any Error)? = nil) {
        self.overview = overview
        self.activity = activity
        self.loadError = loadError
    }

    func failNextMutation(with error: any Error = ShannonAPIError.rejected(status: 503)) {
        mutationError = error
    }

    func loadAutonomy(scopeKey: String) async throws -> ShannonAutonomyOverviewDTO {
        scopes.append(scopeKey)
        if let loadError { throw loadError }
        guard let overview else { throw ShannonAPIError.invalidResponse }
        return overview
    }

    func loadAutonomyActivity(scopeKey: String, days: Int) async throws -> ShannonAutonomyActivityDTO {
        scopes.append(scopeKey)
        guard let activity else { throw ShannonAPIError.invalidResponse }
        return activity
    }

    func setAutonomyPaused(scopeKey: String, paused: Bool) async throws -> ShannonAutonomyOverviewDTO {
        pauses.append(paused)
        try takeMutationError()
        return try replace { current in
            ShannonAutonomyOverviewDTO(
                control: ShannonAutonomyControlDTO(state: paused ? "paused" : "active", enabled: true, paused: paused, changedAt: "now"),
                budget: current.budget, budgetRequest: current.budgetRequest, maximumExtraYen: current.maximumExtraYen,
                pursuits: current.pursuits, modelChoices: current.modelChoices, proposals: current.proposals
            )
        }
    }

    func decideAutonomyBudgetRequest(
        scopeKey: String, requestID: String, approve: Bool, amountYen: Double?
    ) async throws -> ShannonAutonomyOverviewDTO {
        lastBudgetDecision = BudgetDecision(requestID: requestID, approve: approve, amountYen: amountYen)
        try takeMutationError()
        return try replace { current in
            let request = current.budgetRequest.map {
                ShannonAutonomyBudgetRequestDTO(
                    id: $0.id, dayKey: $0.dayKey, reason: $0.reason, requestedYen: $0.requestedYen,
                    status: approve ? "approved" : "declined", approvedYen: approve ? (amountYen ?? $0.requestedYen) : 0,
                    createdAt: $0.createdAt, decidedAt: "now"
                )
            }
            return ShannonAutonomyOverviewDTO(
                control: current.control, budget: current.budget, budgetRequest: request, maximumExtraYen: current.maximumExtraYen,
                pursuits: current.pursuits, modelChoices: current.modelChoices, proposals: current.proposals
            )
        }
    }

    func setShannonPursuitStatus(scopeKey: String, pursuitID: String, status: String) async throws -> ShannonAutonomyOverviewDTO {
        pursuitStatuses.append(PursuitStatus(pursuitID: pursuitID, status: status))
        try takeMutationError()
        return try replace { current in
            ShannonAutonomyOverviewDTO(
                control: current.control, budget: current.budget, budgetRequest: current.budgetRequest,
                maximumExtraYen: current.maximumExtraYen,
                pursuits: current.pursuits.map {
                    $0.id == pursuitID
                        ? ShannonPursuitDTO(id: $0.id, kind: $0.kind, title: $0.title, why: $0.why, status: status, origin: $0.origin, links: $0.links, createdAt: $0.createdAt, updatedAt: "now")
                        : $0
                },
                modelChoices: current.modelChoices, proposals: current.proposals
            )
        }
    }

    func decideShannonProposal(scopeKey: String, proposalID: String, start: Bool) async throws -> ShannonAutonomyOverviewDTO {
        proposalDecisions.append(ProposalDecision(proposalID: proposalID, start: start))
        try takeMutationError()
        return try replace { current in
            ShannonAutonomyOverviewDTO(
                control: current.control, budget: current.budget, budgetRequest: current.budgetRequest,
                maximumExtraYen: current.maximumExtraYen, pursuits: current.pursuits, modelChoices: current.modelChoices,
                proposals: current.proposals.map {
                    ShannonAutonomyProposalDTO(
                        id: $0.id, title: $0.title, goal: $0.goal, reason: $0.reason, coreAreaLabels: $0.coreAreaLabels,
                        status: start ? "started" : "declined", taskId: start ? "task-1" : nil, createdAt: $0.createdAt, decidedAt: "now"
                    )
                }
            )
        }
    }

    private func takeMutationError() throws {
        if let error = mutationError {
            mutationError = nil
            throw error
        }
    }

    private func replace(_ change: (ShannonAutonomyOverviewDTO) -> ShannonAutonomyOverviewDTO) throws -> ShannonAutonomyOverviewDTO {
        guard let current = overview else { throw ShannonAPIError.invalidResponse }
        let next = change(current)
        overview = next
        return next
    }
}

private struct MemoryOnlyClient: ShannonMemoryServing {
    func loadMemories(scopeKey: String) async throws -> ShannonMemoryDashboardDTO { throw ShannonAPIError.invalidResponse }
    func mutateMemory(scopeKey: String, memoryID: String, action: ShannonMemoryActionDTO, text: String?) async throws -> ShannonMemoryDashboardDTO {
        throw ShannonAPIError.invalidResponse
    }
    func correctKnowledge(scopeKey: String, answerId: String, answer: String) async throws -> ShannonMemoryDashboardDTO {
        throw ShannonAPIError.invalidResponse
    }
}

private final class AutonomyURLProtocol: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var payloads: (overview: String, activity: String)?
    nonisolated(unsafe) static var seen: [String] = []
    nonisolated(unsafe) static var bodies: [[String: Any]] = []

    static func reset() {
        payloads = nil
        seen = []
        bodies = []
    }

    static func read(_ stream: InputStream) -> Data {
        stream.open()
        defer { stream.close() }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 4_096)
        while stream.hasBytesAvailable {
            let count = stream.read(&buffer, maxLength: buffer.count)
            if count <= 0 { break }
            data.append(buffer, count: count)
        }
        return data
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        do {
            guard let payloads = Self.payloads, let url = request.url else { throw ShannonAPIError.invalidResponse }
            Self.seen.append("\(request.httpMethod ?? "") \(url.path)\(url.query.map { "?\($0)" } ?? "")")
            if let body = request.httpBodyStream.map(Self.read) ?? request.httpBody,
               let json = try? JSONSerialization.jsonObject(with: body) as? [String: Any] {
                Self.bodies.append(json)
            }
            let data = Data((url.path.hasSuffix("/activity") ? payloads.activity : payloads.overview).utf8)
            let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil, headerFields: nil)!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        } catch {
            client?.urlProtocol(self, didFailWithError: error)
        }
    }

    override func stopLoading() {}
}
