import Foundation
import Observation

extension ShannonConversationModel {
    func upsertAgentTask(_ task: ShannonAgentTask) {
        if let index = agentTasks.firstIndex(where: { $0.id == task.id }) {
            agentTasks[index] = task
        } else {
            agentTasks.append(task)
        }
        agentTasks.sort { $0.updatedAt > $1.updatedAt }
        persistAgentTasks()
    }

    func persistAgentTasks() {
        agentTaskStore?.save(agentTasks, scopeKey: scopeKey)
    }

    func performAgentTaskCommand(
        _ id: UUID,
        type: String,
        payload: [String: String],
        failureMessage: String,
        optimisticUpdate: ((inout ShannonAgentTask) -> Void)? = nil
    ) async {
        guard let previous = agentTask(id: id) else { return }
        guard !pendingAgentTaskActionIDs.contains(id) else { return }
        agentTaskActionErrors.removeValue(forKey: id)
        pendingAgentTaskActionIDs.insert(id)
        defer { pendingAgentTaskActionIDs.remove(id) }
        if let optimisticUpdate {
            var optimistic = previous
            optimisticUpdate(&optimistic)
            optimistic.updatedAt = Date()
            upsertAgentTask(optimistic)
        }
        do {
            let remote = try await client.sendAgentTaskCommand(
                scopeKey: scopeKey,
                taskID: id,
                type: type,
                payload: payload,
                idempotencyKey: "ios-command-\(UUID().uuidString.lowercased())"
            )
            upsertAgentTask(remote)
        } catch {
            upsertAgentTask(previous)
            agentTaskActionErrors[id] = failureMessage
            errorMessage = failureMessage
        }
    }

    func installAgentTaskProposals(
        _ blocks: [ShannonUIBlockDTO],
        threadID: String,
        sourceMessageID: UUID
    ) {
        for block in blocks where block.type == "agent_task_proposal" {
            guard let title = block.title, let goal = block.goal else { continue }
            let detail = [goal, block.risk].compactMap { value in
                guard let value, !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
                return value
            }.joined(separator: "\n")
            let task = ShannonAgentTask(
                id: block.proposalId.flatMap(UUID.init(uuidString:)) ?? UUID(),
                conversationThreadID: threadID,
                sourceMessageID: sourceMessageID,
                cognitiveIntentID: block.cognitiveIntentID,
                title: title,
                goal: goal,
                hostHint: block.hostHint,
                projectHint: block.projectHint,
                status: .proposed,
                summary: detail.isEmpty ? goal : detail
            )
            upsertAgentTask(task)
        }
    }

    func upsertOrganizeSession(_ session: ShannonOrganizeSessionDTO) {
        if let index = organizeSessions.firstIndex(where: { $0.id == session.id }) {
            organizeSessions[index] = session
        } else {
            organizeSessions.append(session)
        }
        organizeSessions.sort { $0.createdAt < $1.createdAt }
    }

    func nextAgentSequence(_ task: ShannonAgentTask) -> Int {
        (task.timeline.map(\.sequence).max() ?? 0) + 1
    }

    static func conversationMessage(_ message: StoredConversationMessageDTO) -> ConversationMessage? {
        let role: ConversationMessage.Role
        switch message.role {
        case "user": role = .user
        case "assistant": role = .shannon
        default: return nil
        }
        let emotionSnapshot = message.messageEmotion.flatMap { emotion in
            message.stateVersion.map { version in
                ConversationMessage.EmotionSnapshot(
                    valence: emotion.valence,
                    arousal: emotion.arousal,
                    openness: emotion.openness,
                    expression: emotion.expression,
                    stateVersion: version
                )
            }
        }
        return ConversationMessage(
            id: UUID(uuidString: message.id) ?? UUID(),
            role: role,
            text: message.content,
            sentAt: parseDate(message.observedAt),
            emotionSnapshot: emotionSnapshot,
            artifacts: message.artifacts ?? [],
            sourceAttribution: message.sourceAttribution
        )
    }

    var threadTitleForLoadedMessages: String {
        if let firstUserMessage = messages.compactMap({
            switch $0.role {
            case .user: return $0.text
            case .shannon: return nil
            }
        }).first {
            return firstUserMessage.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                ? "新しいトーク"
                : String(firstUserMessage.prefix(40))
        }
        return "新しいトーク"
    }

    private static func parseDate(_ value: String) -> Date {
        let fractional = Date.ISO8601FormatStyle(includingFractionalSeconds: true)
        if let parsed = try? fractional.parse(value) { return parsed }
        if let parsed = try? Date.ISO8601FormatStyle().parse(value) { return parsed }
        return Date()
    }

    static var isoNow: String {
        Date().formatted(.iso8601)
    }
}
