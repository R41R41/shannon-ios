#if os(iOS)
import PhotosUI
import SwiftUI
import UIKit

/// The expanded realtime voice call: the Waterlight Eye is the focus, one status
/// line describes the call, and a labelled control bar sits at the bottom.
public struct ShannonGeminiLiveVoiceView: View {
    @Bindable var model: ShannonGeminiLiveSessionModel
    @Bindable var workspace: ShannonVoiceWorkspaceState
    private let expression: ShannonExpressionDTO
    private let task: ShannonAgentTask?
    private let switchParticipantMode: (ShannonVoiceParticipantMode) -> Void
    private let openTask: (UUID) -> Void
    private let minimize: () -> Void
    let end: () -> Void
    let analyzeCameraSnapshot: @MainActor (Data) async throws -> String
    /// Her eyes in this app: the camera's state is always shown under the title.
    private let appLook: ShannonAppLookCoordinator?

    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Environment(\.openURL) private var openURL
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    @Environment(\.colorSchemeContrast) private var contrast
    @FocusState private var composerIsFocused: Bool

    init(
        model: ShannonGeminiLiveSessionModel,
        workspace: ShannonVoiceWorkspaceState,
        expression: ShannonExpressionDTO,
        task: ShannonAgentTask?,
        appLook: ShannonAppLookCoordinator? = nil,
        analyzeCameraSnapshot: @escaping @MainActor (Data) async throws -> String,
        switchParticipantMode: @escaping (ShannonVoiceParticipantMode) -> Void,
        openTask: @escaping (UUID) -> Void,
        minimize: @escaping () -> Void,
        end: @escaping () -> Void
    ) {
        self.model = model
        self.workspace = workspace
        self.expression = expression
        self.task = task
        self.appLook = appLook
        self.analyzeCameraSnapshot = analyzeCameraSnapshot
        self.switchParticipantMode = switchParticipantMode
        self.openTask = openTask
        self.minimize = minimize
        self.end = end
    }

    public var body: some View {
        let palette = ShannonPalette.resolve(colorScheme)
        ZStack {
            ShannonVoiceAmbientBackground(phase: model.phase, palette: palette)
                .ignoresSafeArea()
            VStack(spacing: ShannonSpacing.small) {
                header(palette)
                if let appLook {
                    ShannonAppLookStateBadge(coordinator: appLook, othersPresent: ShannonAppLookVisibleState.othersPresent(
                        callIsLive: model.phase != .idle, participantMode: model.participantMode))
                }
                GeometryReader { proxy in
                    ScrollView {
                        conversationContent(palette)
                            .frame(maxWidth: .infinity, minHeight: proxy.size.height)
                    }
                    .scrollBounceBehavior(.basedOnSize)
                    .scrollDismissesKeyboard(.interactively)
                }
            }
            .padding(.horizontal, ShannonSpacing.large)
            .padding(.top, ShannonSpacing.small)
        }
        .foregroundStyle(palette.textPrimary)
        .safeAreaInset(edge: .bottom, spacing: 0) {
            controlDock(palette)
        }
        .fullScreenCover(isPresented: $workspace.showsCamera) {
            ShannonVoiceCameraPicker(onCapture: receiveCameraImage, onCancel: { workspace.showsCamera = false })
                .ignoresSafeArea()
        }
        .sheet(item: permissionPrimerKind) { kind in
            permissionPrimerSheet(kind)
                .presentationDetents([.large])
                .presentationDragIndicator(.visible)
        }
        .photosPicker(isPresented: $workspace.showsPhotoLibrary, selection: $workspace.selectedLibraryPhoto, matching: .images)
        .onChange(of: workspace.selectedLibraryPhoto) {
            guard let selectedLibraryPhoto = workspace.selectedLibraryPhoto else { return }
            Task { await receiveLibraryPhoto(selectedLibraryPhoto) }
        }
        .confirmationDialog("写真を共有", isPresented: $workspace.showsPhotoSource) {
            Button("写真を撮る") { presentCamera() }
            Button("写真ライブラリから選ぶ") { workspace.showsPhotoLibrary = true }
            Button("キャンセル", role: .cancel) {}
        }
        .confirmationDialog(
            model.participantMode == .owner ? ShannonVoiceGuestModeCopy.switchToGuestTitle
                : ShannonVoiceGuestModeCopy.switchToOwnerTitle,
            isPresented: $workspace.showsParticipantModePicker, titleVisibility: .visible
        ) {
            if model.participantMode == .owner {
                Button("友人も一緒にする") { switchParticipantMode(to: .guest) }
            } else {
                Button("本人だけに戻す") { switchParticipantMode(to: .owner) }
            }
            Button("キャンセル", role: .cancel) {}
        } message: {
            Text(model.participantMode == .owner ? ShannonVoiceGuestModeCopy.switchToGuestMessage
                : ShannonVoiceGuestModeCopy.switchToOwnerMessage)
        }
        .alert(ShannonVoiceGuestModeCopy.photoUnavailableTitle, isPresented: $workspace.showsPhotoUnavailable) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(ShannonVoiceGuestModeCopy.photoUnavailableMessage)
        }
        .confirmationDialog("入力マイク", isPresented: $workspace.showsInputPicker, titleVisibility: .visible) {
            ForEach(ShannonVoiceInputPreference.allCases.filter { model.inputState.canSelect($0) }) { preference in
                Button(preference.japaneseLabel) { model.selectInput(preference) }
            }
            Button("キャンセル", role: .cancel) {}
        } message: {
            if model.inputState.activeInputName != nil { Text(model.inputState.activeInputLabel) }
        }
        .task {
            // A retained draft reopens with its composer after minimization.
            if !workspace.typedMessage.isEmpty { workspace.showsTextComposer = true }
#if DEBUG
            if ProcessInfo.processInfo.arguments.contains("-ShannonPreviewVoiceKeyboard") {
                if workspace.typedMessage.isEmpty {
                    workspace.typedMessage = "さっきの依頼の続きです。\nAetherの最新ノートも一緒に確認してほしい。"
                }
                workspace.showsTextComposer = true
                composerIsFocused = true
            }
#endif
        }
        .onChange(of: model.textSendState) {
            guard workspace.typedMessage.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                  let failedText = model.textSendState.failedText else { return }
            workspace.typedMessage = failedText
            workspace.showsTextComposer = true
        }
    }

    private var statusPresentation: ShannonGeminiLiveStatusPresentation {
        ShannonGeminiLiveStatusPresentation(
            phase: model.phase,
            failureRecovery: model.failureRecovery,
            errorMessage: model.errorMessage,
            isMuted: model.isMicrophoneMuted,
            hasConversation: !model.userTranscript.isEmpty || !model.shannonTranscript.isEmpty
        )
    }

    private func conversationContent(_ palette: ShannonPalette) -> some View {
        VStack(spacing: ShannonSpacing.large) {
            if model.participantMode == .guest {
                ShannonVoiceGuestModeNotice(palette: palette)
                    .frame(maxWidth: 560)
            }
            // The call's own per-turn emotion; before the first reply, the thread's last face.
            ShannonBodyView(
                expression: model.callFace?.expression ?? expression, activity: eyeActivity, size: eyeSize,
                feeling: model.callFace?.feeling, allowsTouch: false, showsLine: false, priority: .voice
            )
                .frame(maxWidth: 440)
            VStack(spacing: ShannonSpacing.medium) {
                ShannonGeminiLiveStatusView(
                    presentation: statusPresentation,
                    level: model.audioLevel,
                    phase: model.phase,
                    palette: palette
                )
                if model.phase == .failed { connectionRecovery }
                subtitles(palette)
            }
            if let task { taskCard(task) }
            if let pendingCameraImage = workspace.pendingCameraImage,
               let pendingCameraData = workspace.pendingCameraData {
                ShannonVoicePhotoPreview(
                    image: pendingCameraImage,
                    palette: palette,
                    fromLibrary: workspace.pendingPhotoFromLibrary,
                    isSharing: workspace.isSharingCameraSnapshot,
                    remove: clearPendingPhoto,
                    chooseAgain: choosePhotoAgain,
                    share: { shareCameraSnapshot(pendingCameraData) }
                )
            }
            if let cameraErrorMessage = workspace.cameraErrorMessage {
                statusMessage(
                    cameraErrorMessage,
                    symbol: "photo.badge.exclamationmark",
                    foreground: palette.onDangerTint,
                    background: palette.dangerTint
                )
            }
            if case let .failed(text, message) = model.textSendState {
                textRetry(text: text, message: message, palette: palette)
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, ShannonSpacing.medium)
    }

    private var eyeSize: CGFloat {
        if composerIsFocused { return 140 }
        if dynamicTypeSize.isAccessibilitySize { return 200 }
        return model.phase == .failed ? 180 : 280
    }

    private func taskCard(_ task: ShannonAgentTask) -> some View {
        Button { composerIsFocused = false; openTask(task.id) } label: {
            VStack(alignment: .leading, spacing: ShannonSpacing.extraSmall) {
                Label(task.status == .proposed ? "実装案ができました" : task.stateName,
                      systemImage: task.status.symbolName)
                    .font(.subheadline.weight(.semibold))
                Text(task.title).font(.body).multilineTextAlignment(.leading)
                Label(task.status == .proposed ? "内容を確認して開始" : "作業を見る",
                      systemImage: "arrow.right")
                    .font(.subheadline.weight(.semibold))
            }
            .frame(maxWidth: .infinity, minHeight: ShannonTouchTarget.minimum, alignment: .leading)
            .padding(ShannonSpacing.medium)
        }
        .buttonStyle(.bordered)
        .frame(maxWidth: 560)
        .accessibilityHint("音声会話は続きます。開始前に作業環境と内容を確認できます。")
    }

    @ViewBuilder
    private func subtitles(_ palette: ShannonPalette) -> some View {
        let lines = ShannonGeminiLiveSubtitles(
            speakerName: model.participantMode.transcriptSpeakerName,
            userTranscript: model.userTranscript,
            shannonTranscript: model.shannonTranscript
        )
        let lineLimit = dynamicTypeSize.isAccessibilitySize ? 4 : 2
        if !lines.isEmpty {
            VStack(spacing: ShannonSpacing.extraSmall) {
                if let user = lines.user {
                    Text(user)
                        .font(.callout)
                        .foregroundStyle(palette.textSecondary)
                        .lineLimit(lineLimit)
                        .truncationMode(.head)
                }
                if let shannon = lines.shannon {
                    Text(shannon)
                        .font(.body)
                        .lineLimit(lineLimit)
                        .truncationMode(.head)
                }
            }
            .multilineTextAlignment(.center)
            .frame(maxWidth: 560)
            // Visible subtitles are bounded; VoiceOver reads the whole current turn.
            // Owner turns remain in the call's pinned Talk thread; 「友人も一緒」 turns are not kept.
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(subtitleAccessibilityLabel)
        }
    }

    private var subtitleAccessibilityLabel: String {
        var parts: [String] = []
        if !model.userTranscript.isEmpty {
            parts.append("\(model.participantMode.transcriptSpeakerName)：\(model.userTranscript)")
        }
        if !model.shannonTranscript.isEmpty { parts.append("シャノン：\(model.shannonTranscript)") }
        return parts.joined(separator: "、")
    }

    private func controlDock(_ palette: ShannonPalette) -> some View {
        VStack(spacing: ShannonSpacing.medium) {
            if workspace.showsTextComposer { composer }
            ShannonGeminiLiveCallControls(
                isMuted: model.isMicrophoneMuted,
                inputState: model.inputState,
                participantMode: model.participantMode,
                isPhotoBusy: workspace.isSharingCameraSnapshot || workspace.isLoadingLibraryPhoto,
                showsTextComposer: workspace.showsTextComposer,
                palette: palette,
                choosePhoto: {
                    composerIsFocused = false
                    if model.participantMode.allowsCameraSharing { workspace.showsPhotoSource = true }
                    else { workspace.showsPhotoUnavailable = true }
                },
                chooseParticipant: { composerIsFocused = false; workspace.showsParticipantModePicker = true },
                toggleMute: model.toggleMicrophoneMute,
                selectInput: { composerIsFocused = false; model.selectInput($0) },
                showInputPicker: { composerIsFocused = false; workspace.showsInputPicker = true },
                toggleTextComposer: toggleTextComposer,
                end: end
            )
        }
        .padding(.horizontal, ShannonSpacing.large)
        .padding(.vertical, ShannonSpacing.medium)
        .background {
            Group {
                if reduceTransparency || contrast == .increased {
                    palette.elevatedSurface
                } else {
                    Rectangle().fill(.regularMaterial)
                }
            }
            .ignoresSafeArea()
        }
        .overlay(alignment: .top) { Rectangle().fill(palette.divider).frame(height: 1) }
    }

    private func toggleTextComposer() {
        if workspace.showsTextComposer {
            composerIsFocused = false
            workspace.showsTextComposer = false
        } else {
            workspace.showsTextComposer = true
            composerIsFocused = true
        }
    }

    private func header(_ palette: ShannonPalette) -> some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: ShannonSpacing.small) {
                minimizeButton
                Spacer(minLength: ShannonSpacing.small)
                voiceTitle(palette)
                Spacer(minLength: ShannonSpacing.small)
                // Mirrors the leading control so the title stays centered.
                minimizeButton.hidden().accessibilityHidden(true)
            }
            VStack(alignment: .leading, spacing: ShannonSpacing.extraSmall) {
                minimizeButton
                voiceTitle(palette).frame(maxWidth: .infinity)
            }
        }
    }

    private func voiceTitle(_ palette: ShannonPalette) -> some View {
        VStack(spacing: 2) {
            Text("シャノン").font(.headline)
            if let callStartedAt = model.callStartedAt {
                TimelineView(.periodic(from: callStartedAt, by: 1)) { context in
                    let seconds = Int(context.date.timeIntervalSince(callStartedAt))
                    Text(ShannonVoiceCallDuration.text(seconds: seconds))
                        .font(.caption.monospacedDigit())
                        .foregroundStyle(palette.textSecondary)
                        .accessibilityLabel(ShannonVoiceCallDuration.accessibilityText(seconds: seconds))
                }
            }
        }
        .fixedSize()
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isHeader)
        .accessibilityHint(ShannonGeminiLiveStatusPresentation.diagnosticsHint(
            provider: model.speechProvider.japaneseName, model: model.model, voice: model.voice))
    }

    private var minimizeButton: some View {
        Button { composerIsFocused = false; minimize() } label: {
            Label("小さく", systemImage: "chevron.down")
                .labelStyle(.titleAndIcon)
                .font(.subheadline.weight(.medium))
                .frame(minHeight: ShannonTouchTarget.minimum)
                .fixedSize()
        }
        .buttonStyle(.bordered)
        .buttonBorderShape(.capsule)
        .accessibilityLabel("音声会話を続けたまま小さくする")
    }

    private var composer: some View {
        HStack(alignment: .bottom, spacing: ShannonSpacing.small) {
            TextField("シャノンに話しかける", text: $workspace.typedMessage, axis: .vertical)
                .textFieldStyle(.plain)
                .lineLimit(1...6)
                .frame(minHeight: ShannonTouchTarget.minimum)
                .padding(.horizontal, ShannonSpacing.small)
                .focused($composerIsFocused)
            Button(action: submitText) {
                Image(systemName: "arrow.up").font(.body.weight(.semibold))
                    .frame(width: ShannonTouchTarget.minimum, height: ShannonTouchTarget.minimum)
            }
                .buttonStyle(.borderedProminent)
                .buttonBorderShape(.circle)
                .disabled(workspace.typedMessage.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                .accessibilityLabel("送信")
        }
        .padding(ShannonSpacing.extraSmall)
        .background(.background, in: RoundedRectangle(cornerRadius: ShannonShape.large, style: .continuous))
    }

    /// The failure text itself is in the status line; this adds only the action.
    @ViewBuilder
    private var connectionRecovery: some View {
        switch model.failureRecovery {
        case .openSettings:
            Button("設定を開く") {
                guard let url = URL(string: UIApplication.openSettingsURLString) else { return }
                openURL(url)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
        case .updateRequired:
            EmptyView()
        case .reconnect, .none:
            Button("もう一度つなぐ") { Task { await model.retry() } }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                .accessibilityHint("会話内容を保ったまま、音声会話へ再接続します。")
        }
    }

    private func textRetry(text: String, message: String, palette: ShannonPalette) -> some View {
        VStack(alignment: .leading, spacing: ShannonSpacing.small) {
            statusMessage(
                message,
                symbol: "arrow.counterclockwise.circle",
                foreground: palette.onAttentionTint,
                background: palette.attentionTint
            )
            Text(text)
                .font(.callout)
                .foregroundStyle(palette.textPrimary)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
            Button("入力を再送") {
                if model.retryText() { workspace.typedMessage = "" }
            }
            .buttonStyle(.bordered)
            .disabled(model.textSendState.isSending)
        }
        .frame(maxWidth: 560)
    }

    private func statusMessage(
        _ message: String,
        symbol: String,
        foreground: Color,
        background: Color
    ) -> some View {
        Label(message, systemImage: symbol)
            .font(.callout)
            .foregroundStyle(foreground)
            .multilineTextAlignment(.leading)
            .padding(ShannonSpacing.medium)
            .frame(maxWidth: 560, alignment: .leading)
            .background(background, in: RoundedRectangle(cornerRadius: ShannonShape.medium, style: .continuous))
    }

    private var eyeActivity: ShannonDialogueActivity {
        switch model.phase {
        case .listening: .listening
        case .thinking, .connecting, .reconnecting: .thinking
        case .speaking: .speaking
        case .idle, .requestingPermission, .failed: .idle
        }
    }

    private func switchParticipantMode(to mode: ShannonVoiceParticipantMode) {
        guard mode != model.participantMode else { return }
        workspace.clearPhoto()
        switchParticipantMode(mode)
    }

    private func submitText() {
        let text = workspace.typedMessage.trimmingCharacters(in: .whitespacesAndNewlines)
        if model.sendText(text) {
            workspace.typedMessage = ""
            composerIsFocused = false
            workspace.showsTextComposer = false
        }
    }
}
#endif
