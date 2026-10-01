import Foundation

extension ShannonConversationModel {
    /// Saves the summary the owner asked for and shows it in the call's thread as Shannon's note.
    /// Nothing is sent for a call the owner declined, so there is no "discard" request.
    func saveVoiceCallSummary(_ draft: ShannonVoiceCallSummaryDraft) async throws {
        guard !draft.turns.isEmpty else { throw ShannonAPIError.invalidResponse }
        let response = try await client.saveVoiceCallSummary(
            scopeKey: scopeKey, threadId: draft.threadID, turns: draft.turns)
        let note = ConversationMessage(role: .shannon, text: response.summary)
        if selectedThreadId == response.threadId || (draft.threadID != nil && selectedThreadId == draft.threadID) {
            messages.append(note)
            cacheCurrentHistory()
        } else {
            // The owner may be reading another thread; never append to the visible one.
            cachedHistories[response.threadId, default: []].append(ShannonConversationCache.CachedMessage(note))
        }
        persistDisplayCache()
        await loadThreads(force: true)
    }
}
