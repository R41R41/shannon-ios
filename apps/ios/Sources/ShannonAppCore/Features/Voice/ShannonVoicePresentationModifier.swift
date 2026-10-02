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
        // A call that ended without this sheet's 終了 (silence in the background, no answer to her own line) closes it too.
        .onChange(of: workspace.callEndRevision) { isPresented = false }
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
        workspace.endCall(geminiVoiceModel)
        isPresented = false
    }

    private func beginCall(_ mode: ShannonVoiceParticipantMode) {
#if DEBUG
        if ShannonVoiceDesignPreview.isEnabled {
            workspace.threadContext = ShannonVoiceThreadContext(threadID: conversationModel.selectedThreadId)
            geminiVoiceModel.prepareDesignPreview()
            return
        }
#endif
        workspace.beginCall(
            mode: mode, speechProvider: speechProvider, threadID: conversationModel.selectedThreadId,
            conversationModel: conversationModel, geminiVoiceModel: geminiVoiceModel
        )
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
