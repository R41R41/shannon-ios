import Foundation
import Observation

extension ShannonConversationModel {
    public var selectedThread: ChatThreadDTO? {
        threads.first(where: { $0.threadId == selectedThreadId })
    }

    public var selectedThreadAgentTasks: [ShannonAgentTask] {
        guard let selectedThreadId else { return [] }
        return agentTasks
            .filter { $0.conversationThreadID == selectedThreadId }
            .sorted { $0.updatedAt > $1.updatedAt }
    }

    public var latestActiveAgentTask: ShannonAgentTask? {
        selectedThreadAgentTasks.first(where: { $0.status.isActive })
    }

    /// Whether the task is in an attention state the owner has not seen (or, for an approval, not decided).
    public func agentTaskNeedsNotice(_ task: ShannonAgentTask) -> Bool {
        !task.isArchived && agentTaskAcknowledgements.needsNotice(task)
    }

    /// The one task shown under the navigation bar: a pending approval first, then work
    /// waiting for the owner, then a result; the most recent within each.
    public var latestAgentTaskNotice: ShannonAgentTask? {
        agentTasks
            .filter(agentTaskNeedsNotice)
            .min { left, right in
                let leftPriority = left.attention?.noticePriority ?? .max
                let rightPriority = right.attention?.noticePriority ?? .max
                if leftPriority != rightPriority { return leftPriority < rightPriority }
                return left.updatedAt > right.updatedAt
            }
    }

    public var agentTaskNotices: [ShannonAgentTask] {
        agentTasks.filter { task in
            task.status.isActive || (task.status.isTerminal && agentTaskNeedsNotice(task))
        }
    }

    public var agentTaskPollingKey: String {
        agentTasks.filter { $0.status.isActive }.map(\.id.uuidString).sorted().joined(separator: ",")
    }

    public var unreadAgentTaskCount: Int {
        agentTasks.filter { task in
            task.attention?.countsAsUnread == true && agentTaskNeedsNotice(task)
        }.count
    }

    public var totalBadgeCount: Int {
        unreadInitiativeCount + unreadAgentTaskCount
    }

    public var unattachedSelectedThreadAgentTasks: [ShannonAgentTask] {
        let messageIDs = Set(messages.map(\.id))
        return selectedThreadAgentTasks.filter { task in
            guard let sourceMessageID = task.sourceMessageID else { return true }
            return !messageIDs.contains(sourceMessageID)
        }
    }

    public func agentTask(id: UUID) -> ShannonAgentTask? {
        agentTasks.first(where: { $0.id == id })
    }

    public func agentTask(sourceMessageID: UUID) -> ShannonAgentTask? {
        selectedThreadAgentTasks.first(where: { $0.sourceMessageID == sourceMessageID })
    }

    public func organizeSession(sourceMessageID: UUID) -> ShannonOrganizeSessionDTO? {
        organizeSessions.first { session in
            session.threadId == selectedThreadId && session.commandThroughMessageId.flatMap(UUID.init(uuidString:)) == sourceMessageID
        }
    }

    /// Voice proposals do not require a successfully archived spoken reply in
    /// order to remain reviewable. Restored/older messages can also be absent.
    public var unattachedSelectedThreadOrganizeSessions: [ShannonOrganizeSessionDTO] {
        let messageIDs = Set(messages.map(\.id))
        return organizeSessions.filter { session in
            guard session.threadId == selectedThreadId else { return false }
            guard let source = session.commandThroughMessageId.flatMap(UUID.init(uuidString:)) else { return true }
            return !messageIDs.contains(source)
        }.sorted { $0.createdAt < $1.createdAt }
    }
}
