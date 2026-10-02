import SwiftUI

#if os(iOS)
struct ShannonVoicePresentationModifier: ViewModifier {
    @Binding var isPresented: Bool
    let speechProvider: ShannonSpeechProvider
    @Bindable var workspace: ShannonVoiceWorkspaceState
    let conversationModel: ShannonConversationModel
    let geminiVoiceModel: ShannonGeminiLiveSessionModel
    let expression: ShannonExpressionDTO
    var allowsTaskNavigation = true
    var openTask: (UUID) -> Void = { _ in }
    @State private var taskToOpen: UUID?
    @Environment(\.colorScheme) private var colorScheme

    private var voiceTask: ShannonAgentTask? {
        guard allowsTaskNavigation, geminiVoiceModel.participantMode == .owner,
              let threadID = workspace.threadContext?.threadID else { return nil }
        return conversationModel.agentTasks.first {
            $0.conversationThreadID == threadID && !$0.status.isTerminal
        }
    }

    func body(content: Content) -> some View {
        // A stack, not a top safe-area inset: a NavigationStack keeps its bar in place
        // under an inset, which would put the pill on top of the title and toolbar.
        VStack(spacing: 0) {
            if geminiVoiceModel.phase != .idle {
                ShannonVoiceSessionBar(model: geminiVoiceModel, task: voiceTask,
                    showDetails: { isPresented = true }, end: endCall, openTask: openTask)
            } else if let memory = workspace.callMemory {
                ShannonVoiceCallMemoryCard(state: memory,
                    retry: { workspace.retryCallMemory(using: conversationModel) },
                    discard: { workspace.discardCallMemory(using: conversationModel) },
                    close: { workspace.callMemory = nil })
            }
            content
        }
        .background { ShannonPalette.resolve(colorScheme).canvas.ignoresSafeArea() }
        .sheet(isPresented: $isPresented, onDismiss: {
            // Minimizing while the microphone explanation waits must not strand the call.
            if geminiVoiceModel.microphonePrimerPhase == .explain { endCall() }
            if let taskToOpen {
                self.taskToOpen = nil
                openTask(taskToOpen)
            }
        }) {
            ShannonGeminiLiveVoiceView(
                model: geminiVoiceModel, workspace: workspace,
                expression: expression, task: voiceTask,
                analyzeCameraSnapshot: { data in
                    guard let threadID = workspace.threadContext?.threadID else {
                        throw ShannonAPIError.invalidResponse
                    }
                    return try await conversationModel.analyzeVoiceCameraSnapshot(jpegData: data, threadID: threadID)
                },
                switchParticipantMode: { geminiVoiceModel.switchParticipantMode(to: $0) },
                openTask: { id in taskToOpen = id; isPresented = false },
                minimize: { isPresented = false }, end: endCall
            )
            .presentationDetents([.large])
            .presentationDragIndicator(.visible)
        }
        .onChange(of: isPresented) {
            if isPresented, geminiVoiceModel.phase == .idle { beginCall(.owner) }
        }
        // A spoken switch happens in the session, so an unshared photo is cleared here too.
        .onChange(of: geminiVoiceModel.participantMode) { workspace.clearPhoto() }
#if DEBUG
        .task {
            // Synthetic fixture for the end-of-call card; no call, model, or network.
            guard ProcessInfo.processInfo.arguments.contains("-ShannonPreviewVoiceCallSummary"),
                  workspace.callMemory == nil, geminiVoiceModel.phase == .idle else { return }
            workspace.callMemory = .init(callIDs: ["preview"], names: ["ミキ"], phase: .remembered)
        }
#endif
    }

    private func endCall() {
        workspace.connectionRequestID = nil
        // A 「友人も一緒」 period that is still running ends with the call and is remembered;
        // the card that replaces the pill says so and offers 「今回は残さない」.
        geminiVoiceModel.finishGuestPeriod()
        geminiVoiceModel.stop()
        workspace.threadContext = nil
        isPresented = false
        workspace.clearPhoto()
    }

    private func beginCall(_ mode: ShannonVoiceParticipantMode) {
#if DEBUG
        if ShannonVoiceDesignPreview.isEnabled {
            workspace.threadContext = ShannonVoiceThreadContext(threadID: conversationModel.selectedThreadId)
            geminiVoiceModel.prepareDesignPreview()
            return
        }
#endif
        // A call that failed without being ended may still hold a period; it is remembered like any other.
        geminiVoiceModel.finishGuestPeriod()
        geminiVoiceModel.stop()
        let context = ShannonVoiceThreadContext(threadID: conversationModel.selectedThreadId)
        let requestID = UUID()
        workspace.connectionRequestID = requestID
        workspace.threadContext = context
        workspace.clearPhoto()
        // The previous call stays remembered; its card makes room for the new call.
        workspace.callMemory = nil
        geminiVoiceModel.guestPeriodEnded = { [workspace, conversationModel] period in
            workspace.remember(period, threadID: context.threadID, using: conversationModel)
        }
        // Five minutes without a word from either side, while the app is in the background, ends the call as 終了 does.
        geminiVoiceModel.endAfterBackgroundSilence = { [conversationModel] in
            endCall()
            conversationModel.statusMessage = ShannonVoiceBackgroundCopy.endedAfterSilence
        }
        // Session-owned, not sheet-owned: minimization must not cancel startup.
        Task {
            guard workspace.connectionRequestID == requestID else { return }
            await geminiVoiceModel.start(
                participantMode: mode,
                speechProvider: speechProvider,
                createSession: { participantMode in
                    let session = try await conversationModel.createGeminiLiveSession(
                        participantMode: participantMode, threadID: context.threadID)
                    context.threadID = session.threadId
                    return session
                },
                performDelegation: { request, utterance, participantMode in
                    try await conversationModel.performLiveVoiceDelegationResponse(
                        transcript: request,
                        userUtterance: utterance,
                        participantMode: participantMode,
                        threadID: context.threadID
                    )
                },
                performStreamingDelegation: { request, utterance, participantMode, onSegment in
                    try await conversationModel.performLiveVoiceDelegationStreamingResponse(
                        transcript: request,
                        userUtterance: utterance,
                        participantMode: participantMode,
                        threadID: context.threadID,
                        onSegment: onSegment
                    )
                },
                streamSpeech: { text, style in
                    try await conversationModel.streamSpeech(text, style: style, provider: speechProvider)
                },
                commitTurn: { user, shannon in
                    // Read before the first suspension: the emotion of the reply being saved.
                    try await conversationModel.commitRealtimeVoiceTurn(
                        userTranscript: user,
                        shannonTranscript: shannon,
                        threadID: context.threadID,
                        emotion: geminiVoiceModel.replyEmotion,
                        companionPresent: geminiVoiceModel.companionSuspected
                    )
                },
                handleDelegationResponse: { response in
                    // Called for owner turns only; 「友人も一緒」 turns never reach the owner's thread.
                    if conversationModel.selectedThreadId == response.threadId, let session = response.organizeSession {
                        conversationModel.upsertOrganizeSession(session)
                    }
                    conversationModel.installAgentTaskProposals(
                        response.uiBlocks ?? [],
                        threadID: response.threadId,
                        sourceMessageID: UUID()
                    )
                }
            )
        }
    }
}

/// Each modal owns its panel presentation while sharing the same call.
struct ShannonVoiceAccessoryModifier: ViewModifier {
    @State private var showsDetails = false
    let workspace: ShannonVoiceWorkspaceState
    let conversationModel: ShannonConversationModel
    let geminiVoiceModel: ShannonGeminiLiveSessionModel

    func body(content: Content) -> some View {
        content.modifier(ShannonVoicePresentationModifier(
            isPresented: $showsDetails, speechProvider: geminiVoiceModel.speechProvider, workspace: workspace,
            conversationModel: conversationModel, geminiVoiceModel: geminiVoiceModel,
            expression: conversationModel.currentExpression, allowsTaskNavigation: false
        ))
    }
}
#endif
