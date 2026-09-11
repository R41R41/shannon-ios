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

    public var latestAgentTaskNotice: ShannonAgentTask? {
        agentTasks.first { task in
            (task.status == .waitingApproval || task.status.isTerminal)
                && !acknowledgedAgentTaskIDs.contains(task.id)
        }
    }

    public var agentTaskNotices: [ShannonAgentTask] {
        agentTasks.filter { task in
            task.status.isActive
                || (task.status.isTerminal && !acknowledgedAgentTaskIDs.contains(task.id))
        }
    }

    public var agentTaskPollingKey: String {
        agentTasks.filter { $0.status.isActive }.map(\.id.uuidString).sorted().joined(separator: ",")
    }

    public var unreadAgentTaskCount: Int {
        agentTasks.filter { task in
            (task.status == .waitingApproval || task.status == .completed || task.status == .failed)
                && !acknowledgedAgentTaskIDs.contains(task.id)
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
            session.commandThroughMessageId.flatMap(UUID.init(uuidString:)) == sourceMessageID
        }
    }
}
