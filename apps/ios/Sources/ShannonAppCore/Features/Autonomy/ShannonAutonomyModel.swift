import Foundation
import Observation

/// Owner-facing state of bounded autonomy: Shannon's own pursuits, the activity
/// record, the stop switch, today's budget, and what waits for the owner.
/// Every change is confirmed by the server before it is shown.
@MainActor
@Observable
public final class ShannonAutonomyModel {
    public private(set) var overview: ShannonAutonomyOverviewDTO?
    public private(set) var days: [ShannonAutonomyActivityDayDTO] = []
    public private(set) var isLoading = false
    public private(set) var isChangingPause = false
    public private(set) var decidingID: String?
    public private(set) var errorMessage: String?
    /// False when the server predates bounded autonomy; the surfaces then stay hidden.
    public private(set) var isSupported = true

    private let scopeKey: String
    private let client: (any ShannonAutonomyServing)?
    private var didLoad = false

    public init(scopeKey: String = "local-owner", client: (any ShannonAutonomyServing)? = ShannonAPIClient()) {
        self.scopeKey = scopeKey
        self.client = client
        if client == nil { isSupported = false }
    }

    public var control: ShannonAutonomyControlDTO? { overview?.control }

    public var pursuits: [ShannonPursuitDTO] { overview?.pursuits ?? [] }

    /// What the 頭の中 section shows first: open entries, seeds before her own.
    public var featuredPursuits: [ShannonPursuitDTO] {
        Array(pursuits.filter(\.isOpen).prefix(3))
    }

    public var waitingProposals: [ShannonAutonomyProposalDTO] {
        overview?.proposals.filter(\.isWaiting) ?? []
    }

    public var pendingBudgetRequest: ShannonAutonomyBudgetRequestDTO? {
        guard let request = overview?.budgetRequest, request.isPending else { return nil }
        return request
    }

    /// How many things wait for the owner's decision.
    public var waitingCount: Int {
        waitingProposals.count + (pendingBudgetRequest == nil ? 0 : 1)
    }

    /// One line for a settings or hub row.
    public var summary: String {
        guard let overview else { return isLoading ? "読み込み中…" : "未取得" }
        if waitingCount > 0 { return "確認待ち \(waitingCount)件" }
        if overview.control.state != "active" { return overview.control.stateLabel }
        return "今日 \(overview.budget.usedLabel)"
    }

    public func loadIfNeeded() async {
        guard !didLoad else { return }
        didLoad = true
        await reload()
    }

    public func reload() async {
        guard let client, !isLoading else { return }
        isLoading = true
        errorMessage = nil
        defer { isLoading = false }
        do {
            overview = try await client.loadAutonomy(scopeKey: scopeKey)
            isSupported = true
        } catch let error as ShannonAPIError where error == .rejected(status: 404) {
            // An older server has no such route. Nothing is shown rather than a permanent error.
            isSupported = false
            return
        } catch {
            errorMessage = "シャノンの活動を読み込めませんでした。接続を確認して、もう一度お試しください。"
            return
        }
        do {
            let activity = try await client.loadAutonomyActivity(scopeKey: scopeKey, days: 14)
            days = activity.days
        } catch {
            errorMessage = "したことの記録を読み込めませんでした。前回の表示はそのまま残しています。"
        }
    }

    /// The stop switch. The displayed state changes only after the server stored it.
    public func setPaused(_ paused: Bool) async {
        guard let client, !isChangingPause, overview?.control.paused != paused else { return }
        isChangingPause = true
        errorMessage = nil
        defer { isChangingPause = false }
        do {
            overview = try await client.setAutonomyPaused(scopeKey: scopeKey, paused: paused)
            await reloadActivity()
        } catch {
            errorMessage = paused
                ? "一時停止を保存できませんでした。シャノンはまだ止まっていません。もう一度お試しください。"
                : "一時停止の解除を保存できませんでした。もう一度お試しください。"
        }
    }

    public func decideBudgetRequest(_ request: ShannonAutonomyBudgetRequestDTO, approve: Bool, amountYen: Double? = nil) async {
        await decide(id: request.id, conflict: "このお願いは別の端末で決められたか、日付が変わりました。最新の状態を読み直しました。") { client in
            try await client.decideAutonomyBudgetRequest(
                scopeKey: self.scopeKey, requestID: request.id, approve: approve, amountYen: amountYen
            )
        }
    }

    public func decideProposal(_ proposal: ShannonAutonomyProposalDTO, start: Bool) async {
        await decide(id: proposal.id, conflict: "この提案は別の端末で決められました。最新の状態を読み直しました。") { client in
            try await client.decideShannonProposal(scopeKey: self.scopeKey, proposalID: proposal.id, start: start)
        }
    }

    /// The owner may only tell her to rest (`resting`) or drop (`dropped`) one of her own entries.
    public func setPursuit(_ pursuit: ShannonPursuitDTO, status: String) async {
        guard status == "resting" ? pursuit.ownerCanRest : status == "dropped" && pursuit.ownerCanDrop else { return }
        await decide(id: pursuit.id, conflict: "この項目は変更できませんでした。最新の状態を読み直しました。") { client in
            try await client.setShannonPursuitStatus(scopeKey: self.scopeKey, pursuitID: pursuit.id, status: status)
        }
    }

    public func dismissError() {
        errorMessage = nil
    }

    private func decide(
        id: String,
        conflict: String,
        _ operation: (any ShannonAutonomyServing) async throws -> ShannonAutonomyOverviewDTO
    ) async {
        guard let client, decidingID == nil else { return }
        decidingID = id
        errorMessage = nil
        defer { decidingID = nil }
        do {
            overview = try await operation(client)
            await reloadActivity()
        } catch let error as ShannonAPIError where error == .rejected(status: 409) {
            if let latest = try? await client.loadAutonomy(scopeKey: scopeKey) { overview = latest }
            errorMessage = conflict
        } catch {
            errorMessage = "保存できませんでした。変更は反映されていません。少し待ってもう一度お試しください。"
        }
    }

    private func reloadActivity() async {
        guard let client, let activity = try? await client.loadAutonomyActivity(scopeKey: scopeKey, days: 14) else { return }
        days = activity.days
    }
}
