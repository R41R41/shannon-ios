import SwiftUI

#if os(iOS)
struct ShannonVoicePresentationModifier: ViewModifier {
    @Binding var isPresented: Bool
    @Bindable var workspace: ShannonVoiceWorkspaceState
    let conversationModel: ShannonConversationModel
    let geminiVoiceModel: ShannonGeminiLiveSessionModel
    let expression: ShannonExpressionDTO
    var allowsTaskNavigation = true
    var openTask: (UUID) -> Void = { _ in }
    @State private var taskToOpen: UUID?

    private var voiceTask: ShannonAgentTask? {
        guard allowsTaskNavigation, geminiVoiceModel.participantMode == .owner,
              let threadID = workspace.threadContext?.threadID else { return nil }
        return conversationModel.agentTasks.first {
            $0.conversationThreadID == threadID && !$0.status.isTerminal
        }
    }

    func body(content: Content) -> some View {
        content
        .safeAreaInset(edge: .top, spacing: 0) {
            if geminiVoiceModel.phase != .idle {
                ShannonVoiceSessionBar(model: geminiVoiceModel, task: voiceTask,
                    showDetails: { isPresented = true }, end: endCall, openTask: openTask)
            }
        }
        .sheet(isPresented: $isPresented, onDismiss: {
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
                switchParticipantMode: beginCall,
                openTask: { id in taskToOpen = id; isPresented = false },
                minimize: { isPresented = false }, end: endCall
            )
            .presentationDetents([.large])
            .presentationDragIndicator(.visible)
        }
        .onChange(of: isPresented) {
            if isPresented, geminiVoiceModel.phase == .idle { beginCall(.owner) }
        }
    }

    private func endCall() {
        workspace.connectionRequestID = nil
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
        geminiVoiceModel.stop()
        let context = ShannonVoiceThreadContext(threadID: conversationModel.selectedThreadId)
        let requestID = UUID()
        workspace.connectionRequestID = requestID
        workspace.threadContext = context
        workspace.clearPhoto()
        // Session-owned, not sheet-owned: minimization must not cancel startup.
        Task {
            guard workspace.connectionRequestID == requestID else { return }
            await geminiVoiceModel.start(
                participantMode: mode,
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
                    try await conversationModel.streamGeminiSpeech(text, style: style)
                },
                commitTurn: { user, shannon in
                    try await conversationModel.commitRealtimeVoiceTurn(
                        userTranscript: user,
                        shannonTranscript: shannon,
                        threadID: context.threadID
                    )
                },
                handleDelegationResponse: { response in
                    guard mode == .owner else { return }
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
            isPresented: $showsDetails, workspace: workspace,
            conversationModel: conversationModel, geminiVoiceModel: geminiVoiceModel,
            expression: conversationModel.currentExpression, allowsTaskNavigation: false
        ))
    }
}
#endif
