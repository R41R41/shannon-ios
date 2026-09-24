import SwiftUI
#if os(iOS)
import UIKit
import PhotosUI
#endif

public struct ShannonLiveVoiceView: View {
    @Bindable private var model: ShannonRealtimeVoiceSessionModel
    private let expression: ShannonExpressionDTO
    private let createCall: @MainActor (String, ShannonVoiceParticipantMode) async throws -> ShannonRealtimeVoiceCallDTO
    private let performLiveDelegation: @MainActor (String, ShannonVoiceUserUtteranceDTO?, ShannonVoiceParticipantMode) async throws -> String
    private let analyzeCameraSnapshot: @MainActor (Data) async throws -> String
    private let commitTurn: @MainActor (String, String) async throws -> Void
    private let dismiss: () -> Void

    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @State private var didStart = false
    @State private var showsParticipantModePicker = false
    @State private var showsTextComposer = false
#if os(iOS)
    @State private var showsCamera = false
    @State private var showsPhotoSource = false
    @State private var showsPhotoLibrary = false
    @State private var selectedLibraryPhoto: PhotosPickerItem?
    @State private var pendingCameraImage: UIImage?
    @State private var pendingCameraData: Data?
    @State private var pendingPhotoFromLibrary = false
    @State private var cameraErrorMessage: String?
    @State private var isSharingCameraSnapshot = false
    @State private var isLoadingLibraryPhoto = false
#endif

    public init(
        model: ShannonRealtimeVoiceSessionModel,
        expression: ShannonExpressionDTO,
        createCall: @escaping @MainActor (String, ShannonVoiceParticipantMode) async throws -> ShannonRealtimeVoiceCallDTO,
        performLiveDelegation: @escaping @MainActor (String, ShannonVoiceUserUtteranceDTO?, ShannonVoiceParticipantMode) async throws -> String,
        analyzeCameraSnapshot: @escaping @MainActor (Data) async throws -> String,
        commitTurn: @escaping @MainActor (String, String) async throws -> Void,
        dismiss: @escaping () -> Void
    ) {
        self.model = model
        self.expression = expression
        self.createCall = createCall
        self.performLiveDelegation = performLiveDelegation
        self.analyzeCameraSnapshot = analyzeCameraSnapshot
        self.commitTurn = commitTurn
        self.dismiss = dismiss
    }

    public var body: some View {
        let palette = ShannonPalette.resolve(colorScheme)
        ZStack {
            LinearGradient(
                colors: [palette.canvas, palette.intelligenceSoft.opacity(0.72), palette.canvas],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            )
            .ignoresSafeArea()

            ShannonVoiceGlowLayer(
                phase: .init(model.phase),
                microphoneLevel: model.microphoneLevel,
                playbackLevel: model.playbackLevel,
                isMuted: model.isMuted,
                usesCompactHeight: dynamicTypeSize.isAccessibilitySize
            )

            VStack(spacing: 0) {
                topBar(palette)
                ScrollView {
                    VStack(spacing: ShannonSpacing.medium) {
                        if model.participantMode == .guest {
                            ShannonVoiceGuestModeNotice(palette: palette)
                        }

                        ZStack(alignment: .bottom) {
                            ShannonWaterlightEyeView(
                                expression: embodiment.expression,
                                activity: embodiment.activity,
                                size: dynamicTypeSize.isAccessibilitySize ? 210 : 260
                            )
                            .frame(maxWidth: 440)

                            if !model.shannonTranscript.isEmpty {
                                transcriptCard(
                                    speaker: "シャノン",
                                    text: model.shannonTranscript,
                                    alignment: .leading,
                                    palette: palette
                                )
                                .padding(.horizontal, ShannonSpacing.large)
                                .padding(.bottom, ShannonSpacing.large)
                                .transition(.opacity.combined(with: .move(edge: .bottom)))
                            }
                        }
                        .frame(minHeight: 260)

                        if !model.userTranscript.isEmpty {
                            transcriptCard(
                                speaker: model.participantMode.transcriptSpeakerName,
                                text: model.userTranscript,
                                alignment: .trailing,
                                palette: palette
                            )
                            .transition(.opacity.combined(with: .move(edge: .bottom)))
                        }

                        if let error = model.errorMessage {
                            Text(error)
                                .font(.callout)
                                .foregroundStyle(palette.danger)
                                .multilineTextAlignment(.center)
                                .padding(.horizontal, ShannonSpacing.large)
                        }

                        if let startedAt = model.sessionStartedAt {
                            TimelineView(.periodic(from: .now, by: 1)) { context in
                                ViewThatFits(in: .horizontal) {
                                    HStack(spacing: ShannonSpacing.medium) {
                                        sessionMetricLabels(startedAt: startedAt, now: context.date)
                                    }
                                    VStack(alignment: .leading, spacing: 4) {
                                        sessionMetricLabels(startedAt: startedAt, now: context.date)
                                    }
                                }
                                .font(.caption.monospacedDigit())
                                .foregroundStyle(palette.textSecondary)
                                .accessibilityElement(children: .combine)
                            }
                        }

#if os(iOS)
                        if let pendingCameraImage, let pendingCameraData {
                            ShannonVoicePhotoPreview(
                                image: pendingCameraImage,
                                palette: palette,
                                fromLibrary: pendingPhotoFromLibrary,
                                isSharing: isSharingCameraSnapshot,
                                remove: {
                                    self.pendingCameraImage = nil
                                    self.pendingCameraData = nil
                                    cameraErrorMessage = nil
                                },
                                chooseAgain: {
                                    self.pendingCameraImage = nil
                                    self.pendingCameraData = nil
                                    if pendingPhotoFromLibrary {
                                        showsPhotoLibrary = true
                                    } else {
                                        presentCamera()
                                    }
                                },
                                share: { shareCameraSnapshot(pendingCameraData) }
                            )
                        }

                        if let cameraErrorMessage {
                            Text(cameraErrorMessage)
                                .font(.callout)
                                .foregroundStyle(palette.danger)
                                .multilineTextAlignment(.center)
                        }
#endif
                    }
                    .padding(.horizontal, ShannonSpacing.large)
                    .padding(.bottom, ShannonSpacing.medium)
                }
                .scrollIndicators(.hidden)
            }
        }
        .foregroundStyle(palette.textPrimary)
        .safeAreaInset(edge: .bottom, spacing: 0) {
            VStack(spacing: ShannonSpacing.small) {
                if showsTextComposer && model.phase != .failed {
                    ShannonVoiceTextComposer(
                        model: model,
                        palette: palette,
                        onDismiss: { showsTextComposer = false }
                    )
                    .transition(.move(edge: .bottom).combined(with: .opacity))
                }
                controls(palette)
            }
                .frame(maxWidth: .infinity)
                .padding(.horizontal, ShannonSpacing.large)
                .padding(.vertical, ShannonSpacing.small)
                .background(.ultraThinMaterial)
                .animation(
                    reduceMotion ? nil : .snappy(duration: 0.24, extraBounce: 0),
                    value: showsTextComposer
                )
        }
#if os(iOS)
        .fullScreenCover(isPresented: $showsCamera) {
            ShannonVoiceCameraPicker(
                onCapture: receiveCameraImage,
                onCancel: { showsCamera = false }
            )
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
#endif
        .task {
            guard !didStart, !ShannonVoiceDesignPreview.isEnabled else { return }
            didStart = true
            await model.start(
                participantMode: .owner,
                createCall: createCall,
                performLiveDelegation: performLiveDelegation,
                commitTurn: commitTurn
            )
        }
        .onDisappear { model.stop() }
        .confirmationDialog(
            "音声の参加者",
            isPresented: $showsParticipantModePicker,
            titleVisibility: .visible
        ) {
            Button("本人だけ") { switchParticipantMode(to: .owner) }
            Button("友人も一緒") { switchParticipantMode(to: .guest) }
            Button("キャンセル", role: .cancel) {}
        } message: {
            Text("「友人も一緒」では話者を識別せず、この通話を履歴・個人記憶へ保存しません。切り替えると音声をつなぎ直します。")
        }
    }

    @ViewBuilder
    private func sessionMetricLabels(startedAt: Date, now: Date) -> some View {
        Label(
            ShannonRealtimeVoiceBudgetPolicy.remainingLabel(startedAt: startedAt, now: now),
            systemImage: "clock"
        )
        if let dailyRemainingSeconds = model.dailyRemainingSeconds {
            Label(
                ShannonRealtimeVoiceBudgetPolicy.dailyRemainingLabel(seconds: dailyRemainingSeconds),
                systemImage: "calendar"
            )
        }
        if model.usage.totalTokens > 0 {
            Label(
                "\(model.usage.totalTokens.formatted()) トークン",
                systemImage: "waveform.badge.magnifyingglass"
            )
        }
    }

    private func topBar(_ palette: ShannonPalette) -> some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text("シャノン")
                    .font(.headline)
                if !dynamicTypeSize.isAccessibilitySize {
                    Text(embodiment.statusLabel)
                        .font(.caption)
                        .foregroundStyle(palette.textSecondary)
                }
            }
            Spacer()
            ShannonVoiceInputMenu(model: model)
            Button { showsParticipantModePicker = true } label: {
                Image(systemName: model.participantMode == .owner ? "person.fill" : "person.2.fill")
                    .font(.body.weight(.semibold))
                    .frame(width: ShannonTouchTarget.minimum, height: ShannonTouchTarget.minimum)
            }
            .buttonStyle(.bordered)
            .accessibilityLabel("音声の参加者、\(model.participantMode.japaneseName)")
            .accessibilityHint("本人だけ、または友人も一緒を選びます")
            Button {
                model.stop()
                dismiss()
            } label: {
                Image(systemName: "xmark")
                    .font(.body.weight(.semibold))
                    .frame(width: ShannonTouchTarget.minimum, height: ShannonTouchTarget.minimum)
                    .background(.thinMaterial, in: Circle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("音声会話を閉じる")
        }
        .padding(.horizontal, ShannonSpacing.large)
        .padding(.top, ShannonSpacing.small)
    }

    private func transcriptCard(
        speaker: String,
        text: String,
        alignment: Alignment,
        palette: ShannonPalette
    ) -> some View {
        VStack(alignment: alignment == .leading ? .leading : .trailing, spacing: 4) {
            Text(speaker)
                .font(.caption2.weight(.semibold))
                .foregroundStyle(palette.textSecondary)
            Text(text)
                .font(.body)
                .lineSpacing(2)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: alignment)
        }
        .padding(.horizontal, ShannonSpacing.medium)
        .padding(.vertical, ShannonSpacing.small)
        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: ShannonShape.large, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: ShannonShape.large, style: .continuous)
                .stroke(palette.divider.opacity(0.7), lineWidth: 0.7)
        }
    }

    private func controls(_ palette: ShannonPalette) -> some View {
        HStack(spacing: ShannonSpacing.large) {
            if model.phase == .failed {
                Button {
                    Task {
                        await model.start(
                            participantMode: model.participantMode,
                            createCall: createCall,
                            performLiveDelegation: performLiveDelegation,
                            commitTurn: commitTurn
                        )
                    }
                } label: {
                    Image(systemName: "arrow.clockwise")
                        .font(.title3)
                        .frame(width: 52, height: 52)
                        .background(.thinMaterial, in: Circle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("もう一度つなぐ")
            } else {
                Button { model.toggleMute() } label: {
                    Image(systemName: model.isMuted ? "mic.slash.fill" : "mic.fill")
                        .font(.title3)
                        .frame(width: 52, height: 52)
                        .background(.thinMaterial, in: Circle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(model.isMuted ? "ミュートを解除" : "ミュート")
            }

            Button {
                model.stop()
                dismiss()
            } label: {
                Image(systemName: "phone.down.fill")
                    .font(.title3)
                    .foregroundStyle(.white)
                    .frame(width: 64, height: 64)
                    .background(Color.shannonDanger.opacity(0.88), in: Circle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("音声会話を終了")

#if os(iOS)
            if model.participantMode.allowsCameraSharing {
                Button {
                    showsPhotoSource = true
                } label: {
                    Image(systemName: "camera.fill")
                        .font(.title3)
                        .frame(width: 52, height: 52)
                        .background(.thinMaterial, in: Circle())
                }
                .buttonStyle(.plain)
                .disabled(!model.phase.keepsSessionActive || isSharingCameraSnapshot || isLoadingLibraryPhoto)
                .accessibilityLabel("写真をシャノンに見せる")
                .accessibilityHint("撮影するか写真ライブラリから選び、確認してから共有できます")
            }
#endif

            Button {
                showsTextComposer.toggle()
            } label: {
                Image(systemName: showsTextComposer ? "keyboard.chevron.compact.down" : "keyboard")
                    .font(.title3)
                    .frame(width: 52, height: 52)
                    .background(.thinMaterial, in: Circle())
            }
            .buttonStyle(.plain)
            .disabled(model.phase == .failed || !model.phase.keepsSessionActive)
            .accessibilityLabel(showsTextComposer ? "テキスト入力を閉じる" : "テキストで入力")
        }
    }

    private func switchParticipantMode(to mode: ShannonVoiceParticipantMode) {
        guard mode != model.participantMode else { return }
#if os(iOS)
        pendingCameraImage = nil
        pendingCameraData = nil
        selectedLibraryPhoto = nil
        isLoadingLibraryPhoto = false
        cameraErrorMessage = nil
#endif
        Task {
            await model.start(
                participantMode: mode,
                createCall: createCall,
                performLiveDelegation: performLiveDelegation,
                commitTurn: commitTurn
            )
        }
    }

#if os(iOS)
    @MainActor
    private func receiveCameraImage(_ image: UIImage) {
        showsCamera = false
        guard let snapshot = image.shannonCameraSnapshot() else {
            pendingCameraImage = nil
            pendingCameraData = nil
            cameraErrorMessage = "写真を共有用に準備できませんでした。撮り直してください。"
            return
        }
        pendingCameraImage = snapshot.preview
        pendingCameraData = snapshot.data
        pendingPhotoFromLibrary = false
        cameraErrorMessage = nil
    }

    @MainActor
    private func receiveLibraryPhoto(_ item: PhotosPickerItem) async {
        isLoadingLibraryPhoto = true
        defer {
            if selectedLibraryPhoto == item {
                isLoadingLibraryPhoto = false
                selectedLibraryPhoto = nil
            }
        }
        do {
            let photo = try await ShannonPhotoLibrarySelection.prepare(item)
            guard selectedLibraryPhoto == item,
                  model.participantMode.allowsCameraSharing,
                  model.phase.keepsSessionActive else { return }
            pendingCameraImage = photo.preview
            pendingCameraData = photo.jpegData
            pendingPhotoFromLibrary = true
            cameraErrorMessage = nil
        } catch {
            guard selectedLibraryPhoto == item else { return }
            cameraErrorMessage = (error as? LocalizedError)?.errorDescription
                ?? "写真を読み込めませんでした。もう一度お試しください。"
        }
    }

    @MainActor
    private func presentCamera() {
        cameraErrorMessage = nil
        guard UIImagePickerController.isSourceTypeAvailable(.camera) else {
            cameraErrorMessage = "この端末ではカメラを利用できません。実機でお試しください。"
            return
        }
        showsCamera = true
    }

    private func shareCameraSnapshot(_ data: Data) {
        guard !isSharingCameraSnapshot else { return }
        isSharingCameraSnapshot = true
        cameraErrorMessage = nil
        Task { @MainActor in
            defer { isSharingCameraSnapshot = false }
            do {
                try await model.shareCameraSnapshot(jpegData: data, analyze: analyzeCameraSnapshot)
                pendingCameraImage = nil
                pendingCameraData = nil
            } catch {
                cameraErrorMessage = "写真をシャノンへ共有できませんでした。もう一度お試しください。"
            }
        }
    }
#endif

    private var embodiment: ShannonVoiceEmbodimentFrame {
        .init(phase: model.phase, pendingTools: model.pendingToolCount, expression: expression)
    }
}
