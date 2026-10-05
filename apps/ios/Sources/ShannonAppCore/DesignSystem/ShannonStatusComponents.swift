import SwiftUI
#if canImport(UIKit)
import UIKit
#elseif canImport(AppKit)
import AppKit
#endif

struct ShannonSnackbar: View {
    let message: String
    /// A failure by default; a plain notice passes an informational symbol.
    var symbolName = "exclamationmark.circle"
    let showsRetry: Bool
    let retry: () -> Void
    let dismiss: () -> Void

    @Environment(\.colorScheme) var colorScheme

    var body: some View {
        let palette = ShannonPalette.resolve(colorScheme)

        HStack(spacing: ShannonSpacing.small) {
            Image(systemName: symbolName)
                .accessibilityHidden(true)
            Text(message)
                .font(.shannon(.callout))
                .lineLimit(3)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: ShannonSpacing.small)
            if showsRetry {
                Button("再送", action: retry)
                    .font(.labelStyle)
                    .foregroundStyle(palette.userMessage)
                    .frame(minHeight: ShannonTouchTarget.minimum)
            }
            Button(action: dismiss) {
                Image(systemName: "xmark")
                    .frame(width: ShannonTouchTarget.minimum, height: ShannonTouchTarget.minimum)
            }
            .accessibilityLabel("閉じる")
        }
        .foregroundStyle(palette.canvas)
        .padding(.leading, ShannonSpacing.large)
        .padding(.trailing, ShannonSpacing.extraSmall)
        .background(palette.textPrimary, in: RoundedRectangle(cornerRadius: ShannonShape.small, style: .continuous))
        .shadow(color: .black.opacity(0.16), radius: 8, y: 3)
    }
}

struct ShannonVoiceStatusBar: View {
    let model: ShannonVoiceConversationModel
    let primaryAction: () -> Void
    let cancel: () -> Void

    @Environment(\.colorScheme) var colorScheme

    var body: some View {
        let palette = ShannonPalette.resolve(colorScheme)
        HStack(spacing: ShannonSpacing.small) {
            Image(systemName: model.phase.symbolName)
                .symbolEffect(.variableColor.iterative, isActive: model.phase == .listening || model.phase == .speaking)
                .foregroundStyle(palette.action)
                .frame(width: 30)

            VStack(alignment: .leading, spacing: 2) {
                Text(model.phase.japaneseLabel)
                    .font(.shannon(.callout).weight(.semibold))
                    .foregroundStyle(palette.textPrimary)
                if model.phase == .listening {
                    Text(String(format: "%.1f 秒 · 最大60秒", model.recordingDuration))
                        .font(.shannon(.caption).monospacedDigit())
                        .foregroundStyle(palette.textSecondary)
                } else if !model.transcript.isEmpty {
                    Text(model.transcript)
                        .font(.shannon(.caption))
                        .foregroundStyle(palette.textSecondary)
                        .lineLimit(2)
                } else if let errorMessage = model.errorMessage {
                    Text(errorMessage)
                        .font(.shannon(.caption))
                        .foregroundStyle(palette.danger)
                        .lineLimit(2)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)

            if model.primaryAction != .none {
                Button(action: primaryAction) {
                    Image(systemName: model.primaryAction == .send ? "arrow.up" : model.phase.symbolName)
                        .font(.system(size: 15, weight: .bold))
                        .foregroundStyle(palette.onAction)
                        .frame(width: 36, height: 36)
                        .background(palette.action, in: Circle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(model.phase.japaneseLabel)
            }

            Button(action: cancel) {
                Image(systemName: "xmark")
                    .frame(width: 36, height: 36)
            }
            .buttonStyle(.plain)
            .foregroundStyle(palette.textSecondary)
            .accessibilityLabel("音声会話を閉じる")
        }
        .padding(.horizontal, ShannonSpacing.medium)
        .padding(.vertical, ShannonSpacing.small)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: ShannonShape.large, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: ShannonShape.large, style: .continuous)
                .stroke(palette.divider.opacity(0.65), lineWidth: 0.7)
        }
        .accessibilityElement(children: .contain)
    }
}

struct ShannonStateSheet: View {
    let state: CompanionStateDTO?
    let face: ShannonFace

    @Environment(\.dismiss) var dismiss
    @Environment(\.colorScheme) var colorScheme

    var body: some View {
        let palette = ShannonPalette.resolve(colorScheme)

        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: ShannonSpacing.extraLarge) {
                    HStack(spacing: ShannonSpacing.large) {
                        ShannonAvatarView(expression: face.expression, size: 72)
                            .accessibilityHidden(true)
                        VStack(alignment: .leading, spacing: 4) {
                            Text(face.japaneseName)
                                .font(.shannon(.title2).weight(.semibold))
                            Text("シャノンのいま")
                                .font(.shannon(.body))
                                .foregroundStyle(palette.textSecondary)
                            if let cause = state?.presence?.mood.cause, !cause.isEmpty {
                                Text(cause)
                                    .font(.shannon(.callout))
                                    .foregroundStyle(palette.textSecondary)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                        }
                    }
                    .accessibilityElement(children: .combine)

                    if let state {
                        VStack(spacing: ShannonSpacing.medium) {
                            // Traits move with stored evidence; the line under each bar says which.
                            StateMeter(
                                label: "親密さ", value: state.temperament.closeness, palette: palette,
                                reason: state.presence?.temperamentReasons.closeness
                            )
                            StateMeter(
                                label: "好奇心", value: state.temperament.curiosity, palette: palette,
                                reason: state.presence?.temperamentReasons.curiosity
                            )
                            StateMeter(label: "活性", value: state.emotion.arousal, palette: palette)
                            StateMeter(label: "心の開き", value: state.emotion.openness, palette: palette)
                        }
                        .padding(ShannonSpacing.large)
                        .background(palette.subtleSurface, in: RoundedRectangle(cornerRadius: ShannonShape.extraLarge))

                        if !state.interests.isEmpty {
                            VStack(alignment: .leading, spacing: ShannonSpacing.medium) {
                                Text("いま興味があること")
                                    .font(.shannon(.title3).weight(.semibold))
                                FlowLikeChips(values: state.interests, palette: palette)
                            }
                        }
                    } else {
                        Text("最初の会話のあとに、シャノンの状態がここに現れます。")
                            .font(.shannon(.body))
                            .foregroundStyle(palette.textSecondary)
                            .padding(ShannonSpacing.large)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .background(palette.subtleSurface, in: RoundedRectangle(cornerRadius: ShannonShape.extraLarge))
                    }
                }
                .padding(ShannonSpacing.extraLarge)
            }
            .background(palette.canvas)
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
    let palette: ShannonPalette
    /// What the value is made of, when the server explains it.
    var reason: String? = nil

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(label).font(.shannon(.callout).weight(.medium))
                Spacer()
                Text(value.formatted(.percent.precision(.fractionLength(0))))
                    .font(.shannon(.caption).monospacedDigit())
                    .foregroundStyle(palette.textSecondary)
            }
            ProgressView(value: min(1, max(0, value)))
                .tint(palette.action)
            if let reason, !reason.isEmpty {
                Text(reason)
                    .font(.shannon(.caption))
                    .foregroundStyle(palette.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(label)
        .accessibilityValue([value.formatted(.percent.precision(.fractionLength(0))), reason]
            .compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: "、"))
    }
}

struct FlowLikeChips: View {
    let values: [String]
    let palette: ShannonPalette

    var body: some View {
        ScrollView(.horizontal) {
            HStack(spacing: ShannonSpacing.small) {
                ForEach(values, id: \.self) { value in
                    Text(value)
                        .font(.labelStyle)
                        .foregroundStyle(palette.textPrimary)
                        .padding(.horizontal, ShannonSpacing.medium)
                        .frame(minHeight: 40)
                        .background(palette.subtleSurface, in: Capsule())
                }
            }
        }
        .scrollIndicators(.hidden)
    }
}

extension Font {
    static var labelStyle: Font { .shannon(.callout).weight(.semibold) }
}
