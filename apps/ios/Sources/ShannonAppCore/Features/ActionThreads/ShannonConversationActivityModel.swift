import Foundation
import Observation

@MainActor @Observable
public final class ShannonConversationActivityModel {
    public enum State: Equatable { case loading, ready, recovering, unsupported, privateAudience }
    public private(set) var state: State = .loading
    public private(set) var reading: ShannonConversationActivityDTO?
    public private(set) var pendingID: String?
    public private(set) var notice: String?
    private let client: (any ShannonConversationActivityServing)?
    private let scopeKey: String
    private var generation = 0
    private var audienceGeneration = 0
    private var isFixture = false
    private var hasRead = false
    private var attemptedReports: Set<String> = []
    public init(scopeKey: String, client: (any ShannonConversationActivityServing)?) {
        self.scopeKey = scopeKey; self.client = client
        if client == nil { state = .unsupported }
    }
    public static func make(for conversation: ShannonConversationModel) -> ShannonConversationActivityModel {
        let model = ShannonConversationActivityModel(scopeKey: conversation.scopeKey, client: conversation.client as? any ShannonConversationActivityServing)
#if DEBUG
        if conversation.isDesignPreview, ProcessInfo.processInfo.arguments.contains("-ShannonPreviewNow") {
            model.isFixture = true; model.reading = fixture(); model.state = .ready
        }
#endif
        return model
    }
    public var tasks: [ShannonConversationActivityDTO.Task] { state == .privateAudience ? [] : reading?.tasks ?? [] }
    public var featured: ShannonConversationActivityDTO.Task? { tasks.first(where: \.isActive) ?? tasks.first }
    public var showsActivity: Bool { state == .privateAudience || !tasks.isEmpty || state == .recovering && reading != nil }
    public func isStale(at date: Date = .now) -> Bool {
        guard let text = reading?.generatedAt,
              let generated = (try? Date.ISO8601FormatStyle(includingFractionalSeconds: true).parse(text)) ?? (try? Date.ISO8601FormatStyle().parse(text)) else { return true }
        return date.timeIntervalSince(generated) > 15
    }
    public func reset(othersPresent: Bool, disconnected: Bool) {
        generation += 1; audienceGeneration += 1
        reading = nil; pendingID = nil; notice = nil
        hasRead = false
        state = othersPresent ? .privateAudience : disconnected || client == nil ? .unsupported : .loading
#if DEBUG
        if isFixture, !othersPresent, !disconnected { reading = Self.fixture(); state = .ready }
#endif
    }
    public func reload() async {
        guard state != .privateAudience else { return }
#if DEBUG
        if isFixture { reading = Self.fixture(); state = .ready; return }
#endif
        guard let client else { return }
        generation += 1
        let expected = generation, audience = audienceGeneration
        do {
            let answer = try await client.loadNow(scopeKey: scopeKey)
            guard expected == generation, audience == audienceGeneration, !Task.isCancelled else { return }
            if !hasRead { attemptedReports.formUnion(answer.tasks.compactMap { $0.report?.id }); hasRead = true }
            reading = answer; state = .ready
        } catch let error as ShannonAPIError where error == .rejected(status: 403) || error == .rejected(status: 404) {
            guard expected == generation, audience == audienceGeneration else { return }
            reading = nil; state = .unsupported
        } catch {
            guard expected == generation, audience == audienceGeneration, !Task.isCancelled else { return }
            state = .recovering
        }
    }
    public var speechKey: String { tasks.compactMap { $0.report?.id }.joined(separator: "|") }
    public func nextReport(threadID: String?, writtenAfter: Date? = nil) -> ShannonConversationActivityDTO.Task? {
        guard state == .ready, !isStale(), let threadID else { return nil }
        return tasks.first { task in
            task.origin == "owner_request" && task.sourceThreadId == threadID
                && task.report.map { report in
                    !attemptedReports.contains(report.id) && !report.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                        && (writtenAfter.map { report.wasWritten(since: $0) } ?? true)
                } == true
        }
    }
    public func reportIsCurrent(taskID: String, reportID: String, threadID: String?) -> Bool {
        state == .ready && !isStale() && tasks.contains {
            $0.id == taskID && $0.sourceThreadId == threadID && $0.report?.id == reportID
        }
    }
    public func markReportAttempted(_ id: String) { attemptedReports.insert(id) }
    /// Post once, then observe the original task. Neither lost results nor stops are replayed.
    public func command(task: ShannonConversationActivityDTO.Task, message: String? = nil) async {
        guard state == .ready, !isStale(), pendingID == nil,
              message != nil || task.canStop else { return }
        let text = message?.trimmingCharacters(in: .whitespacesAndNewlines)
        guard text == nil || text?.isEmpty == false else { return }
        let audience = audienceGeneration
        pendingID = task.id; notice = nil
        defer { if audience == audienceGeneration { pendingID = nil } }
#if DEBUG
        if isFixture { notice = "表示確認用です。サーバーへ送信しません。"; return }
#endif
        guard let client else { return }
        do {
            try await client.sendNowCommand(scopeKey: scopeKey, id: task.id, command: text == nil ? "stop" : "send", message: text, requestID: UUID().uuidString)
            guard audience == audienceGeneration else { return }
            notice = text == nil ? "停止を依頼しました。結果を確かめています。" : "追加の方針を届けました。"
            await reload()
        } catch {
            guard audience == audienceGeneration else { return }
            notice = "届いたか確かめています…"
            await reload()
            guard audience == audienceGeneration else { return }
            let result = tasks.first { $0.id == task.id }
            notice = text == nil && ["stopping", "stopped", "completed", "failed"].contains(result?.phase ?? "")
                ? "停止の依頼を確認しました。" : "届いたか確認できません。自動では送り直しません。"
        }
    }
#if DEBUG
    static func fixture() -> ShannonConversationActivityDTO {
        let now = Date().formatted(.iso8601)
        return .init(generatedAt: now, tasks: [
            .init(id: "research", parentId: nil, kind: "research", origin: "owner_request", title: "会話しながら使える音声UIを調べる", phase: "executing", summary: "公式の説明を比べています。会話はそのまま続けられます。", revision: 2, updatedAt: now, currentStep: "web.search", findings: [
                .init(id: "one", text: "会話の状態と、調査の状態を別々に表示します。", status: "confirmed", sources: [.init(title: "合成資料（表示確認用）", url: "https://example.com")], updatedAt: now),
                .init(id: "two", text: "途中の発見を伝える頻度は、まだ確認しています。", status: "unconfirmed", sources: [], updatedAt: now)]),
            .init(id: "child", parentId: "research", kind: "research", origin: "owner_request", title: "音声での途中報告を確認", phase: "waiting", summary: "比較資料の確認を待っています。", revision: 1, updatedAt: now)])
    }
#endif
}
