import SwiftUI
#if canImport(UIKit)
import UIKit
#elseif canImport(AppKit)
import AppKit
#endif
extension ShannonConversationView {
    func loadInitialExperience(activeColorScheme: ColorScheme) async {
        guard !model.isDesignPreview else { return }
        connectionModel?.refreshFromKeychain()
        await model.loadConversationIfNeeded()
        await model.refreshInitiatives()
        await appIconModel.activate(
            for: model.currentExpression,
            appearance: appIconAppearance(for: activeColorScheme)
        )
    }

#if DEBUG
    func applyDesignPreviewLaunchState() {
        if ProcessInfo.processInfo.arguments.contains("-ShannonPreviewWork") {
            selectedPage = .work
        }
        if ProcessInfo.processInfo.arguments.contains("-ShannonPreviewAgentTask"),
           let task = model.agentTasks.first(where: { $0.status == .proposed }) {
            selectedPage = .work
            selectedAgentTaskID = task.id
        }
        if ProcessInfo.processInfo.arguments.contains("-ShannonPreviewSettings") {
            showsSettings = true
        }
        if ProcessInfo.processInfo.arguments.contains("-ShannonPreviewDrawer") {
            drawerProgress = 1
        }
#if os(iOS)
        if ShannonVoiceDesignPreview.isEnabled {
            showsGeminiLiveVoice = true
        }
#endif
    }
#endif

    func pollAgentTasksWhileActive() async {
        guard scenePhase == .active, !model.agentTaskPollingKey.isEmpty else { return }
        while !Task.isCancelled {
            await model.synchronizeAgentTasks()
            guard !model.agentTaskPollingKey.isEmpty else { return }
            do {
                try await Task.sleep(for: .seconds(2))
            } catch {
                return
            }
        }
    }

    func toggleDisplayMode() {
        composerIsFocused = false
        displayMode = displayMode == .scroll ? .dialogue : .scroll
        UserDefaults.standard.set(displayMode.rawValue, forKey: Self.displayModeKey)
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
                workspace: model.agentWorkspace,
                workspaceError: model.agentWorkspaceError,
                refreshWorkspace: { project in
                    await model.refreshAgentWorkspace(projectHint: project)
                },
                configureAndStart: { host, project, agentModel, reasoning in
                    model.configureAgentTask(
                        task.id,
                        hostPreference: host,
                        projectHint: project,
                        model: agentModel,
                        reasoningEffort: reasoning
                    )
                    Task { await model.startAgentTask(task.id) }
                },
                advancePreview: nil
            )
        }
    }

    func sendDraft() {
        voiceModel.stopSpeaking()
        guard !composerIsSubmitting,
              !composerPhotoIsLoading,
              model.canSendDraft(attachmentCount: composerAttachments.count + (composerHasPhoto ? 1 : 0))
        else { return }
        composerIsSubmitting = true
        let attachments = composerAttachments
        let usesWebSearch = composerUsesWebSearch
        let photoJPEGData = composerPhotoJPEGData
        composerAttachments = []
        composerUsesWebSearch = false
        composerAttachmentError = nil
#if os(iOS)
        composerPhoto = nil
#endif
        Task {
            defer { composerIsSubmitting = false }
            await model.sendDraft(
                attachments: attachments,
                webSearch: usesWebSearch,
                photoJPEGData: photoJPEGData
            )
        }
    }

    var composerPhotoJPEGData: Data? {
#if os(iOS)
        composerPhoto?.jpegData
#else
        nil
#endif
    }

    var composerHasPhoto: Bool { composerPhotoJPEGData != nil }

    var composerIsExpanded: Bool {
        composerIsFocused
            || !model.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            || !composerAttachments.isEmpty
            || composerHasPhoto
            || composerUsesWebSearch
    }

    var composerActionIsEnabled: Bool {
        guard !composerIsSubmitting else { return false }
        if composerHasSendableContent {
            return !composerPhotoIsLoading
                && model.canSendDraft(attachmentCount: composerAttachments.count + (composerHasPhoto ? 1 : 0))
        }
        return !model.isSending
    }

    var composerActionSymbol: String {
        if composerHasSendableContent { return "arrow.up" }
        return "waveform"
    }

    var composerActionLabel: String {
        if model.isSending { return "送信中" }
        if composerHasSendableContent { return "送信" }
        return "シャノンと音声で話す"
    }

    func composerPrimaryAction() {
        if composerHasSendableContent {
            sendDraft()
            return
        }
        performVoicePrimaryAction()
    }

    func performVoicePrimaryAction() {
        composerIsFocused = false
        voiceModel.cancel()
        geminiLiveVoiceModel.stop()
        showsGeminiLiveVoice = true
    }

    var composerHasSendableContent: Bool {
        !model.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            || !composerAttachments.isEmpty
            || composerHasPhoto
    }

    func importComposerAttachments(_ result: Result<[URL], Error>) {
        do {
            let loaded = try ShannonChatAttachmentLoader.load(
                urls: result.get(),
                existing: composerAttachments
            )
            guard loaded.count + (composerHasPhoto ? 1 : 0) <= ShannonChatAttachmentLimits.maximumCount else {
                composerAttachmentError = "写真とファイルは合わせて4件までです。"
                return
            }
            composerAttachments = loaded
            composerAttachmentError = nil
        } catch {
            composerAttachmentError = (error as? LocalizedError)?.errorDescription
                ?? "ファイルを追加できませんでした。"
        }
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
