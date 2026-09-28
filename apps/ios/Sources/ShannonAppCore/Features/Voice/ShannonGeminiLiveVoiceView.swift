#if os(iOS)
import PhotosUI
import SwiftUI
import UIKit

public struct ShannonGeminiLiveVoiceView: View {
    @Bindable var model: ShannonGeminiLiveSessionModel
    private let expression: ShannonExpressionDTO
    private let createSession: @MainActor (ShannonVoiceParticipantMode) async throws -> ShannonGeminiLiveSessionDTO
    private let performDelegation: @MainActor (String, ShannonVoiceUserUtteranceDTO?, ShannonVoiceParticipantMode) async throws -> ShannonLiveVoiceDelegationResponseDTO
    private let performStreamingDelegation: ShannonVoiceStreamingDelegation
    let analyzeCameraSnapshot: @MainActor (Data) async throws -> String
    private let streamSpeech: @MainActor (String, String?) async throws -> ShannonGeminiSpeechStream
    private let commitTurn: @MainActor (String, String) async throws -> Void
    private let handleDelegationResponse: @MainActor (ShannonLiveVoiceDelegationResponseDTO) -> Void
    private let dismiss: () -> Void

    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Environment(\.openURL) private var openURL
    @State private var didStart = false
    @State private var typedMessage = ""
    @State private var showsParticipantModePicker = false
    @State private var showsPhotoSource = false
    @State var showsCamera = false
    @State var showsPhotoLibrary = false
    @State var selectedLibraryPhoto: PhotosPickerItem?
    @State var pendingCameraImage: UIImage?
    @State var pendingCameraData: Data?
    @State var pendingPhotoFromLibrary = false
    @State var cameraErrorMessage: String?
    @State var isSharingCameraSnapshot = false
    @State var isLoadingLibraryPhoto = false
    @FocusState private var composerIsFocused: Bool

    public init(
        model: ShannonGeminiLiveSessionModel,
        expression: ShannonExpressionDTO,
        createSession: @escaping @MainActor (ShannonVoiceParticipantMode) async throws -> ShannonGeminiLiveSessionDTO,
        performDelegation: @escaping @MainActor (String, ShannonVoiceUserUtteranceDTO?, ShannonVoiceParticipantMode) async throws -> ShannonLiveVoiceDelegationResponseDTO,
        performStreamingDelegation: @escaping ShannonVoiceStreamingDelegation,
        analyzeCameraSnapshot: @escaping @MainActor (Data) async throws -> String,
        streamSpeech: @escaping @MainActor (String, String?) async throws -> ShannonGeminiSpeechStream,
        commitTurn: @escaping @MainActor (String, String) async throws -> Void,
        handleDelegationResponse: @escaping @MainActor (ShannonLiveVoiceDelegationResponseDTO) -> Void,
        dismiss: @escaping () -> Void
    ) {
        self.model = model
        self.expression = expression
        self.createSession = createSession
        self.performDelegation = performDelegation
        self.performStreamingDelegation = performStreamingDelegation
        self.analyzeCameraSnapshot = analyzeCameraSnapshot
        self.streamSpeech = streamSpeech
        self.commitTurn = commitTurn
        self.handleDelegationResponse = handleDelegationResponse
        self.dismiss = dismiss
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
            ShannonVoiceGlowLayer(
                phase: .init(model.phase),
                microphoneLevel: Double(model.audioLevel),
                playbackLevel: model.playbackLevel,
                isMuted: false,
                usesCompactHeight: dynamicTypeSize.isAccessibilitySize
            )
            VStack(spacing: ShannonSpacing.medium) {
                header(palette)
                ScrollView {
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
                        if let pendingCameraImage, let pendingCameraData {
                            ShannonVoicePhotoPreview(
                                image: pendingCameraImage,
                                palette: palette,
                                fromLibrary: pendingPhotoFromLibrary,
                                isSharing: isSharingCameraSnapshot,
                                remove: clearPendingPhoto,
                                chooseAgain: choosePhotoAgain,
                                share: { shareCameraSnapshot(pendingCameraData) }
                            )
                        }
                        if let cameraErrorMessage {
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
                composer
            }
            .padding(.horizontal, ShannonSpacing.large)
            .padding(.vertical, ShannonSpacing.small)
        }
        .foregroundStyle(palette.textPrimary)
        .safeAreaInset(edge: .bottom, spacing: 0) {
            ShannonGeminiLiveLevelBar(level: model.audioLevel, palette: palette)
                .padding(.horizontal, ShannonSpacing.large)
                .padding(.bottom, ShannonSpacing.small)
        }
        .fullScreenCover(isPresented: $showsCamera) {
            ShannonVoiceCameraPicker(onCapture: receiveCameraImage, onCancel: { showsCamera = false })
                .ignoresSafeArea()
        }
        .photosPicker(isPresented: $showsPhotoLibrary, selection: $selectedLibraryPhoto, matching: .images)
        .onChange(of: selectedLibraryPhoto) {
            guard let selectedLibraryPhoto else { return }
            Task { await receiveLibraryPhoto(selectedLibraryPhoto) }
        }
        .confirmationDialog("写真を共有", isPresented: $showsPhotoSource) {
            Button("写真を撮る") { presentCamera() }
            Button("写真ライブラリから選ぶ") { showsPhotoLibrary = true }
            Button("キャンセル", role: .cancel) {}
        }
        .confirmationDialog("音声の参加者", isPresented: $showsParticipantModePicker, titleVisibility: .visible) {
            Button("本人だけ") { switchParticipantMode(to: .owner) }
            Button("友人も一緒") { switchParticipantMode(to: .guest) }
            Button("キャンセル", role: .cancel) {}
        } message: {
            Text("「友人も一緒」では所有者の履歴や記憶を使わず、この通話を保存しません。切り替えるとGeminiへつなぎ直します。")
        }
        .task {
            guard !didStart else { return }
            didStart = true
#if DEBUG
            if ShannonVoiceDesignPreview.isEnabled { model.prepareDesignPreview(); return }
#endif
            await start(.owner)
        }
        .onDisappear { model.stop() }
        .onChange(of: model.textSendState) {
            guard typedMessage.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                  let failedText = model.textSendState.failedText else { return }
            typedMessage = failedText
        }
        .toolbar {
            ToolbarItemGroup(placement: .keyboard) {
                Spacer()
                Button("完了") { composerIsFocused = false }
            }
        }
    }

    private func header(_ palette: ShannonPalette) -> some View {
        ViewThatFits(in: .horizontal) {
            regularHeader(palette)
            compactHeader(palette)
        }
    }

    private func regularHeader(_ palette: ShannonPalette) -> some View {
        HStack(spacing: ShannonSpacing.small) {
            inputMenu
            if model.participantMode.allowsCameraSharing { cameraButton }
            Spacer(minLength: ShannonSpacing.small)
            voiceTitle(palette)
            Spacer(minLength: ShannonSpacing.small)
            participantButton
            closeButton
        }
    }

    private func compactHeader(_ palette: ShannonPalette) -> some View {
        VStack(spacing: ShannonSpacing.extraSmall) {
            HStack {
                voiceTitle(palette)
                Spacer(minLength: ShannonSpacing.small)
                Menu {
                    inputMenu
                    if model.participantMode.allowsCameraSharing { cameraButton }
                    participantButton
                } label: {
                    Label("音声会話の操作", systemImage: "ellipsis.circle")
                        .labelStyle(.iconOnly)
                        .frame(width: ShannonTouchTarget.minimum, height: ShannonTouchTarget.minimum)
                }
                closeButton
            }
            Text(model.inputState.activeInputLabel)
                .font(.caption)
                .foregroundStyle(palette.textSecondary)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private var inputMenu: some View {
        Menu {
            ForEach(ShannonVoiceInputPreference.allCases) { preference in
                Button { model.selectInput(preference) } label: {
                    Label(preference.japaneseLabel, systemImage: preference.systemImage)
                }
                .disabled(!model.inputState.canSelect(preference))
            }
        } label: {
            Image(systemName: "mic.badge.plus")
                .frame(width: ShannonTouchTarget.minimum, height: ShannonTouchTarget.minimum)
        }
        .buttonStyle(.bordered)
        .accessibilityLabel("入力マイク、\(model.inputState.preference.japaneseLabel)")
    }

    private var cameraButton: some View {
        Button { showsPhotoSource = true } label: {
            Image(systemName: "camera.fill")
                .frame(width: ShannonTouchTarget.minimum, height: ShannonTouchTarget.minimum)
        }
        .buttonStyle(.bordered)
        .disabled(isSharingCameraSnapshot || isLoadingLibraryPhoto)
        .accessibilityLabel("写真をシャノンに見せる")
    }

    private func voiceTitle(_ palette: ShannonPalette) -> some View {
        VStack(spacing: 2) {
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
        Button { showsParticipantModePicker = true } label: {
            Image(systemName: model.participantMode == .owner ? "person.fill" : "person.2.fill")
                .frame(width: ShannonTouchTarget.minimum, height: ShannonTouchTarget.minimum)
        }
        .buttonStyle(.bordered)
        .accessibilityLabel("音声の参加者、\(model.participantMode.japaneseName)")
    }

    private var closeButton: some View {
        Button(action: close) {
            Image(systemName: "xmark")
                .frame(width: ShannonTouchTarget.minimum, height: ShannonTouchTarget.minimum)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("音声会話を閉じる")
    }

    private func status(_ palette: ShannonPalette) -> some View {
        ShannonGeminiLiveStatusView(
            phase: model.phase,
            failureRecovery: model.failureRecovery,
            palette: palette
        )
    }

    private var composer: some View {
        HStack(spacing: ShannonSpacing.small) {
            TextField("テキストでも話しかけられます", text: $typedMessage)
                .textFieldStyle(.roundedBorder)
                .submitLabel(.send)
                .onSubmit(submitText)
                .focused($composerIsFocused)
            Button(action: submitText) {
                if model.textSendState.isSending {
                    ProgressView().controlSize(.small)
                } else {
                    Image(systemName: "arrow.up.circle.fill").font(.title2)
                }
            }
                .buttonStyle(.plain)
                .frame(minWidth: ShannonTouchTarget.minimum, minHeight: ShannonTouchTarget.minimum)
                .disabled(
                    typedMessage.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                        || model.textSendState.isSending
                )
                .accessibilityLabel("送信")
        }
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
                if model.retryText() { typedMessage = "" }
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

    private func start(_ mode: ShannonVoiceParticipantMode) async {
        await model.start(
            participantMode: mode,
            createSession: createSession,
            performDelegation: performDelegation,
            performStreamingDelegation: performStreamingDelegation,
            streamSpeech: streamSpeech,
            commitTurn: commitTurn,
            handleDelegationResponse: handleDelegationResponse
        )
    }
    private func switchParticipantMode(to mode: ShannonVoiceParticipantMode) {
        guard mode != model.participantMode else { return }
        clearPendingPhoto()
        Task { await start(mode) }
    }

    private func close() { model.stop(); dismiss() }
    private func submitText() {
        let text = typedMessage.trimmingCharacters(in: .whitespacesAndNewlines)
        if model.sendText(text) {
            typedMessage = ""
            composerIsFocused = false
        }
    }

}
#endif
