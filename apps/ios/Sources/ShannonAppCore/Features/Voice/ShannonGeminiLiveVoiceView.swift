#if os(iOS)
import SwiftUI

public struct ShannonGeminiLiveVoiceView: View {
    @Bindable private var model: ShannonGeminiLiveSessionModel
    private let expression: ShannonExpressionDTO
    private let createSession: @MainActor () async throws -> ShannonGeminiLiveSessionDTO
    private let performDelegation: @MainActor (String, ShannonVoiceUserUtteranceDTO?) async throws -> String
    private let commitTurn: @MainActor (String, String) async throws -> Void
    private let dismiss: () -> Void

    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @State private var didStart = false

    public init(
        model: ShannonGeminiLiveSessionModel,
        expression: ShannonExpressionDTO,
        createSession: @escaping @MainActor () async throws -> ShannonGeminiLiveSessionDTO,
        performDelegation: @escaping @MainActor (String, ShannonVoiceUserUtteranceDTO?) async throws -> String,
        commitTurn: @escaping @MainActor (String, String) async throws -> Void,
        dismiss: @escaping () -> Void
    ) {
        self.model = model
        self.expression = expression
        self.createSession = createSession
        self.performDelegation = performDelegation
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
                        ShannonWaterlightEyeView(
                            expression: expression,
                            activity: eyeActivity,
                            size: 250
                        )
                        .frame(maxWidth: 440)

                        VStack(spacing: 4) {
                            Text(model.phase.japaneseLabel)
                                .font(.title3.weight(.semibold))
                            Text("自然に話しかけてください。途中で遮っても大丈夫です。")
                                .font(.footnote)
                                .foregroundStyle(palette.textSecondary)
                                .multilineTextAlignment(.center)
                        }

                        if !model.userTranscript.isEmpty {
                            transcriptCard("あなた", text: model.userTranscript, palette: palette)
                        }
                        if !model.shannonTranscript.isEmpty {
                            transcriptCard("シャノン", text: model.shannonTranscript, palette: palette)
                        }
                        if let error = model.errorMessage {
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
                    Button("もう一度つなぐ") {
                        Task { await model.retry() }
                    }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.large)
                    .accessibilityLabel("Gemini Liveへ再接続")
                }
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
        .task {
            guard !didStart else { return }
            didStart = true
            await model.start(
                createSession: createSession,
                performDelegation: performDelegation,
                commitTurn: commitTurn
            )
        }
        .onDisappear { model.stop() }
    }

    private func header(_ palette: ShannonPalette) -> some View {
        HStack {
            Button(action: close) {
                Image(systemName: "xmark")
                    .frame(width: ShannonTouchTarget.minimum, height: ShannonTouchTarget.minimum)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Gemini Liveを閉じる")
            Spacer()
            VStack(spacing: 2) {
                Text("Gemini 3.8 Live")
                    .font(.headline)
                Text("リアルタイム実験")
                    .font(.caption)
                    .foregroundStyle(palette.textSecondary)
            }
            Spacer()
            Color.clear.frame(width: ShannonTouchTarget.minimum, height: ShannonTouchTarget.minimum)
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

    @ViewBuilder
    private func transcriptCard(_ speaker: String, text: String, palette: ShannonPalette) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(speaker)
                .font(.caption.weight(.semibold))
                .foregroundStyle(palette.textSecondary)
            Text(text)
                .font(.body)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(ShannonSpacing.medium)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: ShannonShape.large, style: .continuous))
        .frame(maxWidth: 560)
    }

    private func metrics(_ palette: ShannonPalette) -> some View {
        VStack(spacing: 5) {
            Text("\(model.model) · \(model.voice)")
            HStack(spacing: ShannonSpacing.medium) {
                if let latency = model.firstAudioLatencyMilliseconds {
                    Label("応答 \(latency) ms", systemImage: "timer")
                }
                if let latency = model.interruptionLatencyMilliseconds {
                    Label("割込 \(latency) ms", systemImage: "waveform.badge.minus")
                }
            }
            Text("今回の音声 約$\(model.estimatedCostUsd.formatted(.number.precision(.fractionLength(5))))")
        }
        .font(.caption.monospacedDigit())
        .foregroundStyle(palette.textSecondary)
        .multilineTextAlignment(.center)
        .accessibilityElement(children: .combine)
    }

    private func close() {
        model.stop()
        dismiss()
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
                    Capsule()
                        .fill(palette.brandPresence)
                        .frame(width: max(8, geometry.size.width * CGFloat(level)))
                }
        }
        .frame(height: 5)
        .accessibilityHidden(true)
    }
}
#endif
