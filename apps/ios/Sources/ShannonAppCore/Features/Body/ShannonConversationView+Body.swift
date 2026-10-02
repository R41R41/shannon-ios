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
            guard !model.isDesignPreview, ShannonMediaPermission.currentMicrophone() == .granted,
                  geminiLiveVoiceModel.phase == .idle || geminiLiveVoiceModel.phase == .failed else { return }
            let provider = ShannonSpeechProvider(rawValue: speechProviderRawValue) ?? .gemini
            // The card of the last call's 「友人も一緒」 periods is put back if this call comes to nothing.
            let callMemory = voiceWorkspace.callMemory
            ShannonBodyReactionLink.shared.arm(reactionID: line.reactionID, listenSeconds: seconds)
            let starting = voiceWorkspace.beginCall(
                mode: .owner, speechProvider: provider, threadID: line.threadID,
                conversationModel: model, geminiVoiceModel: geminiLiveVoiceModel
            )
            let request = voiceWorkspace.connectionRequestID
            await starting.value
            let wait = await geminiLiveVoiceModel.awaitAnswer(seconds: seconds, stillPrivate: { true })
            ShannonVoiceDiagnostics.shared.record("body.reaction.listen.finished", metadata: ["result": String(describing: wait)])
            if wait == .answered {
                // The conversation goes on where conversations are held: the call screen, with her figure in it.
                bodyModel.showsScreen = false
                bodyModel.showsScreenFromSettings = false
                try? await Task.sleep(for: .milliseconds(650))
                if geminiLiveVoiceModel.phase != .idle { showsGeminiLiveVoice = true }
                return
            }
            ShannonBodyReactionLink.shared.disarm()
            // He started another call meanwhile: that one is his.
            guard voiceWorkspace.connectionRequestID == request else { return }
            voiceWorkspace.endCall(geminiLiveVoiceModel)
            if voiceWorkspace.callMemory == nil { voiceWorkspace.callMemory = callMemory }
        }
#else
        nil
#endif
    }
}
