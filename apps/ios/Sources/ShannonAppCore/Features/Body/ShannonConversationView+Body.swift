import SwiftUI

extension ShannonConversationView {
    /// Talk is in front in its dialogue display, and nothing covers it: no sheet or cover of the workspace
    /// (the thread list, Settings, a work task, the call screen), nothing opened from her words, no picker
    /// of the composer, and no camera explanation.
    var dialogueFigureIsInFront: Bool {
        ShannonBodyModel.dialogueIsInFront(page: selectedPage, displayMode: displayMode, covers: dialogueCovers)
    }

    var dialogueCovers: ShannonDialogueCovers {
#if os(iOS)
        let photoPicker = composerIsPickingPhoto
#else
        let photoPicker = false
#endif
        return ShannonDialogueCovers(
            threadList: showsThreadList, settings: showsSettings, callScreen: showsGeminiLiveVoice,
            workTask: selectedAgentTaskID != nil, fileImporter: composerIsImporting, photoPicker: photoPicker,
            fromWords: bodyModel.sheetFromWordsIsUp, cameraExplanation: model.appLook.primerPhase != nil
        )
    }

    /// A friend is in the voice conversation, also with the call minimised: the camera is 切 in Talk and the sheet.
    var cameraOthersPresent: Bool {
#if os(iOS)
        ShannonAppLookVisibleState.othersPresent(
            callIsLive: geminiLiveVoiceModel.phase != .idle, participantMode: geminiLiveVoiceModel.participantMode)
#else
        false
#endif
    }

    /// Opens Talk's dialogue display, where her figure is (「トークで姿を見る」, the small figure of an empty Talk).
    func showFigureInTalk() {
        showsSettings = false
        showsThreadList = false
        settleWorkspace(on: .talk)
        guard displayMode != .dialogue else { return }
        displayMode = .dialogue
        UserDefaults.standard.set(displayMode.rawValue, forKey: Self.displayModeKey)
    }

    /// The few seconds after she said her line for a touch aloud (`docs/body-contract.md`, "If he answers"):
    /// the ordinary voice conversation is started on the Talk the server named, and watched for his answer.
    /// He answers: the first turn names the reaction, the call screen comes up over Talk, and it is a
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
            let provider = ShannonPersonaPreset.provider(legacy: speechProviderRawValue, preset: presetRawValue)
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
            // Leaving the dialogue display (or anything covering it), the app, 声で返す or 伝える closes the microphone at once.
            let wait = await geminiLiveVoiceModel.awaitAnswer(seconds: seconds, stillPrivate: { bodyModel.answersInVoice })
            ShannonVoiceDiagnostics.shared.record("body.reaction.listen.finished", metadata: ["result": String(describing: wait)])
            // He opened the call screen himself, or started another call: the call is his, whatever was heard.
            guard voiceWorkspace.connectionRequestID == request else { return }
            if wait == .answered || showsGeminiLiveVoice {
                // The conversation goes on where conversations are held: the call screen, with her figure in it.
                // A cover that came up meanwhile makes room too: a call is never left behind it.
                showsSettings = false
                showsThreadList = false
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
