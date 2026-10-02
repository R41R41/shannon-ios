import SwiftUI

extension ShannonConversationView {
    /// The few seconds after she said her line for a touch aloud (`docs/body-contract.md`, "If he answers"):
    /// the ordinary voice conversation is started on the Talk the server named, and watched for his answer.
    /// He answers: the first turn names the reaction, the body screen makes room for the call, and it is a
    /// voice conversation like any other. He does not: the call ends, and nothing was stored.
    var bodyListen: ShannonBodyVoice.Listen? {
#if os(iOS)
        { line, seconds in
            // The microphone is never asked for from here: a permission prompt belongs to a tap of the owner's.
            // Asked again after her line: he may have left the screen or switched her voice off while she spoke.
            guard !model.isDesignPreview, line.audience == .owner, bodyModel.answersInVoice,
                  ShannonMediaPermission.currentMicrophone() == .granted,
                  geminiLiveVoiceModel.phase == .idle || geminiLiveVoiceModel.phase == .failed,
                  // A call from her that rings is hers: starting a conversation here would dismiss it.
                  !ShannonVoiceCallHost.shared.systemCallIsActive else { return }
            let provider = ShannonSpeechProvider(rawValue: speechProviderRawValue) ?? .gemini
            // The card of the last call's 「友人も一緒」 periods is put back if this call comes to nothing.
            let callMemory = voiceWorkspace.callMemory
            let starting = voiceWorkspace.beginCall(
                mode: .owner, speechProvider: provider, threadID: line.threadID,
                conversationModel: model, geminiVoiceModel: geminiLiveVoiceModel
            )
            // After `beginCall`, which drops any id an earlier line left behind: this call, and no other, carries this one.
            ShannonBodyReactionLink.shared.arm(reactionID: line.reactionID, listenSeconds: seconds)
            let request = voiceWorkspace.connectionRequestID
            await starting.value
            // Leaving the screen, the app, 声で返す or 伝える closes the microphone at once.
            let wait = await geminiLiveVoiceModel.awaitAnswer(seconds: seconds, stillPrivate: { bodyModel.answersInVoice })
            ShannonVoiceDiagnostics.shared.record("body.reaction.listen.finished", metadata: ["result": String(describing: wait)])
            // He opened the call screen himself, or started another call: the call is his, whatever was heard.
            guard voiceWorkspace.connectionRequestID == request else { return }
            if wait == .answered || showsGeminiLiveVoice {
                // The conversation goes on where conversations are held: the call screen, with her figure in it.
                // Settings, when the body screen was opened from there, makes room too: a call is never left behind it.
                bodyModel.showsScreen = false
                bodyModel.showsScreenFromSettings = false
                showsSettings = false
                try? await Task.sleep(for: .milliseconds(700))
                if geminiLiveVoiceModel.phase != .idle, voiceWorkspace.connectionRequestID == request { showsGeminiLiveVoice = true }
                return
            }
            voiceWorkspace.endCall(geminiLiveVoiceModel)
            if voiceWorkspace.callMemory == nil { voiceWorkspace.callMemory = callMemory }
        }
#else
        nil
#endif
    }
}
