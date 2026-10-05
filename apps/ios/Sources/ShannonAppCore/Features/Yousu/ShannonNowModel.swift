import Foundation
import Observation

/// 「シャノンのいま」: what waits for the owner, how she feels, what she does in her own
/// time, whether her body is showing, and a quiet record of looks, touches and messages
/// she started. Each part is read on its own: one that is missing (an older server, a
/// switch that is off) leaves the others on the page.
@MainActor
@Observable
public final class ShannonNowModel {
    /// `GET /v1/shannon/now`. Nil until read, and when the server does not offer it.
    public private(set) var now: ShannonNowDTO?
    /// False when the server has no such read (404) or refuses it (403).
    public private(set) var nowIsAvailable = true
    public private(set) var ownTime: ShannonNowOwnTimeDTO?
    public private(set) var study: ShannonNowStudyDTO?
    /// The newest thing she did in her own time, from the activity record.
    public private(set) var latestActivity: ShannonAutonomyActivityEntryDTO?
    public private(set) var isLoading = false
    public private(set) var didLoad = false
    public private(set) var errorMessage: String?
    /// 「気分の推移」: read on its own when the page appears (a slow record never holds the page), and again when its switch changes.
    public let moodTrend: ShannonMoodTrendModel

    private let scopeKey: String
    private let client: (any ShannonYousuServing)?

    public init(scopeKey: String = "local-owner", client: (any ShannonYousuServing)? = ShannonAPIClient()) {
        self.scopeKey = scopeKey
        self.client = client
        moodTrend = ShannonMoodTrendModel(scopeKey: scopeKey, client: client)
    }

    public var timeline: [ShannonNowEvent] {
        now.map(ShannonNowText.timeline) ?? []
    }

    /// Stories that wait for a reaction, and her proposals and budget request that wait for a decision.
    public var waitingItems: [ShannonNowWaitingItem] {
        var items = (study?.pieces ?? []).filter(\.awaitingReaction).map { piece in
            ShannonNowWaitingItem(
                id: "piece-\(piece.id)", kind: .reaction,
                title: piece.title.flatMap { $0.isEmpty ? nil : $0 } ?? ShannonGeneratedStrings.yousuWaitingStoryFallback, detail: ShannonGeneratedStrings.yousuWaitingAwaitingReaction
            )
        }
        if let request = ownTime?.budgetRequest, request.isPending {
            items.append(.init(
                id: "budget-\(request.id)", kind: .decision,
                title: ShannonGeneratedStrings.yousuWaitingBudgetRequest(amount: ShannonAutonomyFormat.yen(request.requestedYen)), detail: ShannonGeneratedStrings.yousuWaitingDecideInAutonomy
            ))
        }
        items += (ownTime?.proposals ?? []).filter(\.isWaiting).map { proposal in
            ShannonNowWaitingItem(
                id: "proposal-\(proposal.id)", kind: .decision, title: proposal.title, detail: ShannonGeneratedStrings.yousuWaitingProposal
            )
        }
        return items
    }

    /// What waits for the owner, as one list: what she waits for, then work tasks that wait for a permission.
    /// The 「シャノン」 card, ようす, the 「シャノン」 tile and the top-left dot all count this one list.
    public func waiting(approvals: [ShannonNowWaitingItem]) -> [ShannonNowWaitingItem] {
        waitingItems + approvals
    }

    /// What she is doing in her own time: the server's own sentence for the owner.
    public var ownTimeLine: String? {
        guard let ownTime else { return nil }
        return ownTime.session?.label ?? ownTime.loop?.label ?? ownTime.control.stateLabel
    }

    /// Her reason for resting, in her own words, while she rests.
    public var restReason: String? {
        guard let session = ownTime?.session, session.state == "resting" else { return nil }
        return session.reason.flatMap { $0.isEmpty ? nil : $0 }
    }

    public func loadIfNeeded() async {
        guard !didLoad else { return }
        await reload()
    }

    public func reload() async {
        guard let client, !isLoading else { return }
        isLoading = true
        errorMessage = nil
        defer { isLoading = false }
        let scopeKey = scopeKey
        async let nowRead = Self.read { try await client.loadShannonNow(scopeKey: scopeKey) }
        async let ownTimeRead = Self.read { try await client.loadShannonOwnTime(scopeKey: scopeKey) }
        async let studyRead = Self.read { try await client.loadShannonStudyWaiting(scopeKey: scopeKey) }
        async let activityRead = Self.read { try await client.loadShannonRecentActivity(scopeKey: scopeKey) }
        let (nowResult, ownTimeResult, studyResult, activityResult) = await (nowRead, ownTimeRead, studyRead, activityRead)

        // The page went away mid-request: nothing was learned, nothing is claimed, and the next appearance reads again.
        if case .cancelled = nowResult { return }
        defer { didLoad = true }
        var failed = false
        switch nowResult {
        case .value(let value):
            now = value
            nowIsAvailable = true
        case .absent:
            // An older server, a switch that is off, or a device that is not the owner's: the parts are left out.
            now = nil
            nowIsAvailable = false
        case .failed:
            failed = true
        case .cancelled:
            break
        }
        switch ownTimeResult {
        case .value(let value): ownTime = value
        case .absent: ownTime = nil
        case .failed: failed = true
        case .cancelled: break
        }
        switch studyResult {
        case .value(let value): study = value
        case .absent: study = nil
        case .failed: failed = true
        case .cancelled: break
        }
        switch activityResult {
        case .value(let value):
            latestActivity = value.days.flatMap(\.entries).filter { $0.actor == "shannon" }.max { $0.occurredAt < $1.occurredAt }
        case .absent: latestActivity = nil
        case .failed, .cancelled: break
        }
        if failed {
            errorMessage = didLoad
                ? "読み直せないところがありました。前回の表示を残しています。"
                : "読み込めないところがありました。接続を確認して、もう一度お試しください。"
        }
    }

    private enum Read<Value: Sendable>: Sendable {
        case value(Value)
        /// The server does not offer this read to this device.
        case absent
        case failed
        case cancelled
    }

    private nonisolated static func read<Value: Sendable>(_ operation: @Sendable () async throws -> Value) async -> Read<Value> {
        do {
            return .value(try await operation())
        } catch let error as ShannonAPIError where error == .rejected(status: 404) || error == .rejected(status: 403) {
            return .absent
        } catch where ShannonOpsModel.isCancellation(error) {
            return .cancelled
        } catch {
            return .failed
        }
    }
}
