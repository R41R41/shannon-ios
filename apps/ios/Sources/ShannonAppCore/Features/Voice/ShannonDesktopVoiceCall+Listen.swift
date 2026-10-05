#if os(macOS)
import Foundation

/// Dictation in Talk, and the few seconds after her spoken line for a touch.
extension ShannonDesktopVoiceCall {
    /// A click would start dictation while the call holds the microphone: it waits (the iPhone's rule).
    public var dictationWaitsForCall: Bool {
        holdsMicrophone && [.idle, .denied, .failed].contains(dictation.phase)
    }

    /// 音声入力 in Talk's composer: the first click records, the second sends the recording to be written out,
    /// and `insert` puts the words into the draft. Nothing is sent to her until the owner sends the draft.
    public func dictationPrimaryAction(insert: @escaping @MainActor (String) -> Void) {
        switch dictation.phase {
        case .idle, .denied, .failed:
            guard !dictationWaitsForCall, !ShannonSpeechArbiter.shared.touchLineIsActive else { return }
            // Her message through the earphones and the exchange after it give way to dictation.
            ShannonSpeechArbiter.shared.microphoneWillBeTaken?()
            Task { await dictation.startListening() }
        case .listening, .ready:
            guard let recording = dictation.finishListening(), let conversation else { return }
            Task { @MainActor [dictation] in
                do {
                    let transcript = try await conversation.transcribeVoice(recording)
                    dictation.acceptTranscript(transcript)
                    insert(transcript)
                    dictation.cancel()
                } catch {
                    dictation.finishAfterFailedTranscription()
                }
            }
        case .speaking:
            dictation.stopSpeaking()
        case .requestingPermission, .transcribing, .thinking:
            break
        }
    }

    /// After her line for a touch was said aloud (`docs/body-contract.md`, "If he answers"): the ordinary voice
    /// conversation starts on the Talk the server named and is watched for his answer. He answers: it is a
    /// voice conversation like any other, shown in Talk beside her figure. He does not: the call ends, and
    /// nothing was stored. `answersInVoice` is the body's own rule (すがた in front, 声で返す, 伝える, the app in front).
    func bodyListen(answersInVoice: @escaping @MainActor () -> Bool) -> ShannonBodyVoice.Listen {
        { [weak self] line, seconds in
            // The microphone is never asked for from here: a permission prompt belongs to a click of the owner's.
            guard let self, let conversation = self.conversation, !conversation.isDesignPreview,
                  line.audience == .owner, answersInVoice(),
                  ShannonMediaPermission.currentMicrophone() == .granted,
                  !self.holdsMicrophone, !self.dictationBlocksCall else { return }
            ShannonSpeechArbiter.shared.microphoneWillBeTaken?()
            // The card of the last call's 「友人も一緒」 periods is put back if this call comes to nothing.
            let callMemory = workspace.callMemory
            let starting = workspace.beginCall(
                mode: .owner, speechProvider: Self.speechProvider, threadID: line.threadID,
                conversationModel: conversation, geminiVoiceModel: session
            )
            installCallHooks()
            // After `beginCall`, which drops any id an earlier line left behind: this call, and no other, carries this one.
            ShannonBodyReactionLink.shared.arm(reactionID: line.reactionID, listenSeconds: seconds)
            let request = workspace.connectionRequestID
            await starting.value
            let wait = await session.awaitAnswer(seconds: seconds, stillPrivate: answersInVoice)
            ShannonVoiceDiagnostics.shared.record("body.reaction.listen.finished", metadata: ["result": String(describing: wait)])
            // He started or ended a call himself meanwhile: the call is his, whatever was heard.
            guard workspace.connectionRequestID == request else { return }
            if wait == .answered {
                // The conversation goes on in Talk; its turns are written to the Talk of her line, which is shown.
                if let threadID, conversation.selectedThreadId != threadID { await conversation.selectThread(threadID) }
                return
            }
            workspace.endCall(session)
            restoreOwnerDraft()
            if workspace.callMemory == nil { workspace.callMemory = callMemory }
        }
    }
}
#endif
