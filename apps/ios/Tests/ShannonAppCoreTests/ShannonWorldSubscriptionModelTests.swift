import XCTest
@testable import ShannonAppCore

@MainActor
final class ShannonWorldSubscriptionModelTests: XCTestCase {
    func testLoadsCandidateAndStartsTrialOnlyAfterApproval() async {
        let proposal = subscription(approval: .pending, status: .paused, updatedAt: "before")
        let approved = subscription(approval: .approved, status: .trial, updatedAt: "after")
        let source = worldSource()
        let client = WorldSubscriptionClient(sources: [source], subscriptions: [proposal], decisionResult: approved)
        let model = ShannonWorldSubscriptionModel(scopeKey: "owner-a", client: client)

        await model.reload()
        XCTAssertEqual(model.pendingCount, 1)
        XCTAssertEqual(model.summary, "新しい候補 1件")
        XCTAssertEqual(model.sources, [source])

        await model.decide(proposal, decision: .approve)
        XCTAssertEqual(model.pendingCount, 0)
        XCTAssertEqual(model.subscriptions.first?.status, .trial)
        let decision = await client.lastDecision
        XCTAssertEqual(decision?.scopeKey, "owner-a")
        XCTAssertEqual(decision?.id, proposal.id)
        XCTAssertEqual(decision?.decision, .approve)
        XCTAssertEqual(decision?.expectedUpdatedAt, "before")
    }

    func testStaleDecisionReloadsTheServerState() async {
        let proposal = subscription(approval: .pending, status: .paused, updatedAt: "before")
        let alreadyRejected = subscription(approval: .rejected, status: .rejected, updatedAt: "remote")
        let client = WorldSubscriptionClient(
            sources: [worldSource()],
            subscriptions: [proposal],
            decisionResult: alreadyRejected,
            decisionError: ShannonAPIError.rejected(status: 409),
            subscriptionsAfterDecision: [alreadyRejected]
        )
        let model = ShannonWorldSubscriptionModel(client: client)

        await model.reload()
        await model.decide(proposal, decision: .approve)

        XCTAssertEqual(model.subscriptions, [alreadyRejected])
        XCTAssertEqual(model.errorMessage, "この候補は別の端末で更新されました。最新状態を読み直しました。")
    }

    func testKeepsSubscriptionControlsAvailableWhenSourceHealthCannotLoad() async {
        let proposal = subscription(approval: .pending, status: .paused, updatedAt: "before")
        let client = WorldSubscriptionClient(
            sources: [],
            subscriptions: [proposal],
            decisionResult: proposal,
            sourceError: ShannonAPIError.rejected(status: 503)
        )
        let model = ShannonWorldSubscriptionModel(client: client)

        await model.reload()

        XCTAssertEqual(model.subscriptions, [proposal])
        XCTAssertEqual(model.pendingCount, 1)
        XCTAssertNotNil(model.errorMessage)
    }
}

private func worldSource() -> ShannonWorldSourceDTO {
    ShannonWorldSourceDTO(
        id: "hn:top",
        kind: .hackerNews,
        title: "Hacker News",
        url: "https://news.ycombinator.com/",
        enabled: true,
        intervalMinutes: 360,
        lastRunAt: "2026-09-11T00:00:00.000Z",
        nextRunAt: "2026-09-11T06:00:00.000Z",
        hasError: false,
        fetchedItemCount: 12,
        origin: .builtIn
    )
}

private func subscription(
    approval: ShannonWorldSubscriptionApprovalDTO,
    status: ShannonWorldSubscriptionStatusDTO,
    updatedAt: String
) -> ShannonWorldSubscriptionDTO {
    ShannonWorldSubscriptionDTO(
        id: "feed-1",
        feedURL: "https://example.com/feed.xml",
        title: "Example",
        status: status,
        approval: approval,
        reason: "Hacker Newsから見つけた",
        discoveredAt: "2026-09-11T00:00:00.000Z",
        trialExpiresAt: "2026-09-18T00:00:00.000Z",
        fetchedItemCount: 0,
        updatedAt: updatedAt
    )
}

private actor WorldSubscriptionClient: ShannonAPIClientProtocol {
    struct Decision: Sendable {
        let scopeKey: String
        let id: String
        let decision: ShannonWorldSubscriptionDecisionDTO
        let expectedUpdatedAt: String
    }

    private var currentSubscriptions: [ShannonWorldSubscriptionDTO]
    private let sources: [ShannonWorldSourceDTO]
    private let sourceError: (any Error)?
    private let decisionResult: ShannonWorldSubscriptionDTO
    private let decisionError: (any Error)?
    private let subscriptionsAfterDecision: [ShannonWorldSubscriptionDTO]?
    private(set) var lastDecision: Decision?

    init(
        sources: [ShannonWorldSourceDTO],
        subscriptions: [ShannonWorldSubscriptionDTO],
        decisionResult: ShannonWorldSubscriptionDTO,
        decisionError: (any Error)? = nil,
        subscriptionsAfterDecision: [ShannonWorldSubscriptionDTO]? = nil,
        sourceError: (any Error)? = nil
    ) {
        self.sources = sources
        self.sourceError = sourceError
        currentSubscriptions = subscriptions
        self.decisionResult = decisionResult
        self.decisionError = decisionError
        self.subscriptionsAfterDecision = subscriptionsAfterDecision
    }

    func send(message: String, scopeKey: String, threadId: String?) async throws -> ChatResponseDTO {
        throw ShannonAPIError.invalidResponse
    }

    func loadWorldSubscriptions(scopeKey: String) async throws -> [ShannonWorldSubscriptionDTO] {
        currentSubscriptions
    }

    func loadWorldSources(scopeKey: String) async throws -> [ShannonWorldSourceDTO] {
        if let sourceError { throw sourceError }
        return sources
    }

    func decideWorldSubscription(
        scopeKey: String,
        subscriptionID: String,
        decision: ShannonWorldSubscriptionDecisionDTO,
        expectedUpdatedAt: String
    ) async throws -> ShannonWorldSubscriptionDTO {
        lastDecision = Decision(
            scopeKey: scopeKey,
            id: subscriptionID,
            decision: decision,
            expectedUpdatedAt: expectedUpdatedAt
        )
        if let subscriptionsAfterDecision {
            currentSubscriptions = subscriptionsAfterDecision
        }
        if let decisionError { throw decisionError }
        currentSubscriptions = [decisionResult]
        return decisionResult
    }
}
