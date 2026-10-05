import SwiftUI

public struct ShannonGeminiVoiceView: View {
    @Bindable private var voiceModel: ShannonVoiceConversationModel
    private let expression: ShannonExpressionDTO
    private let transcribe: @MainActor (ShannonVoiceRecording) async throws -> String
    private let reply: @MainActor (String) async throws -> String
    private let synthesize: @MainActor (String) async throws -> ShannonGeminiSpeech
    private let dismiss: () -> Void

    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @State private var userTranscript = ""
    @State private var shannonTranscript = ""
    @State private var latestSpeech: ShannonGeminiSpeech?
    @State private var didStart = false
    @State private var turnTask: Task<Void, Never>?

    public init(
        voiceModel: ShannonVoiceConversationModel,
        expression: ShannonExpressionDTO,
        transcribe: @escaping @MainActor (ShannonVoiceRecording) async throws -> String,
        reply: @escaping @MainActor (String) async throws -> String,
        synthesize: @escaping @MainActor (String) async throws -> ShannonGeminiSpeech,
        dismiss: @escaping () -> Void
    ) {
        self.voiceModel = voiceModel
        self.expression = expression
        self.transcribe = transcribe
        self.reply = reply
        self.synthesize = synthesize
        self.dismiss = dismiss
    }

    public var body: some View {
        let palette = ShannonPalette.resolve(colorScheme)
        ZStack {
            LinearGradient(
                colors: [palette.canvas, palette.intelligenceSoft.opacity(0.7), palette.canvas],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            )
            .ignoresSafeArea()

            ShannonVoiceGlowLayer(
                phase: .init(voiceModel.phase),
                microphoneLevel: 0,
                playbackLevel: 0,
                isMuted: false,
                usesCompactHeight: dynamicTypeSize.isAccessibilitySize
            )

            VStack(spacing: ShannonSpacing.large) {
                HStack {
                    Button(action: close) {
                        Image(systemName: "xmark")
                            .frame(width: ShannonTouchTarget.minimum, height: ShannonTouchTarget.minimum)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Gemini音声を閉じる")
                    Spacer()
                    VStack(spacing: 2) {
                        Text("Gemini音声 · 試験版")
                            .font(.shannon(.headline))
                        Text("ターン制")
                            .font(.shannon(.caption))
                            .foregroundStyle(palette.textSecondary)
                    }
                    Spacer()
                    Color.clear.frame(width: ShannonTouchTarget.minimum, height: ShannonTouchTarget.minimum)
                }

                Spacer(minLength: 0)

                ShannonWaterlightEyeView(
                    expression: expression,
                    activity: eyeActivity,
                    size: 250
                )
                .frame(maxWidth: 440)

                Text(voiceModel.phase.japaneseLabel)
                    .font(.shannon(.title3).weight(.semibold))

                if !userTranscript.isEmpty {
                    transcriptCard("あなた", text: userTranscript, palette: palette)
                }
                if !shannonTranscript.isEmpty {
                    transcriptCard("シャノン", text: shannonTranscript, palette: palette)
                }
                if let errorMessage = voiceModel.errorMessage {
                    Text(errorMessage)
                        .font(.shannon(.callout))
                        .foregroundStyle(palette.danger)
                        .multilineTextAlignment(.center)
                }

                if let latestSpeech {
                    Text("\(latestSpeech.model) · \(latestSpeech.voice) · 約$\(latestSpeech.estimatedCostUsd.formatted(.number.precision(.fractionLength(5))))")
                        .font(.shannon(.caption).monospacedDigit())
                        .foregroundStyle(palette.textSecondary)
                } else {
                    Text("音声はサーバー側のGemini 3.8 Flash-Liteで生成します")
                        .font(.shannon(.caption))
                        .foregroundStyle(palette.textSecondary)
                }

                Spacer(minLength: 0)

                Button(action: primaryAction) {
                    Image(systemName: primarySymbol)
                        .font(.system(size: 26, weight: .semibold))
                        .foregroundStyle(palette.onAction)
                        .frame(width: 76, height: 76)
                        .background(palette.action, in: Circle())
                }
                .buttonStyle(.plain)
                .disabled(voiceModel.primaryAction == .none)
                .opacity(voiceModel.primaryAction == .none ? 0.55 : 1)
                .accessibilityLabel(primaryLabel)

                Text(primaryHint)
                    .font(.shannon(.footnote))
                    .foregroundStyle(palette.textSecondary)
            }
            .padding(.horizontal, ShannonSpacing.large)
            .padding(.vertical, ShannonSpacing.small)
        }
        .foregroundStyle(palette.textPrimary)
        .task {
            guard !didStart else { return }
            didStart = true
            await voiceModel.startListening()
        }
        .onDisappear {
            turnTask?.cancel()
            voiceModel.cancel()
        }
    }

    private var eyeActivity: ShannonDialogueActivity {
        switch voiceModel.phase {
        case .listening, .ready: .listening
        case .transcribing, .thinking: .thinking
        case .speaking: .speaking
        case .idle, .requestingPermission, .denied, .failed: .idle
        }
    }

    private var primarySymbol: String {
        switch voiceModel.primaryAction {
        case .start: "mic.fill"
        case .send: "arrow.up"
        case .stopSpeaking: "stop.fill"
        case .none: "ellipsis"
        }
    }

    private var primaryLabel: String {
        switch voiceModel.primaryAction {
        case .start: "話し始める"
        case .send: "話し終えて送る"
        case .stopSpeaking: "再生を止める"
        case .none: voiceModel.phase.japaneseLabel
        }
    }

    private var primaryHint: String {
        switch voiceModel.phase {
        case .listening, .ready: "話し終えたらタップ"
        case .speaking: "タップすると再生を停止"
        case .idle, .denied, .failed: "タップして次のターンを話す"
        case .requestingPermission, .transcribing, .thinking: "そのままお待ちください"
        }
    }

    @ViewBuilder
    private func transcriptCard(_ speaker: String, text: String, palette: ShannonPalette) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(speaker)
                .font(.shannon(.caption).weight(.semibold))
                .foregroundStyle(palette.textSecondary)
            Text(text)
                .font(.shannon(.body))
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(ShannonSpacing.medium)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: ShannonShape.large, style: .continuous))
        .frame(maxWidth: 560)
    }

    private func primaryAction() {
        switch voiceModel.primaryAction {
        case .start:
            Task { await voiceModel.startListening() }
        case .send:
            processTurn()
        case .stopSpeaking:
            voiceModel.stopSpeaking()
        case .none:
            break
        }
    }

    private func processTurn() {
        guard let recording = voiceModel.finishListening() else { return }
        userTranscript = ""
        shannonTranscript = ""
        latestSpeech = nil
        turnTask?.cancel()
        turnTask = Task {
            defer { turnTask = nil }
            let transcript: String
            do {
                transcript = try await transcribe(recording)
            } catch {
                guard !Task.isCancelled else { return }
                voiceModel.finishAfterFailedTranscription()
                return
            }
            guard !Task.isCancelled else { return }
            userTranscript = transcript
            voiceModel.acceptTranscript(transcript)

            let response: String
            do {
                response = try await reply(transcript)
            } catch {
                guard !Task.isCancelled else { return }
                voiceModel.finishAfterFailedReply()
                return
            }
            guard !Task.isCancelled else { return }
            shannonTranscript = response

            do {
                let speech = try await synthesize(response)
                guard !Task.isCancelled else { return }
                latestSpeech = speech
                try voiceModel.speakGemini(speech)
            } catch {
                guard !Task.isCancelled else { return }
                voiceModel.finishAfterFailedGeminiSpeech()
            }
        }
    }

    private func close() {
        turnTask?.cancel()
        voiceModel.cancel()
        dismiss()
    }
}
