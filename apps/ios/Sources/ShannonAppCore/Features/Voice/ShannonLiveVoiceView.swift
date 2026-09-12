import SwiftUI

public struct ShannonLiveVoiceView: View {
    @Bindable private var model: ShannonRealtimeVoiceSessionModel
    private let expression: ShannonExpressionDTO
    private let createCall: @MainActor (String) async throws -> ShannonRealtimeVoiceCallDTO
    private let commitTurn: @MainActor (String, String) async throws -> Void
    private let dismiss: () -> Void

    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var didStart = false
    @State private var pulse = false

    public init(
        model: ShannonRealtimeVoiceSessionModel,
        expression: ShannonExpressionDTO,
        createCall: @escaping @MainActor (String) async throws -> ShannonRealtimeVoiceCallDTO,
        commitTurn: @escaping @MainActor (String, String) async throws -> Void,
        dismiss: @escaping () -> Void
    ) {
        self.model = model
        self.expression = expression
        self.createCall = createCall
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

            Circle()
                .fill(palette.intelligenceGradient)
                .opacity(phaseGlowOpacity)
                .frame(width: 330, height: 330)
                .scaleEffect(pulse && !reduceMotion ? 1.08 : 0.94)
                .blur(radius: 36)
                .animation(
                    reduceMotion ? nil : .easeInOut(duration: model.phase == .speaking ? 0.8 : 1.7).repeatForever(autoreverses: true),
                    value: pulse
                )

            VStack(spacing: 0) {
                topBar(palette)
                Spacer(minLength: 12)

                ZStack(alignment: .bottom) {
                    ShannonDialogueStagePortraitView()
                        .frame(maxWidth: 440)
                        .scaleEffect(pulse && model.phase == .speaking && !reduceMotion ? 1.015 : 1)

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
                .frame(maxHeight: .infinity)

                VStack(spacing: ShannonSpacing.medium) {
                    if !model.userTranscript.isEmpty {
                        transcriptCard(
                            speaker: "あなた",
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

                    controls(palette)
                }
                .padding(.horizontal, ShannonSpacing.large)
                .padding(.bottom, ShannonSpacing.large)
            }
        }
        .foregroundStyle(palette.textPrimary)
        .task {
            guard !didStart else { return }
            didStart = true
            pulse = true
            await model.start(createCall: createCall, commitTurn: commitTurn)
        }
        .onDisappear { model.stop() }
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
                Text(model.phase.japaneseLabel)
                    .font(.caption)
                    .foregroundStyle(palette.textSecondary)
            }
            Spacer()
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
                        await model.start(createCall: createCall, commitTurn: commitTurn)
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

            ZStack {
                Circle().fill(.thinMaterial)
                Image(systemName: phaseSymbol)
                    .font(.title3)
                    .foregroundStyle(palette.action)
            }
            .frame(width: 52, height: 52)
            .accessibilityHidden(true)
        }
    }

    private var phaseSymbol: String {
        switch model.phase {
        case .idle: "waveform"
        case .requestingPermission, .connecting: "ellipsis"
        case .listening: "ear.fill"
        case .thinking: "sparkles"
        case .speaking: "waveform.circle.fill"
        case .failed: "exclamationmark.triangle.fill"
        }
    }

    private var phaseGlowOpacity: Double {
        switch model.phase {
        case .speaking: 0.22
        case .listening: 0.14
        case .thinking, .connecting, .requestingPermission: 0.10
        case .idle, .failed: 0.06
        }
    }
}
