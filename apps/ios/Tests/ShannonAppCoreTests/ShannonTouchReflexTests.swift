import Foundation
import Testing
@testable import ShannonAppCore

@MainActor
struct ShannonTouchReflexTests {
    private let now = Date(timeIntervalSince1970: 1_791_504_000)
    private func directive(_ id: String = "one", gesture: String = "wave", expiry: String = "2099-01-01T00:00:00.000Z") -> ShannonTouchReflexDirective {
        .init(operationId: id, touchId: "touch", gesture: gesture, expiresAt: expiry)
    }

    @Test func invocationIsAcknowledgedOnceAndNeverClaimsPlaybackCompletion() async {
        let executor = ShannonTouchReflexExecutor()
        var count = 0
        let invoke: (String) async -> Bool? = { _ in count += 1; return true }
        #expect(await executor.perform(directive(), now: now, allowed: { true }, gestures: ["wave"], invoke: invoke) == .applied)
        #expect(await executor.perform(directive(), now: now, allowed: { true }, gestures: ["wave"], invoke: invoke) == .unknown)
        #expect(count == 1)
    }

    @Test func lostRendererAcknowledgementIsNeverReplayed() async {
        let executor = ShannonTouchReflexExecutor()
        var count = 0
        let invoke: (String) async -> Bool? = { _ in count += 1; return nil }
        #expect(await executor.perform(directive(), now: now, allowed: { true }, gestures: ["wave"], invoke: invoke) == .unknown)
        #expect(await executor.perform(directive(), now: now, allowed: { true }, gestures: ["wave"], invoke: invoke) == .unknown)
        #expect(count == 1)
    }

    @Test func expiredUnregisteredAndRevokedCommandsNeverReachTheRenderer() async {
        let executor = ShannonTouchReflexExecutor()
        var count = 0
        let invoke: (String) async -> Bool? = { _ in count += 1; return true }
        #expect(await executor.perform(directive("expired", expiry: "2000-01-01T00:00:00Z"), now: now, allowed: { true }, gestures: ["wave"], invoke: invoke) == .notApplied)
        #expect(await executor.perform(directive("unregistered", gesture: "other"), now: now, allowed: { true }, gestures: ["wave"], invoke: invoke) == .notApplied)
        #expect(await executor.perform(directive("revoked"), now: now, allowed: { false }, gestures: ["wave"], invoke: invoke) == .notApplied)
        #expect(count == 0)
    }

    @Test func onlyOneInvocationOwnsTheRendererWhileItsAcknowledgementIsPending() async {
        let executor = ShannonTouchReflexExecutor()
        var release: CheckedContinuation<Bool?, Never>?
        let first = Task { await executor.perform(directive(), now: now, allowed: { true }, gestures: ["wave"]) { _ in
            await withCheckedContinuation { release = $0 }
        } }
        while release == nil { await Task.yield() }
        var called = false
        #expect(await executor.perform(directive("second"), now: now, allowed: { true }, gestures: ["wave"]) { _ in called = true; return true } == .notApplied)
        #expect(!called)
        release?.resume(returning: true)
        #expect(await first.value == .applied)
    }
}

@MainActor
struct ShannonTouchReflexCoordinatorTests {
    @Test func reactionPresentationAndFinishedTouchDoNotWaitForReflexSelectionOrSpeakAgain() async throws {
        let client = TouchReflexClient(), effects = TouchReflexEffects()
        var environment = ShannonBodyTouchCoordinator.Environment(reportsTouch: { true }, capabilities: { (["smile"], ["wave"]) },
            express: { _, _ in effects.expressions += 1 })
        environment.invokeTouchGesture = { _ in effects.gestures += 1; return true }
        let coordinator = ShannonBodyTouchCoordinator(scopeKey: "owner", client: client, environment: environment)
        let touch = ShannonLive2DTouch(id: "one", occurredAt: "2026-10-09T00:00:00.000Z", kind: .pet, durationMs: 1500, strength: 0.5, ongoing: false)
        await coordinator.handle(.askReaction(touch))?.value
        #expect(effects.expressions == 1)
        await coordinator.handle(.touch(touch))?.value
        #expect(await client.events == 1)
        #expect(effects.gestures == 0)
        await client.release()
        for _ in 0..<1000 { if await client.reported { break }; await Task.yield() }
        #expect(await client.reported)
        #expect(effects.gestures == 1)
        #expect(effects.expressions == 1)
        #expect(await client.asks == 1)
    }
}

@MainActor private final class TouchReflexEffects { var expressions = 0; var gestures = 0 }
private actor TouchReflexClient: ShannonBodyServing {
    var events = 0, asks = 0
    var reported = false
    private var claimed = false, released = false
    private var waiter: CheckedContinuation<Void, Never>?
    func registerTouchBody(scopeKey: String, expressions: [String], gestures: [String]) async throws -> Int { 2 }
    func sendBodyTouches(scopeKey: String, events: [ShannonBodyTouchEventDTO]) async throws { self.events += events.count }
    func askBodyReaction(_ request: ShannonBodyReactionRequestDTO) async throws -> ShannonBodyReactionAnswerDTO {
        asks += 1
        return .init(id: request.id, status: "quiet", mood: .init(expression: "smile", feeling: nil))
    }
    func claimTouchReflex(scopeKey: String, touchId: String) async throws -> ShannonTouchReflexDirective? {
        guard !claimed else { return nil }; claimed = true
        if !released { await withCheckedContinuation { waiter = $0 } }
        return .init(operationId: "one", touchId: touchId, gesture: "wave", expiresAt: "2099-01-01T00:00:00.000Z")
    }
    func reportTouchReflex(scopeKey: String, operationId: String, outcome: ShannonTouchReflexOutcome) async throws { reported = outcome == .applied }
    func release() { released = true; waiter?.resume(); waiter = nil }
}
