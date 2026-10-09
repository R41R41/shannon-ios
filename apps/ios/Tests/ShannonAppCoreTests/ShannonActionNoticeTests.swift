import Foundation
import Testing
@testable import ShannonAppCore

private actor NoticeClient: ShannonActionThreadsServing {
    var token: String? = "episode-one"
    var acknowledgedAt: String?
    var sends = 0
    var stopSends = 0
    var others = false
    var age: TimeInterval = 0
    var losesAnswer = false
    var accepts = true
    var held: CheckedContinuation<ShannonActionThreadsDTO, any Error>?
    var heldAnswer: ShannonActionThreadsDTO?
    var holdsAnswer = false
    func configure(others: Bool = false, age: TimeInterval = 0, losesAnswer: Bool = false, accepts: Bool = true, holdsAnswer: Bool = false) {
        self.others = others; self.age = age; self.losesAnswer = losesAnswer; self.accepts = accepts; self.holdsAnswer = holdsAnswer
    }
    func changeEpisode(_ token: String?) { self.token = token; acknowledgedAt = nil }
    func answer() -> ShannonActionThreadsDTO {
        let at = Date().addingTimeInterval(-age).formatted(.iso8601)
        return .init(availability: "ready", generatedAt: at, count: 0,
            threads: others ? [] : [.init(id: "unknown-one", kind: "ownTime", title: "自分の時間", origin: "own_time", state: "unknown", progress: nil, result: "model_result_unknown", updatedAt: at, failures: 0, canResume: false,
                notification: token.map { .init(id: $0, acknowledgedAt: acknowledgedAt) })], othersPresent: others)
    }
    func loadActionThreads(scopeKey: String, othersPresent: Bool) async throws -> ShannonActionThreadsDTO { answer() }
    func controlActionThread(scopeKey: String, id: String?, resume: Bool, requestID: String) async throws -> ShannonActionThreadsDTO { stopSends += 1; return answer() }
    func acknowledgeActionNotice(scopeKey: String, id: String, notificationID: String, requestID: String) async throws -> ShannonActionThreadsDTO {
        sends += 1
        if accepts && token == notificationID { acknowledgedAt = Date().formatted(.iso8601) }
        if losesAnswer { throw URLError(.timedOut) }
        if holdsAnswer { heldAnswer = answer(); return try await withCheckedThrowingContinuation { held = $0 } }
        return answer()
    }
    var isHolding: Bool { held != nil }
    func release() { if let heldAnswer { held?.resume(returning: heldAnswer) }; held = nil; heldAnswer = nil }
}

@Suite @MainActor struct ShannonActionNoticeTests {
    @Test func acknowledgingRemovesOnlyTheWarningAndPreservesTheUnknownRecord() async {
        let client = NoticeClient(), model = ShannonActionThreadsModel(scopeKey: "owner", client: client)
        await model.reload()
        #expect(model.capsuleText == ShannonGeneratedStrings.threadsUnknown)
        await model.acknowledgeNotice(id: "unknown-one", notificationID: "episode-one")
        #expect(model.capsuleText == ShannonGeneratedStrings.threadsRecords)
        #expect(model.showsCapsule)
        #expect(model.threads.first?.state == "unknown")
        #expect(model.threads.first?.result == "model_result_unknown")
        #expect(model.threads.first?.notification?.acknowledgedAt != nil)
        #expect(model.notice == ShannonGeneratedStrings.threadsNoticeAcknowledged)
        let sends = await client.sends, stopSends = await client.stopSends
        #expect(sends == 1); #expect(stopSends == 0)
        await client.changeEpisode("episode-two"); await model.reload()
        #expect(model.capsuleText == ShannonGeneratedStrings.threadsUnknown)
        #expect(model.threads.first?.notification?.acknowledgedAt == nil)
    }
    @Test func lostAcknowledgementResponseUsesOnlyOnePostAndReadsTheExactReceipt() async {
        let client = NoticeClient(), model = ShannonActionThreadsModel(scopeKey: "owner", client: client)
        await client.configure(losesAnswer: true); await model.reload()
        await model.acknowledgeNotice(id: "unknown-one", notificationID: "episode-one")
        let sends = await client.sends
        #expect(sends == 1); #expect(model.notice == ShannonGeneratedStrings.threadsNoticeAcknowledged)
        #expect(!model.controlPending)
    }
    @Test func uncertainDeliveryDoesNotHideAnUnacknowledgedUnknown() async {
        let client = NoticeClient(), model = ShannonActionThreadsModel(scopeKey: "owner", client: client)
        await client.configure(losesAnswer: true, accepts: false); await model.reload()
        await model.acknowledgeNotice(id: "unknown-one", notificationID: "episode-one")
        let sends = await client.sends
        #expect(sends == 1); #expect(model.notice == ShannonGeneratedStrings.threadsNoticeUnconfirmed)
        #expect(model.capsuleText == ShannonGeneratedStrings.threadsUnknown)
    }
    @Test func stalePrivateAndWrongEpisodeCannotPost() async {
        let client = NoticeClient(), model = ShannonActionThreadsModel(scopeKey: "owner", client: client)
        await client.configure(age: 60); await model.reload()
        await model.acknowledgeNotice(id: "unknown-one", notificationID: "episode-one")
        await client.configure(others: true); await model.reload()
        await model.acknowledgeNotice(id: "unknown-one", notificationID: "episode-one")
        await client.configure(); await model.reload()
        await model.acknowledgeNotice(id: "unknown-one", notificationID: "different-episode")
        let sends = await client.sends; #expect(sends == 0)
    }
    @Test func lateAcknowledgementCannotRestorePrivateContentOrConfirmANewEpisode() async throws {
        let client = NoticeClient(), model = ShannonActionThreadsModel(scopeKey: "owner", client: client)
        await client.configure(holdsAnswer: true); await model.reload()
        let pending = Task { await model.acknowledgeNotice(id: "unknown-one", notificationID: "episode-one") }
        for _ in 0..<100 {
            if await client.isHolding { break }
            try await Task.sleep(for: .milliseconds(1))
        }
        let held = await client.isHolding; #expect(held)
        await client.changeEpisode("episode-two"); await client.configure(); await model.reload()
        await client.release(); await pending.value
        #expect(model.capsuleText == ShannonGeneratedStrings.threadsUnknown)
        #expect(model.threads.first?.notification?.id == "episode-two")
        #expect(model.notice == ShannonGeneratedStrings.threadsNoticeUnconfirmed)
        await client.configure(holdsAnswer: true)
        let privatePending = Task { await model.acknowledgeNotice(id: "unknown-one", notificationID: "episode-two") }
        for _ in 0..<100 {
            if await client.isHolding { break }
            try await Task.sleep(for: .milliseconds(1))
        }
        model.reset(othersPresent: true); await client.release(); await privatePending.value
        #expect(model.threads.isEmpty); #expect(model.notice == nil)
    }
    @Test func oldServerKeepsTheWarningWithoutInventingAnAcknowledgement() async {
        let client = NoticeClient(), model = ShannonActionThreadsModel(scopeKey: "owner", client: client)
        await client.changeEpisode(nil); await model.reload()
        #expect(model.capsuleText == ShannonGeneratedStrings.threadsUnknown)
        await model.acknowledgeNotice(id: "unknown-one", notificationID: "episode-one")
        let sends = await client.sends; #expect(sends == 0)
    }
    @Test func oldDtoWithoutTheOptionalNoticeStillDecodes() throws {
        let data = Data(#"{"availability":"ready","generatedAt":"2026-10-11T01:00:00Z","count":0,"threads":[{"id":"one","kind":"ownTime","title":"自分の時間","origin":"own_time","state":"unknown","updatedAt":"2026-10-11T01:00:00Z","failures":0,"canResume":false}]}"#.utf8)
        let dto = try JSONDecoder().decode(ShannonActionThreadsDTO.self, from: data)
        #expect(dto.threads.first?.notification == nil)
        #expect(dto.threads.first?.hasUnacknowledgedNotice == true)
    }
}
