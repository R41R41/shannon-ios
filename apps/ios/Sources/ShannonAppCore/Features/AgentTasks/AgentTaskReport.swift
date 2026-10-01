import Foundation

/// The result of a task as three sections: 変更 / 検証 / 未解決.
///
/// Every line comes from durable task data (changed files, recorded checks, plan
/// status). Nothing is taken from model prose, and an empty section is left out.
public struct ShannonAgentTaskReport: Equatable, Sendable {
    public let changes: [ShannonAgentChangeSummary]
    public let tests: [ShannonAgentTestResult]
    /// Checks that failed or never ran, and plan steps left unfinished by stopped work.
    public let unresolved: [String]

    public init(task: ShannonAgentTask) {
        changes = task.changes
        tests = task.tests
        guard task.status.isTerminal || task.needsOwnerToContinue else {
            unresolved = []
            return
        }
        var items = task.tests.compactMap { test -> String? in
            switch test.status {
            case .failed: "検証「\(test.name)」が失敗"
            case .pending: "検証「\(test.name)」が未実行"
            case .passed: nil
            }
        }
        // A completed task was explicitly verified by the host, so its plan is not second-guessed.
        if task.status != .completed {
            items += task.plan.filter { $0.status != .completed }.map { "工程「\($0.title)」が未完了" }
        }
        unresolved = items
    }

    public var isEmpty: Bool { changes.isEmpty && tests.isEmpty && unresolved.isEmpty }

    /// Stopped and finished work shows its report before the plan and history.
    public static func leadsRoom(for task: ShannonAgentTask) -> Bool {
        task.status.isTerminal || task.needsOwnerToContinue
    }
}

/// What the owner can ask for after work finished, failed, or was stopped.
/// A finished task takes no further commands, so the request continues in its source thread.
public enum ShannonAgentTaskFollowUp: String, CaseIterable, Equatable, Sendable {
    case fix
    case continuation

    public var title: String {
        switch self {
        case .fix: "修正を頼む"
        case .continuation: "続きを頼む"
        }
    }

    /// A draft for the composer. It is never sent on the owner's behalf.
    public func draft(for task: ShannonAgentTask) -> String {
        switch self {
        case .fix:
            return "「\(task.title)」の結果で直してほしいところがあります。\n直してほしい点："
        case .continuation:
            let remaining = ShannonAgentTaskReport(task: task).unresolved
            let detail = remaining.isEmpty
                ? "続けてほしいこと："
                : "残っていること：\(remaining.joined(separator: "、"))"
            return "「\(task.title)」の続きをお願いします。\n\(detail)"
        }
    }
}
