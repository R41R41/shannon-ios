import SwiftUI
#if canImport(UIKit)
import UIKit
#elseif canImport(AppKit)
import AppKit
#endif

struct ShannonSnackbar: View {
    let message: String
    let showsRetry: Bool
    let retry: () -> Void
    let dismiss: () -> Void

    @Environment(\.colorScheme) var colorScheme

    var body: some View {
        let palette = M3Palette.resolve(colorScheme)

        HStack(spacing: M3Spacing.small) {
            Image(systemName: "wifi.exclamationmark")
            Text(message)
                .font(.callout)
                .lineLimit(2)
            Spacer(minLength: M3Spacing.small)
            if showsRetry {
                Button("再送", action: retry)
                    .font(.labelStyle)
                    .foregroundStyle(palette.primaryContainer)
                    .frame(minHeight: M3TouchTarget.minimum)
            }
            Button(action: dismiss) {
                Image(systemName: "xmark")
                    .frame(width: M3TouchTarget.minimum, height: M3TouchTarget.minimum)
            }
            .accessibilityLabel("閉じる")
        }
        .foregroundStyle(palette.surface)
        .padding(.leading, M3Spacing.large)
        .padding(.trailing, M3Spacing.extraSmall)
        .background(palette.onSurface, in: RoundedRectangle(cornerRadius: M3Shape.small, style: .continuous))
        .shadow(color: .black.opacity(0.16), radius: 8, y: 3)
    }
}

struct ShannonVoiceStatusBar: View {
    let model: ShannonVoiceConversationModel
    let primaryAction: () -> Void
    let cancel: () -> Void

    @Environment(\.colorScheme) var colorScheme

    var body: some View {
        let palette = M3Palette.resolve(colorScheme)
        HStack(spacing: M3Spacing.small) {
            Image(systemName: model.phase.symbolName)
                .symbolEffect(.variableColor.iterative, isActive: model.phase == .listening || model.phase == .speaking)
                .foregroundStyle(palette.primary)
                .frame(width: 30)

            VStack(alignment: .leading, spacing: 2) {
                Text(model.phase.japaneseLabel)
                    .font(.callout.weight(.semibold))
                    .foregroundStyle(palette.onSurface)
                if model.phase == .listening {
                    Text(String(format: "%.1f 秒 · 最大60秒", model.recordingDuration))
                        .font(.caption.monospacedDigit())
                        .foregroundStyle(palette.onSurfaceVariant)
                } else if !model.transcript.isEmpty {
                    Text(model.transcript)
                        .font(.caption)
                        .foregroundStyle(palette.onSurfaceVariant)
                        .lineLimit(2)
                } else if let errorMessage = model.errorMessage {
                    Text(errorMessage)
                        .font(.caption)
                        .foregroundStyle(palette.error)
                        .lineLimit(2)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)

            if model.primaryAction != .none {
                Button(action: primaryAction) {
                    Image(systemName: model.primaryAction == .send ? "arrow.up" : model.phase.symbolName)
                        .font(.system(size: 15, weight: .bold))
                        .foregroundStyle(palette.onPrimary)
                        .frame(width: 36, height: 36)
                        .background(palette.primary, in: Circle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(model.phase.japaneseLabel)
            }

            Button(action: cancel) {
                Image(systemName: "xmark")
                    .frame(width: 36, height: 36)
            }
            .buttonStyle(.plain)
            .foregroundStyle(palette.onSurfaceVariant)
            .accessibilityLabel("音声会話を閉じる")
        }
        .padding(.horizontal, M3Spacing.medium)
        .padding(.vertical, M3Spacing.small)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: M3Shape.large, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: M3Shape.large, style: .continuous)
                .stroke(palette.outlineVariant.opacity(0.65), lineWidth: 0.7)
        }
        .accessibilityElement(children: .contain)
    }
}

struct ShannonStateSheet: View {
    let state: CompanionStateDTO?
    let expression: ShannonExpressionDTO

    @Environment(\.dismiss) var dismiss
    @Environment(\.colorScheme) var colorScheme

    var body: some View {
        let palette = M3Palette.resolve(colorScheme)

        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: M3Spacing.extraLarge) {
                    HStack(spacing: M3Spacing.large) {
                        ShannonAvatarView(expression: expression, size: 72)
                        VStack(alignment: .leading, spacing: 4) {
                            Text(expression.japaneseName)
                                .font(.title2.weight(.semibold))
                            Text("シャノンのいま")
                                .font(.body)
                                .foregroundStyle(palette.onSurfaceVariant)
                        }
                    }

                    if let state {
                        VStack(spacing: M3Spacing.medium) {
                            StateMeter(label: "好奇心", value: state.temperament.curiosity, palette: palette)
                            StateMeter(label: "親密さ", value: state.temperament.closeness, palette: palette)
                            StateMeter(label: "活性", value: state.emotion.arousal, palette: palette)
                            StateMeter(label: "心の開き", value: state.emotion.openness, palette: palette)
                        }
                        .padding(M3Spacing.large)
                        .background(palette.surfaceContainer, in: RoundedRectangle(cornerRadius: M3Shape.extraLarge))

                        if !state.interests.isEmpty {
                            VStack(alignment: .leading, spacing: M3Spacing.medium) {
                                Text("いま興味があること")
                                    .font(.title3.weight(.semibold))
                                FlowLikeChips(values: state.interests, palette: palette)
                            }
                        }
                    } else {
                        Text("最初の会話のあとに、シャノンの状態がここに現れます。")
                            .font(.body)
                            .foregroundStyle(palette.onSurfaceVariant)
                            .padding(M3Spacing.large)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .background(palette.surfaceContainer, in: RoundedRectangle(cornerRadius: M3Shape.extraLarge))
                    }
                }
                .padding(M3Spacing.extraLarge)
            }
            .background(palette.surface)
            .navigationTitle("シャノンの状態")
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("閉じる") { dismiss() }
                }
            }
        }
        .presentationDetents([.medium, .large])
    }
}

struct StateMeter: View {
    let label: String
    let value: Double
    let palette: M3Palette

    var body: some View {
        VStack(spacing: 6) {
            HStack {
                Text(label).font(.callout.weight(.medium))
                Spacer()
                Text(value.formatted(.percent.precision(.fractionLength(0))))
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(palette.onSurfaceVariant)
            }
            ProgressView(value: value)
                .tint(palette.primary)
        }
    }
}

struct FlowLikeChips: View {
    let values: [String]
    let palette: M3Palette

    var body: some View {
        ScrollView(.horizontal) {
            HStack(spacing: M3Spacing.small) {
                ForEach(values, id: \.self) { value in
                    Text(value)
                        .font(.labelStyle)
                        .foregroundStyle(palette.onSecondaryContainer)
                        .padding(.horizontal, M3Spacing.medium)
                        .frame(minHeight: 40)
                        .background(palette.secondaryContainer, in: Capsule())
                }
            }
        }
        .scrollIndicators(.hidden)
    }
}

extension Font {
    static var labelStyle: Font { .callout.weight(.semibold) }
}
