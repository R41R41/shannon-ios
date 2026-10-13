import Foundation
import Observation

/// 「ようす › 目標」 and 「ようす › 点検」 (Syzygy ADR-0009 stage 2, E7; owner 2026-10-13, comparison page §5 option A). Each part
/// is read on its own: a part the server does not offer yet (404, 403) says 「準備中」, and any other failure keeps the last
/// good answer with 「読めませんでした」. The owner's three controls (完了を認める・休める・やめる) are sent once per confirmed
/// press and never retried; after any of them the list is read again.
@MainActor
@Observable
public final class ShannonExecutiveModel {
    public enum Phase: Equatable, Sendable {
        case loading
        case loaded
        /// The server does not offer it yet: 「準備中」.
        case notReady
        /// The last read failed; the last good answer, if any, is kept.
        case unreadable
    }

    public enum GoalAction: Equatable, Sendable {
        case confirm, rest, drop

        var status: String {
            switch self {
            case .confirm: "done"
            case .rest: "resting"
            case .drop: "dropped"
            }
        }
    }

    /// 最近えらんだこと covers this many days.
    public static let choiceDays = 7
    /// At most this many choices are listed.
    public static let choiceLimit = 20

    public private(set) var goals: ShannonGoalsDTO?
    public private(set) var goalsPhase: Phase = .loading
    public private(set) var choices: ShannonChoicesDTO?
    public private(set) var choicesPhase: Phase = .loading
    public private(set) var capabilities: ShannonCapabilitiesDTO?
    public private(set) var capabilitiesPhase: Phase = .loading
    public private(set) var inspection: ShannonInspectionDTO?
    public private(set) var inspectionPhase: Phase = .loading
    /// Goals whose control is being sent: their buttons wait for the answer.
    public private(set) var goalsInFlight: Set<String> = []
    /// One sentence about the last control (it did not go through, or it is being checked).
    public private(set) var goalNotice: String?

    private let scopeKey: String
    private let client: (any ShannonYousuServing)?
    private var goalsGeneration = 0
    private var inspectionGeneration = 0

    public init(scopeKey: String = "local-owner", client: (any ShannonYousuServing)?) {
        self.scopeKey = scopeKey
        self.client = client
        if client == nil {
            goalsPhase = .notReady
            choicesPhase = .notReady
            capabilitiesPhase = .notReady
            inspectionPhase = .notReady
        }
    }

    // MARK: What the pages show

    /// Active goals first, then resting ones; within each, the nearest review first.
    public var openGoals: [ShannonGoalsDTO.Goal] {
        (goals?.goals ?? []).filter(\.isOpen).sorted { lhs, rhs in
            if lhs.isActive != rhs.isActive { return lhs.isActive }
            let (left, right) = (lhs.reviewAt ?? "~", rhs.reviewAt ?? "~")
            return left != right ? left < right : lhs.id < rhs.id
        }
    }

    /// Goals that are done or dropped, the newest first.
    public var closedGoals: [ShannonGoalsDTO.Goal] {
        (goals?.goals ?? []).filter { !$0.isOpen }.sorted { ($0.closedAt ?? $0.updatedAt ?? "") > ($1.closedAt ?? $1.updatedAt ?? "") }
    }

    public var recentChoices: [ShannonChoicesDTO.Choice] {
        Array((choices?.choices ?? []).sorted { ($0.at ?? "") > ($1.at ?? "") }.prefix(Self.choiceLimit))
    }

    /// Activities first (what she chooses), then tools; by label within each.
    public var catalogue: [ShannonCapabilitiesDTO.Capability] {
        (capabilities?.capabilities ?? []).sorted { lhs, rhs in
            let (left, right) = (lhs.layer == "tool", rhs.layer == "tool")
            if left != right { return !left }
            return (lhs.label ?? lhs.id) < (rhs.label ?? rhs.id)
        }
    }

    public var isLoadingGoals: Bool { goalsPhase == .loading || choicesPhase == .loading }
    public var isLoadingInspection: Bool { inspectionPhase == .loading || capabilitiesPhase == .loading }

    // MARK: Reading

    /// 目標: the goals and the recent choices, read together.
    public func reloadGoals() async {
        guard let client else { return }
        goalsGeneration += 1
        let (scopeKey, request, days) = (scopeKey, goalsGeneration, Self.choiceDays)
        async let goalsRead = Self.read { try await client.loadShannonGoals(scopeKey: scopeKey) }
        async let choicesRead = Self.read { try await client.loadShannonChoices(scopeKey: scopeKey, days: days) }
        let (goalsResult, choicesResult) = await (goalsRead, choicesRead)
        guard request == goalsGeneration else { return }
        Self.apply(goalsResult, to: &goals, phase: &goalsPhase)
        Self.apply(choicesResult, to: &choices, phase: &choicesPhase)
    }

    /// 点検: the counts and the capability list, read together.
    public func reloadInspection() async {
        guard let client else { return }
        inspectionGeneration += 1
        let (scopeKey, request) = (scopeKey, inspectionGeneration)
        async let inspectionRead = Self.read { try await client.loadShannonInspection(scopeKey: scopeKey, day: nil) }
        async let capabilitiesRead = Self.read { try await client.loadShannonCapabilities(scopeKey: scopeKey) }
        let (inspectionResult, capabilitiesResult) = await (inspectionRead, capabilitiesRead)
        guard request == inspectionGeneration else { return }
        Self.apply(inspectionResult, to: &inspection, phase: &inspectionPhase)
        Self.apply(capabilitiesResult, to: &capabilities, phase: &capabilitiesPhase)
    }

    // MARK: The owner's controls

    /// 「完了を認める」「休める」「やめる」, after the owner confirmed it. When the answer is lost on the way, the list is read
    /// again and the notice says whether the change arrived; the request is never sent twice.
    public func perform(_ action: GoalAction, on goal: ShannonGoalsDTO.Goal) async {
        guard let client, !goalsInFlight.contains(goal.id) else { return }
        switch action {
        case .confirm: guard goal.canConfirm else { return }
        case .rest: guard goal.canRest else { return }
        case .drop: guard goal.canDrop else { return }
        }
        goalNotice = nil
        goalsInFlight.insert(goal.id)
        defer { goalsInFlight.remove(goal.id) }
        do {
            switch action {
            case .confirm:
                let answer = try await client.confirmShannonGoal(scopeKey: scopeKey, id: goal.id)
                goalsGeneration += 1
                goals = answer
                goalsPhase = .loaded
            case .rest, .drop:
                try await client.setShannonGoalStatus(scopeKey: scopeKey, id: goal.id, status: action.status)
                await reloadGoals()
            }
        } catch {
            if let rejected = error as? ShannonAPIError, case .rejected(let status) = rejected, (400..<500).contains(status) {
                goalNotice = ShannonGeneratedStrings.executiveGoalsControlFailed
                await reloadGoals()
                return
            }
            goalNotice = ShannonGeneratedStrings.executiveGoalsControlChecking
            await reloadGoals()
            guard goalsPhase == .loaded, let now = goals?.goals.first(where: { $0.id == goal.id }) else {
                goalNotice = ShannonGeneratedStrings.executiveGoalsControlUnknown
                return
            }
            goalNotice = now.status == action.status ? nil : ShannonGeneratedStrings.executiveGoalsControlFailed
        }
    }

    // MARK: Reads, one part at a time

    private enum Read<Value: Sendable>: Sendable {
        case value(Value)
        case absent
        case failed
        case cancelled
    }

    private static func apply<Value: Sendable>(_ result: Read<Value>, to value: inout Value?, phase: inout Phase) {
        switch result {
        case .value(let answer):
            value = answer
            phase = .loaded
        case .absent:
            value = nil
            phase = .notReady
        case .failed:
            phase = .unreadable
        case .cancelled:
            if phase == .loading, value == nil { phase = .unreadable }
        }
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
