#if os(iOS)
import PhotosUI
import SwiftUI
import UIKit

public struct ShannonGeminiLiveVoiceView: View {
    @Bindable private var model: ShannonGeminiLiveSessionModel
    private let expression: ShannonExpressionDTO
    private let createSession: @MainActor (ShannonVoiceParticipantMode) async throws -> ShannonGeminiLiveSessionDTO
    private let performDelegation: @MainActor (String, ShannonVoiceUserUtteranceDTO?, ShannonVoiceParticipantMode) async throws -> String
    private let analyzeCameraSnapshot: @MainActor (Data) async throws -> String
    private let synthesize: @MainActor (String, String?) async throws -> ShannonGeminiSpeech
    private let commitTurn: @MainActor (String, String) async throws -> Void
    private let dismiss: () -> Void

    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @State private var didStart = false
    @State private var typedMessage = ""
    @State private var showsParticipantModePicker = false
    @State private var showsPhotoSource = false
    @State private var showsCamera = false
    @State private var showsPhotoLibrary = false
    @State private var selectedLibraryPhoto: PhotosPickerItem?
    @State private var pendingCameraImage: UIImage?
    @State private var pendingCameraData: Data?
    @State private var pendingPhotoFromLibrary = false
    @State private var cameraErrorMessage: String?
    @State private var isSharingCameraSnapshot = false
    @State private var isLoadingLibraryPhoto = false

    public init(
        model: ShannonGeminiLiveSessionModel,
        expression: ShannonExpressionDTO,
        createSession: @escaping @MainActor (ShannonVoiceParticipantMode) async throws -> ShannonGeminiLiveSessionDTO,
        performDelegation: @escaping @MainActor (String, ShannonVoiceUserUtteranceDTO?, ShannonVoiceParticipantMode) async throws -> String,
        analyzeCameraSnapshot: @escaping @MainActor (Data) async throws -> String,
        synthesize: @escaping @MainActor (String, String?) async throws -> ShannonGeminiSpeech,
        commitTurn: @escaping @MainActor (String, String) async throws -> Void,
        dismiss: @escaping () -> Void
    ) {
        self.model = model
        self.expression = expression
        self.createSession = createSession
        self.performDelegation = performDelegation
        self.analyzeCameraSnapshot = analyzeCameraSnapshot
        self.synthesize = synthesize
        self.commitTurn = commitTurn
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
                        ShannonWaterlightEyeView(expression: expression, activity: eyeActivity, size: 250)
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
                        if let error = cameraErrorMessage ?? model.errorMessage {
                            Text(error)
                                .font(.callout)
                                .foregroundStyle(palette.danger)
                                .multilineTextAlignment(.center)
                        }
                        metrics(palette)
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, ShannonSpacing.medium)
                }
                if model.phase == .failed {
                    Button("もう一度つなぐ") { Task { await model.retry() } }
                        .buttonStyle(.borderedProminent)
                        .controlSize(.large)
                        .accessibilityLabel("Geminiへ再接続")
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
            await start(.owner)
        }
        .onDisappear { model.stop() }
    }

    private func header(_ palette: ShannonPalette) -> some View {
        HStack {
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
            if model.participantMode.allowsCameraSharing {
                Button { showsPhotoSource = true } label: {
                    Image(systemName: "camera.fill")
                        .frame(width: ShannonTouchTarget.minimum, height: ShannonTouchTarget.minimum)
                }
                .buttonStyle(.bordered)
                .disabled(isSharingCameraSnapshot || isLoadingLibraryPhoto)
                .accessibilityLabel("写真をシャノンに見せる")
            }
            Spacer()
            VStack(spacing: 2) {
                Text("シャノンと音声会話").font(.headline)
                Text("Gemini · \(model.inputState.activeInputLabel)")
                    .font(.caption)
                    .foregroundStyle(palette.textSecondary)
                    .lineLimit(1)
            }
            Spacer()
            Button { showsParticipantModePicker = true } label: {
                Image(systemName: model.participantMode == .owner ? "person.fill" : "person.2.fill")
                    .frame(width: ShannonTouchTarget.minimum, height: ShannonTouchTarget.minimum)
            }
            .buttonStyle(.bordered)
            .accessibilityLabel("音声の参加者、\(model.participantMode.japaneseName)")
            Button(action: close) {
                Image(systemName: "xmark")
                    .frame(width: ShannonTouchTarget.minimum, height: ShannonTouchTarget.minimum)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("音声会話を閉じる")
        }
    }

    private func status(_ palette: ShannonPalette) -> some View {
        VStack(spacing: 4) {
            Text(model.phase.japaneseLabel).font(.title3.weight(.semibold))
            Text("自然に話しかけてください。途中で遮っても大丈夫です。")
                .font(.footnote)
                .foregroundStyle(palette.textSecondary)
                .multilineTextAlignment(.center)
        }
    }

    private var composer: some View {
        HStack(spacing: ShannonSpacing.small) {
            TextField("テキストでも話しかけられます", text: $typedMessage)
                .textFieldStyle(.roundedBorder)
                .submitLabel(.send)
                .onSubmit(submitText)
            Button(action: submitText) { Image(systemName: "arrow.up.circle.fill").font(.title2) }
                .buttonStyle(.plain)
                .disabled(typedMessage.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                .accessibilityLabel("送信")
        }
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
            synthesize: synthesize,
            commitTurn: commitTurn
        )
    }

    private func switchParticipantMode(to mode: ShannonVoiceParticipantMode) {
        guard mode != model.participantMode else { return }
        clearPendingPhoto()
        Task { await start(mode) }
    }

    private func close() { model.stop(); dismiss() }

    private func submitText() {
        let text = typedMessage
        typedMessage = ""
        model.sendText(text)
    }

    private func clearPendingPhoto() {
        pendingCameraImage = nil
        pendingCameraData = nil
        cameraErrorMessage = nil
    }

    private func choosePhotoAgain() {
        clearPendingPhoto()
        if pendingPhotoFromLibrary { showsPhotoLibrary = true } else { presentCamera() }
    }

    @MainActor
    private func receiveCameraImage(_ image: UIImage) {
        showsCamera = false
        guard let snapshot = image.shannonCameraSnapshot() else {
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
            isLoadingLibraryPhoto = false
            selectedLibraryPhoto = nil
        }
        do {
            let photo = try await ShannonPhotoLibrarySelection.prepare(item)
            guard model.participantMode.allowsCameraSharing else { return }
            pendingCameraImage = photo.preview
            pendingCameraData = photo.jpegData
            pendingPhotoFromLibrary = true
            cameraErrorMessage = nil
        } catch {
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
                clearPendingPhoto()
            } catch {
                cameraErrorMessage = "写真をシャノンへ共有できませんでした。もう一度お試しください。"
            }
        }
    }
}

private struct ShannonGeminiLiveLevelBar: View {
    let level: Float
    let palette: ShannonPalette

    var body: some View {
        GeometryReader { geometry in
            Capsule()
                .fill(palette.intelligenceSoft)
                .overlay(alignment: .leading) {
                    Capsule().fill(palette.brandPresence)
                        .frame(width: max(8, geometry.size.width * CGFloat(level)))
                }
        }
        .frame(height: 5)
        .accessibilityHidden(true)
    }
}
#endif
