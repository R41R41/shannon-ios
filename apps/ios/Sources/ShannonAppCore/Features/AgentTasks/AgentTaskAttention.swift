import Foundation

/// Why a task is paused. The server sends it; older servers leave it out and
/// the client infers it from whether the host left a next action.
public enum ShannonAgentTaskPauseReason: String, Codable, Equatable, Sendable {
    /// The owner asked for the pause.
    case owner
    /// The host stopped and left a next action for the owner.
    case needsOwner = "needs_owner"
}

/// The specific thing about a task that needs the owner. Acknowledgement refers
/// to this, not to the task, so a task raises a notice again whenever it enters
/// an attention state the owner has not seen.
public enum ShannonAgentTaskAttention: Equatable, Sendable {
    /// A pending approval, identified by its request.
    case approval(String)
    /// A pause that needs the owner, identified by that pause.
    case nextAction(String)
    case completed
    case failed
    case cancelled

    /// Stable within one task: the same key means the same thing to look at.
    public var key: String {
        switch self {
        case .approval(let request): "approval:\(request)"
        case .nextAction(let pause): "next:\(pause)"
        case .completed: "completed"
        case .failed: "failed"
        case .cancelled: "cancelled"
        }
    }

    /// An approval stays outstanding until the owner decides it. Looking at it is not a decision.
    public var clearsOnlyByDecision: Bool {
        if case .approval = self { return true }
        return false
    }

    /// Counted on the badge. A cancellation is the owner's own decision.
    public var countsAsUnread: Bool { self != .cancelled }

    /// Decisions first, then work waiting for the owner, then results.
    var noticePriority: Int {
        switch self {
        case .approval: 0
        case .nextAction: 1
        case .completed, .failed, .cancelled: 2
        }
    }
}

extension ShannonAgentTask {
    /// The pause reason, inferred for tasks cached or served before the field existed.
    public var resolvedPauseReason: ShannonAgentTaskPauseReason? {
        guard status == .paused else { return nil }
        if let pauseReason { return pauseReason }
        return (currentAction ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? .owner : .needsOwner
    }

    /// Paused because the host needs the owner, not because the owner paused it.
    public var needsOwnerToContinue: Bool { resolvedPauseReason == .needsOwner }

    /// What the owner has to do before the paused work can go on.
    public var nextAction: String? {
        guard needsOwnerToContinue,
              let action = currentAction?.trimmingCharacters(in: .whitespacesAndNewlines),
              !action.isEmpty else { return nil }
        return action
    }

    public var attention: ShannonAgentTaskAttention? {
        switch status {
        case .waitingApproval:
            guard let pendingApproval else { return .approval("pending") }
            return .approval(pendingApproval.externalRequestID.isEmpty
                ? pendingApproval.id.uuidString : pendingApproval.externalRequestID)
        case .paused:
            guard needsOwnerToContinue else { return nil }
            return .nextAction(pauseSequence.map(String.init) ?? (currentAction ?? ""))
        case .completed: return .completed
        case .failed: return .failed
        case .cancelled: return .cancelled
        case .proposed, .queued, .starting, .running: return nil
        }
    }
}

/// What the owner has already seen, per task and attention state.
public struct ShannonAgentTaskAcknowledgements: Codable, Equatable, Sendable {
    /// `"<task id>|<attention key>"` for each attention state the owner has seen.
    public private(set) var seen: Set<String>
    /// Tasks acknowledged under the earlier per-task rule. They stay quiet only
    /// for a finished state reached before `legacyCutoff`, so old finished work
    /// does not come back while later states of the same task still notify.
    public private(set) var legacyTaskIDs: Set<UUID>
    public private(set) var legacyCutoff: Date?

    public init(seen: Set<String> = [], legacyTaskIDs: Set<UUID> = [], legacyCutoff: Date? = nil) {
        self.seen = seen
        self.legacyTaskIDs = legacyTaskIDs
        self.legacyCutoff = legacyCutoff
    }

    /// Carries the earlier per-task acknowledgements over without resurrecting finished work.
    public init(legacyTaskIDs: Set<UUID>, tasks: [ShannonAgentTask], migratedAt: Date) {
        self.init(legacyTaskIDs: legacyTaskIDs, legacyCutoff: migratedAt)
        for task in tasks where legacyTaskIDs.contains(task.id) {
            guard let attention = task.attention, !attention.clearsOnlyByDecision,
                  task.status.isTerminal else { continue }
            seen.insert(Self.entry(task.id, attention))
        }
    }

    /// Whether the owner still has to be told about the task's current state.
    public func needsNotice(_ task: ShannonAgentTask) -> Bool {
        guard let attention = task.attention else { return false }
        if attention.clearsOnlyByDecision { return true }
        if seen.contains(Self.entry(task.id, attention)) { return false }
        if task.status.isTerminal, legacyTaskIDs.contains(task.id),
           let legacyCutoff, task.updatedAt <= legacyCutoff {
            return false
        }
        return true
    }

    /// Records that the owner saw the task's current state. A pending approval is never recorded.
    @discardableResult
    public mutating func markSeen(_ task: ShannonAgentTask) -> Bool {
        guard let attention = task.attention, !attention.clearsOnlyByDecision else { return false }
        return seen.insert(Self.entry(task.id, attention)).inserted
    }

    /// Drops entries for tasks that no longer exist on this device.
    public mutating func prune(keeping taskIDs: Set<UUID>) {
        seen = seen.filter { entry in
            guard let id = entry.split(separator: "|", maxSplits: 1).first.flatMap({ UUID(uuidString: String($0)) })
            else { return false }
            return taskIDs.contains(id)
        }
    }

    private static func entry(_ id: UUID, _ attention: ShannonAgentTaskAttention) -> String {
        "\(id.uuidString)|\(attention.key)"
    }
}
