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
            } else if let prompt = workspace.callSummaryPrompt {
                ShannonVoiceCallSummaryPrompt(state: prompt, keep: keepCallSummary,
                    discard: { workspace.callSummaryPrompt = nil })
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
            // Synthetic fixture for the end-of-call question; no call, model, or network.
            guard ProcessInfo.processInfo.arguments.contains("-ShannonPreviewVoiceCallSummary"),
                  workspace.callSummaryPrompt == nil, geminiVoiceModel.phase == .idle else { return }
            workspace.callSummaryPrompt = .asking(.init(threadID: nil, turns: [
                .init(role: .participant, text: "はじめまして"), .init(role: .shannon, text: "はじめまして、シャノンです。"),
            ]))
        }
#endif
    }

    private func endCall() {
        workspace.connectionRequestID = nil
        // Ending never saves anything. A call with a 「友人も一緒」 period only leaves a question.
        let summaryTurns = geminiVoiceModel.callSummaryTurns
        let threadID = workspace.threadContext?.threadID
        geminiVoiceModel.stop()
        workspace.threadContext = nil
        isPresented = false
        workspace.clearPhoto()
        workspace.callSummaryPrompt = summaryTurns.map { .asking(.init(threadID: threadID, turns: $0)) }
    }

    private func keepCallSummary() {
        guard let draft = workspace.callSummaryPrompt?.draft else { return }
        workspace.callSummaryPrompt = .saving(draft)
        Task {
            do {
                try await conversationModel.saveVoiceCallSummary(draft)
                guard workspace.callSummaryPrompt == .saving(draft) else { return }
                workspace.callSummaryPrompt = .saved
                try? await Task.sleep(for: .seconds(4))
                if workspace.callSummaryPrompt == .saved { workspace.callSummaryPrompt = nil }
            } catch {
                if workspace.callSummaryPrompt == .saving(draft) { workspace.callSummaryPrompt = .failed(draft) }
            }
        }
    }

    private func beginCall(_ mode: ShannonVoiceParticipantMode) {
#if DEBUG
        if ShannonVoiceDesignPreview.isEnabled {
            workspace.threadContext = ShannonVoiceThreadContext(threadID: conversationModel.selectedThreadId)
            geminiVoiceModel.prepareDesignPreview()
            return
        }
#endif
        geminiVoiceModel.stop()
        let context = ShannonVoiceThreadContext(threadID: conversationModel.selectedThreadId)
        let requestID = UUID()
        workspace.connectionRequestID = requestID
        workspace.threadContext = context
        workspace.clearPhoto()
        // An unanswered summary question from the previous call is a "no".
        workspace.callSummaryPrompt = nil
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
                    try await conversationModel.commitRealtimeVoiceTurn(
                        userTranscript: user,
                        shannonTranscript: shannon,
                        threadID: context.threadID
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
