import Foundation

extension ShannonConversationModel {
    /// Stores one ended 「友人も一緒」 period: the name said in it and what was talked about.
    /// It goes to 頭の中 › 人, never into the owner's thread, profile, promises or goals.
    func rememberVoiceCall(_ period: ShannonVoiceGuestPeriod, threadID: String?) async throws -> ShannonRememberedVoiceCallDTO {
        guard !period.isEmpty else { throw ShannonAPIError.invalidResponse }
        return try await client.rememberVoiceCall(
            scopeKey: scopeKey, callId: period.callID, threadId: threadID, turns: period.turns)
    }

    /// 「今回は残さない」 for every period of one call. The first failure is reported; nothing is retried silently.
    func discardVoiceCalls(_ callIDs: [String]) async throws {
        for callID in callIDs { try await client.discardVoiceCall(scopeKey: scopeKey, callId: callID) }
    }
}
