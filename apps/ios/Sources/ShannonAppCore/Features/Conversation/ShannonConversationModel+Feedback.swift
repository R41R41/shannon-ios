import Foundation
import SwiftUI

extension ShannonConversationModel {
    func setStage5Audience(othersPresent: Bool) {
        stage5OthersPresent = othersPresent
        feedback.setContext(threadID: selectedThreadId, othersPresent: othersPresent)
        reactions.setAudience(othersPresent: othersPresent)
        for model in taskTreeModels.values { model.setAudience(othersPresent: othersPresent) }
    }
    func rememberVoiceFeedback(_ response: ShannonLiveVoiceDelegationResponseDTO, participantMode: ShannonVoiceParticipantMode) {
        guard participantMode == .owner, response.companionPresent != true,
              let record = response.feedbackRecordId else { return }
        let places = response.uiBlocks?.flatMap { $0.places ?? [] } ?? []
        let reply = ShannonPlaceLinks.appending(places, to: response.reply).trimmingCharacters(in: .whitespacesAndNewlines)
        voiceFeedbackRecords.append(VoiceFeedbackRecord(threadID: response.threadId, reply: reply, recordID: record))
        if voiceFeedbackRecords.count > 16 { voiceFeedbackRecords.removeFirst(voiceFeedbackRecords.count - 16) }
    }
    /// Refresh only additive feedback metadata. Never replace in-flight/local conversation messages.
    public func refreshFeedbackProjection() async {
        guard let thread = selectedThreadId, !isDesignPreview, !feedback.othersPresent else { return }
        let revision = historyLoadRevision
        let context = feedback.contextRevision
        guard let response = try? await client.loadConversation(scopeKey: scopeKey, threadId: thread),
              selectedThreadId == thread, response.threadId == thread, historyLoadRevision == revision,
              !feedback.othersPresent, context == feedback.contextRevision else { return }
        let targets = response.messages.compactMap(\.feedback)
        feedback.install(targets, threadID: thread)
        let byTurn = Dictionary(targets.map { ($0.turnId, $0) }, uniquingKeysWith: { $1 })
        messages = messages.map { message in
            guard message.role == .shannon else { return message }
            let target = message.turnID.flatMap { id in
                byTurn[id.hasPrefix("agent-task-result:") ? String(id.dropFirst("agent-task-result:".count)) : id]
            } ?? byTurn[message.id.uuidString.lowercased()]
            return message.with(feedback: target)
        }
    }
}

public struct ShannonFeedbackContext: ViewModifier {
    let conversation: ShannonConversationModel
    let othersPresent: Bool
    let interests: ShannonInterestsModel?
    public init(conversation: ShannonConversationModel, othersPresent: Bool, interests: ShannonInterestsModel? = nil) {
        self.conversation = conversation; self.othersPresent = othersPresent; self.interests = interests
    }
    public func body(content: Content) -> some View {
        content
            .onChange(of: othersPresent, initial: true) { _, value in
                conversation.setStage5Audience(othersPresent: value)
                interests?.setAudience(othersPresent: value)
            }
            .task(id: "\(conversation.selectedThreadId ?? "")|\(othersPresent)") {
                conversation.feedback.setContext(threadID: conversation.selectedThreadId, othersPresent: othersPresent)
                if !othersPresent { await conversation.refreshFeedbackProjection() }
            }
            .task(id: othersPresent) { if !othersPresent { await interests?.loadIfNeeded() } }
    }
}
