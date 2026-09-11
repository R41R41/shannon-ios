import SwiftUI
#if canImport(UIKit)
import UIKit
#elseif canImport(AppKit)
import AppKit
#endif
extension ShannonConversationView {
    func toggleDisplayMode() {
        guard !composerIsFocused else {
            composerIsFocused = false
            return
        }
        displayMode = displayMode == .scroll ? .dialogue : .scroll
        UserDefaults.standard.set(displayMode.rawValue, forKey: Self.displayModeKey)
        composerIsFocused = false
        ShannonHaptics.page()
    }

    func copyDialogueReply(_ text: String) {
#if canImport(UIKit)
        UIPasteboard.general.string = text
#elseif canImport(AppKit)
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
#endif
        dialogueDidCopy = true
        Task { @MainActor in
            try? await Task.sleep(for: .seconds(1.2))
            dialogueDidCopy = false
        }
    }

    static let displayModeKey = "shannon.conversation.display-mode"
    static var savedDisplayMode: ShannonConversationDisplayMode {
        UserDefaults.standard.string(forKey: displayModeKey)
            .flatMap(ShannonConversationDisplayMode.init(rawValue:)) ?? .scroll
    }

    var savedAppearanceMode: ShannonAppearanceMode {
        ShannonAppearanceMode(rawValue: appearanceModeRawValue) ?? .system
    }

    var resolvedColorScheme: ColorScheme {
#if DEBUG
        if ProcessInfo.processInfo.arguments.contains("-ShannonPreviewDark") { return .dark }
        if ProcessInfo.processInfo.arguments.contains("-ShannonPreviewLight") { return .light }
#endif
        return switch savedAppearanceMode {
        case .system: colorScheme
        case .light: .light
        case .dark: .dark
        }
    }

    func appIconAppearance(for colorScheme: ColorScheme) -> ShannonAppIconAppearance {
        colorScheme == .dark ? .dark : .light
    }

    var latestShannonMessageID: UUID? {
        model.messages.last(where: { $0.role == .shannon })?.id
    }

    var latestUserMessage: ConversationMessage? {
        model.messages.last(where: { $0.role == .user })
    }

    var agentTaskRoomIsPresented: Binding<Bool> {
        Binding(
            get: { selectedAgentTaskID != nil },
            set: { isPresented in
                if !isPresented { selectedAgentTaskID = nil }
            }
        )
    }

    @ViewBuilder
    var agentTaskRoom: some View {
        if let selectedAgentTaskID,
           let task = model.agentTask(id: selectedAgentTaskID) {
            ShannonAgentTaskRoomView(
                task: task,
                actionIsInFlight: model.isAgentTaskActionInFlight(task.id),
                actionError: model.agentTaskActionError(task.id),
                dismiss: { self.selectedAgentTaskID = nil },
                dismissActionError: { model.dismissAgentTaskActionError(task.id) },
                steer: { instruction in Task { await model.steerAgentTask(task.id, instruction: instruction) } },
                togglePause: { Task { await model.toggleAgentTaskPause(task.id) } },
                cancel: { Task { await model.cancelAgentTask(task.id) } },
                resolveApproval: { accepted, forSession in
                    Task {
                        await model.resolveAgentApproval(task.id, accepted: accepted, forSession: forSession)
                    }
                },
                advancePreview: nil
            )
        }
    }

    func sendDraft() {
        voiceModel.stopSpeaking()
        guard model.canSendDraft else { return }
        Task { await model.sendDraft() }
    }

    var composerIsExpanded: Bool {
        composerIsFocused || !model.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    var composerActionIsEnabled: Bool {
        if !model.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return model.canSendDraft
        }
        return !model.isSending
    }

    var composerActionSymbol: String {
        if !model.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return "arrow.up" }
        return "waveform"
    }

    var composerActionLabel: String {
        if model.isSending { return "送信中" }
        if !model.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return "送信" }
        return "シャノンと音声で話す"
    }

    func composerPrimaryAction() {
        if !model.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            sendDraft()
            return
        }
        performVoicePrimaryAction()
    }

    func performVoicePrimaryAction() {
        composerIsFocused = false
        voiceModel.cancel()
        showsLiveVoice = true
    }

    func performTranscriptionPrimaryAction() {
        switch voiceModel.phase {
        case .idle, .denied, .failed:
            composerIsFocused = false
            Task { await voiceModel.startListening() }

        case .listening, .ready:
            guard let recording = voiceModel.finishListening() else { return }
            Task {
                do {
                    let transcript = try await model.transcribeVoice(recording)
                    voiceModel.acceptTranscript(transcript)
                    model.draft = transcript
                    voiceModel.cancel()
                    composerIsFocused = true
                } catch {
                    voiceModel.finishAfterFailedTranscription()
                }
            }

        case .speaking:
            voiceModel.stopSpeaking()

        case .requestingPermission, .transcribing, .thinking:
            break
        }
    }

    func openAgentTask(_ id: UUID) {
        model.acknowledgeAgentTask(id)
        selectedAgentTaskID = id
    }

    func scrollToBottom(_ proxy: ScrollViewProxy) {
        withAnimation(reduceMotion ? nil : .easeOut(duration: 0.25)) {
            proxy.scrollTo("conversation-bottom", anchor: .bottom)
        }
    }
}
