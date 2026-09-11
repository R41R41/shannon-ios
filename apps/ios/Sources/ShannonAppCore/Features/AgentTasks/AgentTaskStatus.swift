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
        case .proposal: "相談"
        case .preparation: "準備"
        case .work: "作業"
        case .review: "確認"
        case .completion: "完了"
        case .paused: "一時停止"
        case .failed: "問題が発生"
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

    public var japaneseName: String {
        switch self {
        case .proposed: "作業候補"
        case .queued: "待機中"
        case .starting: "準備中"
        case .running: "作業中"
        case .waitingApproval: "判断待ち"
        case .paused: "一時停止中"
        case .completed: "完了"
        case .failed: "失敗"
        case .cancelled: "中止"
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
