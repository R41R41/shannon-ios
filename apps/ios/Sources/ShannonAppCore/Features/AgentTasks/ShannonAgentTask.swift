import Foundation

public struct ShannonAgentTaskManagement: Codable, Equatable, Sendable {
    public var isPinned: Bool
    public var isArchived: Bool

    public init(isPinned: Bool = false, isArchived: Bool = false) {
        self.isPinned = isPinned
        self.isArchived = isArchived
    }
}

public struct ShannonAgentTask: Codable, Equatable, Identifiable, Sendable {
    public let id: UUID
    public var conversationThreadID: String
    public var sourceMessageID: UUID?
    public var cognitiveIntentID: String?
    public var title: String
    public var goal: String
    public var hostHint: String?
    public var projectHint: String?
    public var assignedHostID: String?
    public var model: String?
    public var reasoningEffort: ShannonAgentReasoningEffort?
    public var status: ShannonAgentTaskStatus
    public var summary: String
    public var currentAction: String?
    public var plan: [ShannonAgentPlanItem]
    public var timeline: [ShannonAgentTimelineEvent]
    public var pendingApproval: ShannonAgentApproval?
    public var changes: [ShannonAgentChangeSummary]
    public var tests: [ShannonAgentTestResult]
    public var management: ShannonAgentTaskManagement?
    public var createdAt: Date
    public var updatedAt: Date

    public init(
        id: UUID = UUID(),
        conversationThreadID: String,
        sourceMessageID: UUID? = nil,
        cognitiveIntentID: String? = nil,
        title: String,
        goal: String,
        hostHint: String? = nil,
        projectHint: String? = nil,
        assignedHostID: String? = nil,
        model: String? = nil,
        reasoningEffort: ShannonAgentReasoningEffort? = nil,
        status: ShannonAgentTaskStatus,
        summary: String,
        currentAction: String? = nil,
        plan: [ShannonAgentPlanItem] = [],
        timeline: [ShannonAgentTimelineEvent] = [],
        pendingApproval: ShannonAgentApproval? = nil,
        changes: [ShannonAgentChangeSummary] = [],
        tests: [ShannonAgentTestResult] = [],
        management: ShannonAgentTaskManagement? = nil,
        createdAt: Date = Date(),
        updatedAt: Date = Date()
    ) {
        self.id = id
        self.conversationThreadID = conversationThreadID
        self.sourceMessageID = sourceMessageID
        self.cognitiveIntentID = cognitiveIntentID
        self.title = title
        self.goal = goal
        self.hostHint = hostHint
        self.projectHint = projectHint
        self.assignedHostID = assignedHostID
        self.model = model
        self.reasoningEffort = reasoningEffort
        self.status = status
        self.summary = summary
        self.currentAction = currentAction
        self.plan = plan
        self.timeline = timeline
        self.pendingApproval = pendingApproval
        self.changes = changes
        self.tests = tests
        self.management = management
        self.createdAt = createdAt
        self.updatedAt = updatedAt
    }

    public var completedPlanCount: Int {
        plan.filter { $0.status == .completed }.count
    }

    public var isPinned: Bool { management?.isPinned ?? false }
    public var isArchived: Bool { management?.isArchived ?? false }

    public mutating func updateManagement(isPinned: Bool? = nil, isArchived: Bool? = nil) {
        var value = management ?? .init()
        if let isPinned { value.isPinned = isPinned }
        if let isArchived { value.isArchived = isArchived }
        management = value
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
            cognitiveIntentID: remote.cognitiveIntentID,
            title: remote.title,
            goal: remote.goal,
            projectHint: remote.projectHint,
            assignedHostID: remote.assignedHostID,
            model: remote.model,
            reasoningEffort: remote.reasoningEffort,
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
                    path: change.path,
                    summary: change.summary,
                    additions: change.additions,
                    deletions: change.deletions,
                    diffPreview: change.diffPreview
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
            management: .init(
                isPinned: remote.isPinned ?? false,
                isArchived: remote.isArchived ?? false
            ),
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
