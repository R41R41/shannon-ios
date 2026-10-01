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
            var id = block.proposalId.flatMap(UUID.init(uuidString:)) ?? UUID()
            let detail = [goal, block.risk].compactMap { value in
                guard let value, !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
                return value
            }.joined(separator: "\n")
            // Follow-ups can refine an unstarted proposal, but cannot reset durable work or
            // replace the owner's reviewed execution settings. A proposal whose identity is
            // already taken by started work (or by another thread) is still shown: it gets
            // its own identity instead of being dropped. Only an exact repeat is skipped.
            if let taken = agentTask(id: id),
               taken.status != .proposed || taken.conversationThreadID != threadID {
                guard taken.conversationThreadID != threadID || taken.title != title || taken.goal != goal
                else { continue }
                id = Self.separateProposalID(for: id, threadID: threadID, title: title, goal: goal)
            }
            if var existing = agentTask(id: id) {
                guard existing.status == .proposed, existing.conversationThreadID == threadID else { continue }
                let summary = detail.isEmpty ? goal : detail
                guard existing.title != title || existing.goal != goal || existing.summary != summary else { continue }
                existing.title = title
                existing.goal = goal
                existing.summary = summary
                existing.hostHint = existing.hostHint ?? block.hostHint
                existing.projectHint = existing.projectHint ?? block.projectHint
                existing.cognitiveIntentID = existing.cognitiveIntentID ?? block.cognitiveIntentID
                existing.updatedAt = Date()
                upsertAgentTask(existing)
                continue
            }
            let task = ShannonAgentTask(
                id: id,
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

    /// A stable identity for a proposal that collided with started work, so a repeated
    /// delivery of the same proposal refines one card instead of adding another.
    static func separateProposalID(for id: UUID, threadID: String, title: String, goal: String) -> UUID {
        var hash: UInt64 = 0xcbf2_9ce4_8422_2325
        for byte in "\(id.uuidString)|\(threadID)|\(title)|\(goal)".utf8 {
            hash = (hash ^ UInt64(byte)) &* 0x0000_0100_0000_01b3
        }
        var bytes = id.uuid
        withUnsafeMutableBytes(of: &bytes) { buffer in
            for index in 0..<8 { buffer[8 + index] ^= UInt8(truncatingIfNeeded: hash >> UInt64(index * 8)) }
            buffer[0] ^= 0x5a
        }
        return UUID(uuid: bytes)
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
                ConversationMessage.EmotionSnapshot(emotion, stateVersion: version)
            }
        }
        return ConversationMessage(
            id: UUID(uuidString: message.id) ?? UUID(),
            role: role,
            text: message.content,
            sentAt: parseDate(message.observedAt),
            emotionSnapshot: emotionSnapshot,
            artifacts: message.artifacts ?? [],
            sourceAttribution: message.sourceAttribution,
            turnID: message.sourceExperienceId,
            captures: role == .shannon ? message.captures ?? [] : [],
            reminder: role == .shannon ? message.reminder : nil
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
