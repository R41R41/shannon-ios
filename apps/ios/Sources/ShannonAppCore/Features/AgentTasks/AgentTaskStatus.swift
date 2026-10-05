import Foundation

public enum ShannonAgentTaskStage: String, CaseIterable, Equatable, Sendable {
    case proposal
    case preparation
    case work
    case review
    case completion
    case paused
    case failed
    case cancelled

    public var japaneseName: String {
        switch self {
        case .proposal: "提案"
        case .preparation: "準備"
        case .work: "作業"
        case .review: "許可"
        case .completion: "完了"
        case .paused: "一時停止"
        case .failed: "失敗"
        case .cancelled: "中止"
        }
    }

    public var symbolName: String {
        switch self {
        case .proposal: "sparkles"
        case .preparation: "tray.and.arrow.down"
        case .work: "hammer.fill"
        case .review: "checklist"
        case .completion: "checkmark.circle.fill"
        case .paused: "pause.circle.fill"
        case .failed: "exclamationmark.triangle.fill"
        case .cancelled: "xmark.circle.fill"
        }
    }
}

public enum ShannonAgentTaskStageState: Equatable, Sendable {
    case pending
    case current
    case completed
}

public struct ShannonAgentTaskStageProgress: Equatable, Identifiable, Sendable {
    public let stage: ShannonAgentTaskStage
    public let state: ShannonAgentTaskStageState

    public var id: ShannonAgentTaskStage { stage }

    public init(stage: ShannonAgentTaskStage, state: ShannonAgentTaskStageState) {
        self.stage = stage
        self.state = state
    }
}

public enum ShannonAgentTaskStatus: String, Codable, CaseIterable, Equatable, Sendable {
    case proposed
    case queued
    case starting
    case running
    case waitingApproval = "waiting_approval"
    case paused
    case completed
    case failed
    case cancelled

    public var isActive: Bool {
        switch self {
        case .queued, .starting, .running, .waitingApproval, .paused: true
        case .proposed, .completed, .failed, .cancelled: false
        }
    }

    public var isTerminal: Bool {
        switch self {
        case .completed, .failed, .cancelled: true
        default: false
        }
    }

    /// The one user-facing word for each state (see `vocabulary` in
    /// `docs/design/screens/ios/work.yaml`). A paused task that needs the
    /// owner reads 「続きが必要」 through `ShannonAgentTask.stateName`.
    public var japaneseName: String {
        switch self {
        case .proposed: ShannonGeneratedStrings.taskStatusProposed
        case .queued: ShannonGeneratedStrings.taskStatusQueued
        case .starting: ShannonGeneratedStrings.taskStatusStarting
        case .running: ShannonGeneratedStrings.taskStatusRunning
        case .waitingApproval: ShannonGeneratedStrings.taskStatusWaitingApproval
        case .paused: ShannonGeneratedStrings.taskStatusPaused
        case .completed: ShannonGeneratedStrings.taskStatusCompleted
        case .failed: ShannonGeneratedStrings.taskStatusFailed
        case .cancelled: ShannonGeneratedStrings.taskStatusCancelled
        }
    }

    public var symbolName: String {
        switch self {
        case .proposed: "sparkles"
        case .queued: "clock"
        case .starting: "arrow.triangle.2.circlepath"
        case .running: "hammer.fill"
        case .waitingApproval: "hand.raised.fill"
        case .paused: "pause.fill"
        case .completed: "checkmark.circle.fill"
        case .failed: "exclamationmark.triangle.fill"
        case .cancelled: "xmark.circle.fill"
        }
    }

    public var expression: ShannonExpressionDTO {
        switch self {
        case .proposed: .curious
        case .queued, .starting: .thinking
        case .running: .determined
        case .waitingApproval: .concerned
        case .paused: .calm
        case .completed: .joyful
        case .failed: .wry
        case .cancelled: .relieved
        }
    }
}

extension ShannonAgentTask {
    /// Word shown when the host stopped and is waiting for the owner.
    public static let needsOwnerStateName = ShannonGeneratedStrings.taskStatusNeedsOwner

    /// The state word for this task, telling an owner-requested pause from one that needs the owner.
    public var stateName: String {
        needsOwnerToContinue ? Self.needsOwnerStateName : status.japaneseName
    }

    public var stateSymbolName: String {
        needsOwnerToContinue ? "arrow.uturn.forward.circle.fill" : status.symbolName
    }
}

public enum ShannonAgentPlanStatus: String, Codable, Equatable, Sendable {
    case pending
    case running
    case completed

    public var symbolName: String {
        switch self {
        case .pending: "circle"
        case .running: "circle.inset.filled"
        case .completed: "checkmark.circle.fill"
        }
    }
}
