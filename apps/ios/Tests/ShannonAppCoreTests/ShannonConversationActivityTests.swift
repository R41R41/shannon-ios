import Foundation
import Testing
@testable import ShannonAppCore

private actor ActivityClient: ShannonConversationActivityServing {
    var phase = "executing"
    var report: ShannonConversationActivityDTO.Report?
    var oldReport: ShannonConversationActivityDTO.Report?
    var sends = 0
    var loseSend = false
    var age: TimeInterval = 0
    var absent = false
    var hold = false
    var continuation: CheckedContinuation<ShannonConversationActivityDTO, any Error>?
    var isHeld: Bool { continuation != nil }
    func configure(hold: Bool = false, loseSend: Bool = false, age: TimeInterval = 0, absent: Bool = false) {
        self.hold = hold; self.loseSend = loseSend; self.age = age; self.absent = absent
    }
    func addReport() { report = .init(id: "report-one", text: "一次資料に異なる説明がありました。違いを確かめています。", updatedAt: Date().formatted(.iso8601)) }
    func prependOlderReport() { oldReport = .init(id: "old", text: "Previous call", updatedAt: Date().addingTimeInterval(-60).formatted(.iso8601)) }
    func answer() -> ShannonConversationActivityDTO {
        let now = Date().addingTimeInterval(-age).formatted(.iso8601)
        let current = ShannonConversationActivityDTO.Task(id: "task", parentId: nil, kind: "research", origin: "owner_request", title: "Private research", phase: phase, summary: "A summary is not a finding", revision: 1, updatedAt: now, sourceThreadId: "talk", report: report)
        let previous: [ShannonConversationActivityDTO.Task] = oldReport.map { [.init(id: "earlier", parentId: nil, kind: "research", origin: "owner_request", title: "Previous call", phase: "completed", summary: "", revision: 1, updatedAt: now, sourceThreadId: "talk", report: $0)] } ?? []
        return .init(generatedAt: now, tasks: previous + [current])
    }
    func loadNow(scopeKey: String) async throws -> ShannonConversationActivityDTO {
        if absent { throw ShannonAPIError.rejected(status: 404) }
        if hold { hold = false; return try await withCheckedThrowingContinuation { continuation = $0 } }
        return answer()
    }
    func release() { let held = continuation; continuation = nil; held?.resume(returning: answer()) }
    func sendNowCommand(scopeKey: String, id: String, command: String, message: String?, requestID: String) async throws {
        sends += 1; if command == "stop" { phase = "stopping" }
        if loseSend { throw URLError(.timedOut) }
    }
}

@MainActor struct ShannonConversationActivityTests {
    @Test func `late owner read cannot restore private material`() async throws {
        let client = ActivityClient(), model = ShannonConversationActivityModel(scopeKey: "owner", client: client)
        await client.configure(hold: true)
        let reading = Task { await model.reload() }
        for _ in 0..<100 { if await client.isHeld { break }; try await Task.sleep(for: .milliseconds(1)) }
        #expect(await client.isHeld)
        model.reset(othersPresent: true, disconnected: false)
        await client.release(); await reading.value
        #expect(model.state == .privateAudience); #expect(model.tasks.isEmpty)
        #expect(model.reading == nil)
    }
    @Test func `uncertain stop uses one POST and observes stopping`() async throws {
        let client = ActivityClient(), model = ShannonConversationActivityModel(scopeKey: "owner", client: client)
        await model.reload(); await client.configure(loseSend: true)
        let task = try #require(model.tasks.first)
        await model.command(task: task)
        #expect(await client.sends == 1)
        #expect(model.tasks.first?.phase == "stopping")
        #expect(model.notice == "停止の依頼を確認しました。")
    }
    @Test func `stale reports do not send a control`() async throws {
        let client = ActivityClient(), model = ShannonConversationActivityModel(scopeKey: "owner", client: client)
        await client.configure(age: 30); await model.reload()
        await model.command(task: try #require(model.tasks.first))
        #expect(await client.sends == 0)
    }
    @Test func `unsupported server hides only the new activity surface`() async {
        let client = ActivityClient(), model = ShannonConversationActivityModel(scopeKey: "owner", client: client)
        await client.configure(absent: true); await model.reload()
        #expect(model.state == .unsupported); #expect(!model.showsActivity)
    }
    @Test func `only a new canonical report from the call thread is spoken once`() async throws {
        let client = ActivityClient(), model = ShannonConversationActivityModel(scopeKey: "owner", client: client)
        await model.reload()
        #expect(model.nextReport(threadID: "talk") == nil)
        await client.addReport(); await model.reload()
        #expect(model.nextReport(threadID: "elsewhere") == nil)
        let report = try #require(model.nextReport(threadID: "talk")?.report)
        model.markReportAttempted(report.id)
        #expect(model.nextReport(threadID: "talk") == nil)
        model.reset(othersPresent: true, disconnected: false)
        #expect(!model.reportIsCurrent(taskID: "task", reportID: report.id, threadID: "talk"))
    }
    @Test func `old first report does not starve a later report from this call`() async throws {
        let client = ActivityClient(), model = ShannonConversationActivityModel(scopeKey: "owner", client: client)
        await model.reload()
        let started = Date().addingTimeInterval(-2)
        await client.prependOlderReport(); await client.addReport(); await model.reload()
        #expect(model.tasks.first?.id == "earlier")
        #expect(model.nextReport(threadID: "talk", writtenAfter: started)?.id == "task")
    }
    @Test func `first read never speaks historical report backlog`() async {
        let client = ActivityClient(), model = ShannonConversationActivityModel(scopeKey: "owner", client: client)
        await client.addReport(); await model.reload()
        #expect(model.nextReport(threadID: "talk") == nil)
    }
    @Test func `older task projection decodes without inventing findings`() throws {
        let json = #"{"generatedAt":"2026-10-10T00:00:00Z","tasks":[{"id":"one","parentId":null,"kind":"research","origin":"owner_request","title":"Research","phase":"executing","summary":"Working","revision":1,"updatedAt":"2026-10-10T00:00:00Z"}]}"#
        let reading = try JSONDecoder().decode(ShannonConversationActivityDTO.self, from: Data(json.utf8))
        #expect(reading.tasks.first?.findings == nil); #expect(reading.tasks.first?.report == nil)
    }
    @Test(arguments: ["javascript:alert(1)", "file:///private/key", "https://example.com/source"])
    func `source links only open public web URLs`(_ url: String) {
        let source = ShannonConversationActivityDTO.Source(title: "Source", url: url)
        #expect((source.webURL != nil) == url.hasPrefix("https://"))
    }
}

struct ShannonPersonaPresetTests {
    func defaults() -> UserDefaults { UserDefaults(suiteName: "ShannonPersonaPresetTests.\(UUID())")! }
    @Test func `legacy individual choices survive migration`() {
        let store = defaults()
        store.set("live2d", forKey: ShannonForm.storageKey)
        store.set("eyes", forKey: ShannonLive2DBody.storageKey)
        store.set("gemini", forKey: ShannonSpeechProvider.storageKey)
        #expect(ShannonPersonaPreset.current(defaults: store) == nil)
        #expect(ShannonForm.current(defaults: store) == .live2d)
        #expect(ShannonLive2DBody.current(defaults: store) == .eyes)
        #expect(ShannonSpeechProvider.current(defaults: store) == .gemini)
    }
    @Test(arguments: ShannonPersonaPreset.allCases)
    func `one key selects all appearance and next voice components`(_ mode: ShannonPersonaPreset) {
        let store = defaults(); mode.select(defaults: store)
        #expect(ShannonForm.current(defaults: store) == mode.form)
        #expect(ShannonLive2DBody.current(defaults: store) == .human)
        #expect(ShannonSpeechProvider.current(defaults: store) == mode.speechProvider)
        #expect(store.object(forKey: ShannonForm.storageKey) == nil)
        #expect(store.object(forKey: ShannonSpeechProvider.storageKey) == nil)
    }
    @Test func `changing voice alone retains active girl figure and icon`() {
        let store = defaults(); ShannonPersonaPreset.girl.select(defaults: store)
        ShannonPersonaPreset.selectIndividual(key: ShannonSpeechProvider.storageKey, value: "gemini", defaults: store)
        #expect(ShannonPersonaPreset.current(defaults: store) == nil)
        #expect(ShannonForm.current(defaults: store) == .live2d)
        #expect(ShannonLive2DBody.current(defaults: store) == .human)
        #expect(store.string(forKey: ShannonChatAvatarStyle.storageKey) == "expression")
        #expect(ShannonSpeechProvider.current(defaults: store) == .gemini)
    }
}
