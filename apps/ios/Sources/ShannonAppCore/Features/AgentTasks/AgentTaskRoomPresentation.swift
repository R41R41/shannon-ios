import Foundation

/// Platform-neutral text for the iPhone task room.
///
/// Everything is derived from durable task status, the pending approval, and
/// plan item status; nothing is inferred from model prose.
public enum ShannonAgentTaskRoomPresentation {
    /// Header line shown inside the approval card when it replaces the room hero.
    public static let approvalHeader = "シャノンが判断を待っています"

    /// Compact navigation subtitle, e.g. "判断待ち・5/8工程".
    ///
    /// A pending approval always reads as waiting for a decision, even while the
    /// task status has not caught up yet, because the approval card is shown first.
    public static func subtitle(for task: ShannonAgentTask) -> String {
        let state = task.pendingApproval == nil
            ? task.status.japaneseName
            : ShannonAgentTaskStatus.waitingApproval.japaneseName
        guard !task.plan.isEmpty else { return state }
        return "\(state)・\(task.completedPlanCount)/\(task.plan.count)工程"
    }

    /// Short progress shown beside the plan header, e.g. "5/8 完了".
    public static func planProgress(for task: ShannonAgentTask) -> String {
        "\(task.completedPlanCount)/\(task.plan.count) 完了"
    }
}
