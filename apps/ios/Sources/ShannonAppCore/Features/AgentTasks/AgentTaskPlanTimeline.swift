import Foundation

/// Platform-neutral projection of a task plan into timeline rows.
///
/// Row state comes only from each plan item's durable `status`. Details for the
/// running row are copied from existing durable events and verification results;
/// nothing is inferred from model prose.
public enum ShannonAgentPlanTimeline {
    public struct Detail: Equatable, Sendable {
        public enum Kind: Equatable, Sendable {
            case command
            case event
            case verification
        }

        public let kind: Kind
        public let tone: ShannonAgentEventTone
        public let title: String
        public let text: String?
    }

    public struct Entry: Equatable, Identifiable, Sendable {
        public let id: String
        public let number: Int
        public let title: String
        public let status: ShannonAgentPlanStatus
        public let details: [Detail]
        public let isLast: Bool

        public var accessibilityValue: String {
            switch status {
            case .completed: "完了"
            case .running: "進行中"
            case .pending: "未着手"
            }
        }
    }

    public static func entries(for task: ShannonAgentTask) -> [Entry] {
        let runningID = task.plan.first { $0.status == .running }?.id
        return task.plan.enumerated().map { index, item in
            Entry(
                id: item.id,
                number: index + 1,
                title: item.title,
                status: item.status,
                details: item.id == runningID ? runningDetails(for: task) : [],
                isLast: index == task.plan.count - 1
            )
        }
    }

    public static func summary(for task: ShannonAgentTask) -> String {
        "全\(task.plan.count)工程中 \(task.completedPlanCount)工程完了"
    }

    static func runningDetails(for task: ShannonAgentTask) -> [Detail] {
        var details: [Detail] = []
        let command = task.latestCommandActivity
        if let command, let activity = command.activity {
            details.append(Detail(
                kind: .command,
                tone: tone(for: activity.status),
                title: commandTitle(for: activity.status),
                text: command.title
            ))
        }
        if let latest = task.timeline.max(by: { $0.sequence < $1.sequence }), latest.id != command?.id {
            details.append(Detail(kind: .event, tone: latest.tone, title: latest.title, text: latest.detail))
        }
        if let verification = verificationDetail(for: task.tests) {
            details.append(verification)
        }
        return details
    }

    static func verificationDetail(for tests: [ShannonAgentTestResult]) -> Detail? {
        guard !tests.isEmpty else { return nil }
        let passed = tests.filter { $0.status == .passed }.count
        let failed = tests.filter { $0.status == .failed }
        let pending = tests.filter { $0.status == .pending }.count
        var parts = ["成功\(passed)件"]
        if !failed.isEmpty { parts.append("失敗\(failed.count)件") }
        if pending > 0 { parts.append("未実行\(pending)件") }
        return Detail(
            kind: .verification,
            tone: failed.isEmpty ? (pending > 0 ? .progress : .success) : .error,
            title: "検証 · " + parts.joined(separator: "・"),
            text: failed.first.map { "失敗: \($0.name)" }
        )
    }

    private static func tone(for status: ShannonAgentTimelineActivityStatus) -> ShannonAgentEventTone {
        switch status {
        case .running: .progress
        case .completed: .success
        case .failed: .error
        }
    }

    private static func commandTitle(for status: ShannonAgentTimelineActivityStatus) -> String {
        switch status {
        case .running: "コマンドを実行中"
        case .completed: "コマンドの実行が完了"
        case .failed: "コマンドで問題を検出"
        }
    }
}
