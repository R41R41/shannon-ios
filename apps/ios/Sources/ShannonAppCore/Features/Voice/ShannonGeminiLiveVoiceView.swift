#if os(iOS)
import PhotosUI
import SwiftUI
import UIKit

public struct ShannonGeminiLiveVoiceView: View {
    @Bindable var model: ShannonGeminiLiveSessionModel
    @Bindable var workspace: ShannonVoiceWorkspaceState
    private let expression: ShannonExpressionDTO
    private let task: ShannonAgentTask?
    private let switchParticipantMode: (ShannonVoiceParticipantMode) -> Void
    private let openTask: (UUID) -> Void
    private let minimize: () -> Void
    private let end: () -> Void
    let analyzeCameraSnapshot: @MainActor (Data) async throws -> String

    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Environment(\.openURL) private var openURL
    @FocusState private var composerIsFocused: Bool

    init(
        model: ShannonGeminiLiveSessionModel,
        workspace: ShannonVoiceWorkspaceState,
        expression: ShannonExpressionDTO,
        task: ShannonAgentTask?,
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
        self.analyzeCameraSnapshot = analyzeCameraSnapshot
        self.switchParticipantMode = switchParticipantMode
        self.openTask = openTask
        self.minimize = minimize
        self.end = end
    }

    public var body: some View {
        let palette = ShannonPalette.resolve(colorScheme)
        ZStack {
            LinearGradient(
                colors: [palette.canvas, palette.intelligenceSoft.opacity(0.78), palette.canvas],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            )
            .ignoresSafeArea()
            VStack(spacing: ShannonSpacing.medium) {
                header(palette)
                ScrollView {
                    conversationContent(palette)
                }
            }
            .padding(.horizontal, ShannonSpacing.large)
            .padding(.vertical, ShannonSpacing.small)
        }
        .foregroundStyle(palette.textPrimary)
        .safeAreaInset(edge: .bottom, spacing: 0) {
            composerDock(palette)
        }
        .fullScreenCover(isPresented: $workspace.showsCamera) {
            ShannonVoiceCameraPicker(onCapture: receiveCameraImage, onCancel: { workspace.showsCamera = false })
                .ignoresSafeArea()
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
        .confirmationDialog("音声の参加者", isPresented: $workspace.showsParticipantModePicker, titleVisibility: .visible) {
            Button("本人だけ") { switchParticipantMode(to: .owner) }
            Button("友人も一緒") { switchParticipantMode(to: .guest) }
            Button("キャンセル", role: .cancel) {}
        } message: {
            Text("「友人も一緒」では所有者の履歴や記憶を使わず、この通話を保存しません。切り替えるとGeminiへつなぎ直します。")
        }
        .task {
#if DEBUG
            if ProcessInfo.processInfo.arguments.contains("-ShannonPreviewVoiceKeyboard") {
                if workspace.typedMessage.isEmpty {
                    workspace.typedMessage = "さっきの依頼の続きです。\nAetherの最新ノートも一緒に確認してほしい。"
                }
                composerIsFocused = true
            }
#endif
        }
        .onChange(of: model.textSendState) {
            guard workspace.typedMessage.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                  let failedText = model.textSendState.failedText else { return }
            workspace.typedMessage = failedText
        }
    }

    private func conversationContent(_ palette: ShannonPalette) -> some View {
        VStack(spacing: ShannonSpacing.large) {
            if model.participantMode == .guest {
                ShannonVoiceGuestModeNotice(palette: palette)
            }
            ShannonWaterlightEyeView(
                expression: expression,
                activity: eyeActivity,
                size: model.phase == .failed ? 168 : 250
            )
                .frame(maxWidth: 440)
            status(palette)
            if let task {
                Button { composerIsFocused = false; openTask(task.id) } label: {
                    VStack(alignment: .leading, spacing: ShannonSpacing.extraSmall) {
                        Label(task.status == .proposed ? "実装案ができました" : task.status.japaneseName,
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
            if model.phase != .failed, let error = model.errorMessage {
                statusMessage(error, symbol: "exclamationmark.bubble",
                    foreground: palette.onAttentionTint, background: palette.attentionTint)
            }
            if !model.userTranscript.isEmpty {
                transcriptCard(
                    model.participantMode.transcriptSpeakerName,
                    text: model.userTranscript,
                    palette: palette
                )
            }
            if !model.shannonTranscript.isEmpty {
                transcriptCard("シャノン", text: model.shannonTranscript, palette: palette)
            }
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
            if model.phase == .failed, let error = model.errorMessage {
                connectionRecovery(error, palette: palette)
            }
            if case let .failed(text, message) = model.textSendState {
                textRetry(text: text, message: message, palette: palette)
            }
            metrics(palette)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, ShannonSpacing.medium)
    }

    private func composerDock(_ palette: ShannonPalette) -> some View {
        VStack(spacing: ShannonSpacing.small) {
            HStack(spacing: ShannonSpacing.small) {
                ShannonGeminiLiveLevelBar(level: model.audioLevel, phase: model.phase, palette: palette)
                Text(model.phase == .speaking ? "シャノンが話しています" : model.inputState.activeInputLabel)
                    .font(.caption)
                    .foregroundStyle(palette.textSecondary)
                Spacer(minLength: 0)
                if composerIsFocused {
                    Button { composerIsFocused = false } label: {
                        Image(systemName: "keyboard.chevron.compact.down")
                            .frame(width: ShannonTouchTarget.minimum, height: ShannonTouchTarget.minimum)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("キーボードを閉じる")
                }
            }
            composer
        }
        .padding(.horizontal, ShannonSpacing.large)
        .padding(.vertical, ShannonSpacing.small)
        .background(.regularMaterial)
    }

    private func header(_ palette: ShannonPalette) -> some View {
        VStack(alignment: .leading, spacing: ShannonSpacing.small) {
            let titleLayout = dynamicTypeSize.isAccessibilitySize
                ? AnyLayout(VStackLayout(alignment: .leading, spacing: ShannonSpacing.extraSmall))
                : AnyLayout(HStackLayout(spacing: ShannonSpacing.small))
            titleLayout {
                voiceTitle(palette)
                if !dynamicTypeSize.isAccessibilitySize { Spacer(minLength: ShannonSpacing.small) }
                HStack(spacing: ShannonSpacing.small) {
                    minimizeButton
                    Button(role: .destructive, action: end) {
                        Label("終了", systemImage: "phone.down.fill")
                            .frame(minHeight: ShannonTouchTarget.minimum)
                    }
                    .buttonStyle(.bordered)
                    .accessibilityLabel("音声会話を終了する")
                }
                .font(.subheadline.weight(.medium))
            }
            let layout = dynamicTypeSize.isAccessibilitySize
                ? AnyLayout(VStackLayout(alignment: .leading, spacing: ShannonSpacing.extraSmall))
                : AnyLayout(HStackLayout(spacing: ShannonSpacing.small))
            layout {
                inputMenu
                if model.participantMode.allowsCameraSharing { cameraButton }
                participantButton
            }
            .font(.subheadline.weight(.medium))
            .labelStyle(.titleAndIcon)
        }
    }

    private var inputMenu: some View {
        Menu {
            ForEach(ShannonVoiceInputPreference.allCases) { preference in
                Button { composerIsFocused = false; model.selectInput(preference) } label: {
                    Label(preference.japaneseLabel, systemImage: preference.systemImage)
                }
                .disabled(!model.inputState.canSelect(preference))
            }
        } label: {
            Label("マイク", systemImage: "mic")
                .frame(maxWidth: .infinity, minHeight: ShannonTouchTarget.minimum)
        }
        .buttonStyle(.bordered)
        .accessibilityLabel("入力マイク、\(model.inputState.preference.japaneseLabel)")
    }

    private var cameraButton: some View {
        Button { composerIsFocused = false; workspace.showsPhotoSource = true } label: {
            Label("写真", systemImage: "camera")
                .frame(maxWidth: .infinity, minHeight: ShannonTouchTarget.minimum)
        }
        .buttonStyle(.bordered)
        .disabled(workspace.isSharingCameraSnapshot || workspace.isLoadingLibraryPhoto)
        .accessibilityLabel("写真をシャノンに見せる")
    }

    private func voiceTitle(_ palette: ShannonPalette) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text("シャノンと音声会話").font(.headline)
            if !dynamicTypeSize.isAccessibilitySize {
                Text("Gemini · \(model.inputState.activeInputLabel)")
                    .font(.caption)
                    .foregroundStyle(palette.textSecondary)
                    .lineLimit(1)
            }
        }
    }

    private var participantButton: some View {
        Button { composerIsFocused = false; workspace.showsParticipantModePicker = true } label: {
            Label("人物", systemImage: model.participantMode == .owner ? "person" : "person.2")
                .frame(maxWidth: .infinity, minHeight: ShannonTouchTarget.minimum)
        }
        .buttonStyle(.bordered)
        .accessibilityLabel("音声の参加者、\(model.participantMode.japaneseName)")
    }

    private var minimizeButton: some View {
        Button { composerIsFocused = false; minimize() } label: {
            Label("小さく", systemImage: "chevron.down")
                .frame(minHeight: ShannonTouchTarget.minimum)
        }
        .buttonStyle(.bordered)
        .accessibilityLabel("音声会話を続けたまま小さくする")
    }

    private func status(_ palette: ShannonPalette) -> some View {
        ShannonGeminiLiveStatusView(
            phase: model.phase,
            failureRecovery: model.failureRecovery,
            palette: palette
        )
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

    private func connectionRecovery(_ message: String, palette: ShannonPalette) -> some View {
        VStack(spacing: ShannonSpacing.medium) {
            statusMessage(
                message,
                symbol: model.failureRecovery == .openSettings ? "mic.slash.fill" : "wifi.exclamationmark",
                foreground: palette.onDangerTint,
                background: palette.dangerTint
            )
            switch model.failureRecovery {
            case .openSettings:
                Button("設定を開く") {
                    guard let url = URL(string: UIApplication.openSettingsURLString) else { return }
                    openURL(url)
                }
                .buttonStyle(.borderedProminent)
            case .updateRequired:
                Text("最新版へ更新してから、もう一度開いてください。")
                    .font(.footnote)
                    .foregroundStyle(palette.textSecondary)
            case .reconnect, .none:
                Button("もう一度つなぐ") { Task { await model.retry() } }
                    .buttonStyle(.borderedProminent)
                    .accessibilityLabel("Geminiへ再接続")
            }
        }
        .controlSize(.large)
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

    private func transcriptCard(_ speaker: String, text: String, palette: ShannonPalette) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(speaker).font(.caption.weight(.semibold)).foregroundStyle(palette.textSecondary)
            Text(text).font(.body).frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(ShannonSpacing.medium)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: ShannonShape.large, style: .continuous))
        .frame(maxWidth: 560)
    }

    private func metrics(_ palette: ShannonPalette) -> some View {
        VStack(spacing: 5) {
            Text("\(model.model) · \(model.voice)")
            HStack(spacing: ShannonSpacing.medium) {
                if let latency = model.firstAudioLatencyMilliseconds { Label("応答 \(latency) ms", systemImage: "timer") }
                if let latency = model.interruptionLatencyMilliseconds { Label("割込 \(latency) ms", systemImage: "waveform.badge.minus") }
            }
            Text("今回の音声 約$\(model.estimatedCostUsd.formatted(.number.precision(.fractionLength(5))))")
        }
        .font(.caption.monospacedDigit())
        .foregroundStyle(palette.textSecondary)
        .multilineTextAlignment(.center)
        .accessibilityElement(children: .combine)
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
        }
    }

}
#endif
