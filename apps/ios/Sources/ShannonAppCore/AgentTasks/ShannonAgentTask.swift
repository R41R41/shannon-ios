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

public struct ShannonAgentPlanItem: Codable, Equatable, Identifiable, Sendable {
    public let id: String
    public var title: String
    public var status: ShannonAgentPlanStatus

    public init(id: String, title: String, status: ShannonAgentPlanStatus) {
        self.id = id
        self.title = title
        self.status = status
    }
}

public enum ShannonAgentEventTone: String, Codable, Equatable, Sendable {
    case neutral
    case progress
    case success
    case warning
    case error
}

public enum ShannonAgentTimelineActivityKind: String, Codable, Equatable, Sendable {
    case command
}

public enum ShannonAgentTimelineActivityStatus: String, Codable, Equatable, Sendable {
    case running
    case completed
    case failed
}

public struct ShannonAgentTimelineActivity: Codable, Equatable, Sendable {
    public let kind: ShannonAgentTimelineActivityKind
    public let status: ShannonAgentTimelineActivityStatus

    public init(kind: ShannonAgentTimelineActivityKind, status: ShannonAgentTimelineActivityStatus) {
        self.kind = kind
        self.status = status
    }
}

public struct ShannonAgentTimelineEvent: Codable, Equatable, Identifiable, Sendable {
    public let id: UUID
    public let sequence: Int
    public var title: String
    public var detail: String?
    public var occurredAt: Date
    public var tone: ShannonAgentEventTone
    public var activity: ShannonAgentTimelineActivity?

    public init(
        id: UUID = UUID(),
        sequence: Int,
        title: String,
        detail: String? = nil,
        occurredAt: Date = Date(),
        tone: ShannonAgentEventTone = .neutral,
        activity: ShannonAgentTimelineActivity? = nil
    ) {
        self.id = id
        self.sequence = sequence
        self.title = title
        self.detail = detail
        self.occurredAt = occurredAt
        self.tone = tone
        self.activity = activity
    }
}

public enum ShannonAgentApprovalKind: String, Codable, Equatable, Sendable {
    case command
    case fileChange = "file_change"
    case network
    case permission

    public var japaneseName: String {
        switch self {
        case .command: "コマンド実行"
        case .fileChange: "ファイル変更"
        case .network: "外部接続"
        case .permission: "権限"
        }
    }

    public var symbolName: String {
        switch self {
        case .command: "terminal"
        case .fileChange: "doc.badge.gearshape"
        case .network: "network"
        case .permission: "lock.shield"
        }
    }
}

public struct ShannonAgentApproval: Codable, Equatable, Identifiable, Sendable {
    public let id: UUID
    public let externalRequestID: String
    public var kind: ShannonAgentApprovalKind
    public var title: String
    public var reason: String
    public var resource: String?
    public var requestedAt: Date

    public init(
        id: UUID = UUID(),
        externalRequestID: String,
        kind: ShannonAgentApprovalKind,
        title: String,
        reason: String,
        resource: String? = nil,
        requestedAt: Date = Date()
    ) {
        self.id = id
        self.externalRequestID = externalRequestID
        self.kind = kind
        self.title = title
        self.reason = reason
        self.resource = resource
        self.requestedAt = requestedAt
    }
}

public struct ShannonAgentChangeSummary: Codable, Equatable, Identifiable, Sendable {
    public let id: UUID
    public var displayName: String
    public var summary: String
    public var additions: Int
    public var deletions: Int

    public init(
        id: UUID = UUID(),
        displayName: String,
        summary: String,
        additions: Int = 0,
        deletions: Int = 0
    ) {
        self.id = id
        self.displayName = displayName
        self.summary = summary
        self.additions = additions
        self.deletions = deletions
    }
}

public enum ShannonAgentTestStatus: String, Codable, Equatable, Sendable {
    case pending
    case passed
    case failed
}

public struct ShannonAgentTestResult: Codable, Equatable, Identifiable, Sendable {
    public let id: UUID
    public var name: String
    public var status: ShannonAgentTestStatus
    public var detail: String?

    public init(
        id: UUID = UUID(),
        name: String,
        status: ShannonAgentTestStatus,
        detail: String? = nil
    ) {
        self.id = id
        self.name = name
        self.status = status
        self.detail = detail
    }
}

public struct ShannonAgentTask: Codable, Equatable, Identifiable, Sendable {
    public let id: UUID
    public var conversationThreadID: String
    public var sourceMessageID: UUID?
    public var title: String
    public var goal: String
    public var status: ShannonAgentTaskStatus
    public var summary: String
    public var currentAction: String?
    public var plan: [ShannonAgentPlanItem]
    public var timeline: [ShannonAgentTimelineEvent]
    public var pendingApproval: ShannonAgentApproval?
    public var changes: [ShannonAgentChangeSummary]
    public var tests: [ShannonAgentTestResult]
    public var createdAt: Date
    public var updatedAt: Date

    public init(
        id: UUID = UUID(),
        conversationThreadID: String,
        sourceMessageID: UUID? = nil,
        title: String,
        goal: String,
        status: ShannonAgentTaskStatus,
        summary: String,
        currentAction: String? = nil,
        plan: [ShannonAgentPlanItem] = [],
        timeline: [ShannonAgentTimelineEvent] = [],
        pendingApproval: ShannonAgentApproval? = nil,
        changes: [ShannonAgentChangeSummary] = [],
        tests: [ShannonAgentTestResult] = [],
        createdAt: Date = Date(),
        updatedAt: Date = Date()
    ) {
        self.id = id
        self.conversationThreadID = conversationThreadID
        self.sourceMessageID = sourceMessageID
        self.title = title
        self.goal = goal
        self.status = status
        self.summary = summary
        self.currentAction = currentAction
        self.plan = plan
        self.timeline = timeline
        self.pendingApproval = pendingApproval
        self.changes = changes
        self.tests = tests
        self.createdAt = createdAt
        self.updatedAt = updatedAt
    }

    public var completedPlanCount: Int {
        plan.filter { $0.status == .completed }.count
    }

    public var progressFraction: Double? {
        guard !plan.isEmpty else { return nil }
        return Double(completedPlanCount) / Double(plan.count)
    }

    public var expression: ShannonExpressionDTO { status.expression }

    public var stage: ShannonAgentTaskStage {
        switch status {
        case .proposed: .proposal
        case .queued, .starting: .preparation
        case .running: .work
        case .waitingApproval: .review
        case .paused: .paused
        case .completed: .completion
        case .failed: .failed
        case .cancelled: .cancelled
        }
    }

    public var stageProgress: [ShannonAgentTaskStageProgress] {
        let stages: [ShannonAgentTaskStage] = [.proposal, .preparation, .work, .review, .completion]
        if status == .completed {
            return stages.map { .init(stage: $0, state: .completed) }
        }
        let currentIndex: Int
        switch status {
        case .proposed: currentIndex = 0
        case .queued, .starting: currentIndex = 1
        case .running, .paused, .failed, .cancelled: currentIndex = 2
        case .waitingApproval: currentIndex = 3
        case .completed: currentIndex = 4
        }
        return stages.enumerated().map { index, stage in
            .init(stage: stage, state: index < currentIndex ? .completed : index == currentIndex ? .current : .pending)
        }
    }

    public var latestCommandActivity: ShannonAgentTimelineEvent? {
        timeline.reversed().first { $0.activity?.kind == .command }
    }

    public var stageDescription: String {
        if status == .running, let command = latestCommandActivity?.activity {
            switch command.status {
            case .running: return "シャノンがコマンドを実行しています"
            case .completed: return "シャノンがコマンドの結果を確認しています"
            case .failed: return "シャノンがコマンドで見つかった問題を確認しています"
            }
        }
        switch stage {
        case .proposal: return "シャノンが作業内容を確認します"
        case .preparation: return "シャノンが作業の準備をしています"
        case .work: return "シャノンが作業を進めています"
        case .review: return "シャノンが確認を待っています"
        case .completion: return "シャノンの作業が完了しました"
        case .paused: return "シャノンの作業は一時停止中です"
        case .failed: return "シャノンの作業で問題が発生しました"
        case .cancelled: return "シャノンの作業は中止されました"
        }
    }

    public func canTransition(to target: ShannonAgentTaskStatus) -> Bool {
        guard status != target else { return true }
        switch status {
        case .proposed:
            return [.queued, .starting, .running, .cancelled].contains(target)
        case .queued:
            return [.starting, .running, .cancelled, .failed].contains(target)
        case .starting:
            return [.running, .waitingApproval, .cancelled, .failed].contains(target)
        case .running:
            return [.waitingApproval, .paused, .completed, .cancelled, .failed].contains(target)
        case .waitingApproval:
            return [.running, .paused, .cancelled, .failed].contains(target)
        case .paused:
            return [.running, .cancelled, .failed].contains(target)
        case .completed, .failed, .cancelled:
            return false
        }
    }

    public init(remote: ShannonAgentTaskRemoteDTO) throws {
        guard let id = UUID(uuidString: remote.id) else { throw ShannonAgentTaskMappingError.invalidIdentifier }
        self.init(
            id: id,
            conversationThreadID: remote.conversationThreadID,
            sourceMessageID: remote.sourceMessageID.flatMap(UUID.init(uuidString:)),
            title: remote.title,
            goal: remote.goal,
            status: remote.status,
            summary: remote.summary,
            currentAction: remote.currentAction,
            plan: remote.plan,
            timeline: remote.timeline.map { event in
                ShannonAgentTimelineEvent(
                    id: UUID(uuidString: event.id) ?? UUID(),
                    sequence: event.sequence,
                    title: event.title,
                    detail: event.detail,
                    occurredAt: Self.remoteDate(event.occurredAt),
                    tone: event.tone,
                    activity: event.activity
                )
            },
            pendingApproval: remote.pendingApproval.map { approval in
                ShannonAgentApproval(
                    id: UUID(uuidString: approval.id) ?? UUID(),
                    externalRequestID: approval.externalRequestID,
                    kind: approval.kind,
                    title: approval.title,
                    reason: approval.reason,
                    resource: approval.resource,
                    requestedAt: Self.remoteDate(approval.requestedAt)
                )
            },
            changes: remote.changes.map { change in
                ShannonAgentChangeSummary(
                    id: Self.remoteIdentifier(change.id),
                    displayName: change.displayName,
                    summary: change.summary,
                    additions: change.additions,
                    deletions: change.deletions
                )
            },
            tests: remote.tests.map { test in
                ShannonAgentTestResult(
                    id: Self.remoteIdentifier(test.id),
                    name: test.name,
                    status: test.status,
                    detail: test.detail
                )
            },
            createdAt: Self.remoteDate(remote.createdAt),
            updatedAt: Self.remoteDate(remote.updatedAt)
        )
    }

    private static func remoteDate(_ value: String) -> Date {
        (try? Date(value, strategy: .iso8601)) ?? Date.distantPast
    }

    private static func remoteIdentifier(_ value: String) -> UUID {
        if let identifier = UUID(uuidString: value) { return identifier }
        let compact = value.filter(\.isHexDigit)
        guard compact.count == 32 else { return UUID() }
        let first = String(compact.prefix(8))
        let second = String(compact.dropFirst(8).prefix(4))
        let third = String(compact.dropFirst(12).prefix(4))
        let fourth = String(compact.dropFirst(16).prefix(4))
        let fifth = String(compact.dropFirst(20).prefix(12))
        let normalized = "\(first)-\(second)-\(third)-\(fourth)-\(fifth)"
        return UUID(uuidString: normalized) ?? UUID()
    }
}

public enum ShannonAgentTaskMappingError: Error, Equatable {
    case invalidIdentifier
}

public enum ShannonAgentTaskFixtures {
    public static func proposed(
        threadID: String = "fixture-thread",
        sourceMessageID: UUID? = nil,
        now: Date = Date()
    ) -> ShannonAgentTask {
        ShannonAgentTask(
            conversationThreadID: threadID,
            sourceMessageID: sourceMessageID,
            title: "ログイン障害を調査・修正",
            goal: "会話履歴を保持したまま、再起動直後の接続失敗を解消する",
            status: .proposed,
            summary: "原因を調べて、影響の小さい直し方まで確認する。",
            createdAt: now,
            updatedAt: now
        )
    }

    public static func running(
        threadID: String = "fixture-thread",
        sourceMessageID: UUID? = nil,
        now: Date = Date()
    ) -> ShannonAgentTask {
        var task = proposed(threadID: threadID, sourceMessageID: sourceMessageID, now: now)
        task.status = .running
        task.title = "ログイン障害を調査"
        task.summary = "認証状態の復元処理を追いかけてるところ。"
        task.currentAction = "既存の対話履歴を壊さないか確認中"
        task.plan = samplePlan
        task.timeline = [
            .init(sequence: 1, title: "再現条件を確認", detail: "アプリ再起動直後に発生", occurredAt: now.addingTimeInterval(-240), tone: .success),
            .init(sequence: 2, title: "関連箇所を特定", detail: "SessionStore と APIClient", occurredAt: now.addingTimeInterval(-120), tone: .success),
            .init(sequence: 3, title: "修正案を検証中", detail: "既存の対話履歴を壊さないか確認", occurredAt: now, tone: .progress),
        ]
        return task
    }

    public static func waitingApproval(
        threadID: String = "fixture-thread",
        sourceMessageID: UUID? = nil,
        now: Date = Date()
    ) -> ShannonAgentTask {
        var task = running(threadID: threadID, sourceMessageID: sourceMessageID, now: now)
        task.status = .waitingApproval
        task.summary = "接続テストの前で待ってる。"
        task.currentAction = "端末の認証情報を使う許可を待っています"
        task.pendingApproval = ShannonAgentApproval(
            externalRequestID: "fixture-approval",
            kind: .network,
            title: "接続テストをしていい？",
            reason: "外部への書き込みはせず、ログイン確認だけ行います。",
            resource: "sh4nnon.com",
            requestedAt: now
        )
        return task
    }

    public static func completed(
        threadID: String = "fixture-thread",
        sourceMessageID: UUID? = nil,
        now: Date = Date()
    ) -> ShannonAgentTask {
        var task = running(threadID: threadID, sourceMessageID: sourceMessageID, now: now)
        task.status = .completed
        task.summary = "履歴を残したまま再接続できるようにした。"
        task.currentAction = nil
        task.plan = samplePlan.map { .init(id: $0.id, title: $0.title, status: .completed) }
        task.timeline.append(.init(sequence: 4, title: "修正とテストが完了", detail: "31件のテストが成功", occurredAt: now, tone: .success))
        task.changes = [
            .init(displayName: "SessionStore.swift", summary: "履歴を消さずにセッションを更新", additions: 12, deletions: 4),
            .init(displayName: "SessionStoreTests.swift", summary: "再起動後の復元試験を追加", additions: 18, deletions: 0),
        ]
        task.tests = [
            .init(name: "セッション復元", status: .passed, detail: "12件"),
            .init(name: "対話履歴の保持", status: .passed, detail: "19件"),
        ]
        return task
    }

    private static var samplePlan: [ShannonAgentPlanItem] {
        [
            .init(id: "reproduce", title: "再現条件を確認", status: .completed),
            .init(id: "trace", title: "関連箇所を特定", status: .completed),
            .init(id: "fix", title: "修正案を検証", status: .running),
            .init(id: "test", title: "テストして結果をまとめる", status: .pending),
        ]
    }
}
