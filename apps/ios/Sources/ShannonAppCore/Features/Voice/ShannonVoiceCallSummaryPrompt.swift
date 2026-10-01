#if os(iOS)
import SwiftUI

/// Asked once a call that had a 「友人も一緒」 period has ended. It takes the place of the call
/// pill, so it never blocks the screen; leaving it unanswered keeps nothing.
struct ShannonVoiceCallSummaryPrompt: View {
    let state: ShannonVoiceCallSummaryPromptState
    let keep: () -> Void
    let discard: () -> Void

    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    @Environment(\.colorSchemeContrast) private var contrast

    var body: some View {
        let palette = ShannonPalette.resolve(colorScheme)
        let shape = RoundedRectangle(cornerRadius: ShannonShape.large, style: .continuous)
        VStack(alignment: .leading, spacing: ShannonSpacing.small) {
            Label(title, systemImage: symbol)
                .font(.subheadline.weight(.semibold))
                .labelStyle(.titleAndIcon)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityAddTraits(.isHeader)
            Text(state.detail)
                .font(.caption)
                .foregroundStyle(palette.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
            actions
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(ShannonSpacing.medium)
        .foregroundStyle(palette.textPrimary)
        .background {
            if reduceTransparency || contrast == .increased { shape.fill(palette.elevatedSurface) }
            else { shape.fill(.regularMaterial) }
        }
        .overlay { shape.stroke(palette.divider.opacity(0.8), lineWidth: 0.7) }
        .padding(.horizontal, ShannonSpacing.large)
        .padding(.vertical, ShannonSpacing.extraSmall)
        .onAppear { AccessibilityNotification.Announcement(title).post() }
    }

    private var title: String {
        switch state {
        case .asking, .failed: ShannonVoiceCallSummaryPromptState.question
        case .saving: "要約を残しています"
        case .saved: "要約を残しました"
        }
    }

    private var symbol: String {
        switch state {
        case .asking, .saving: "text.bubble"
        case .failed: "exclamationmark.bubble"
        case .saved: "checkmark.circle"
        }
    }

    @ViewBuilder
    private var actions: some View {
        switch state {
        case .asking:
            ShannonButtonRow {
                Button(action: discard) { ShannonButtonLabel("残さない") }
                    .buttonStyle(.bordered)
                Button(action: keep) { ShannonButtonLabel("要約を残す") }
                    .buttonStyle(.borderedProminent)
                    .accessibilityHint("短い要約だけを、通話を始めたトークに残します。")
            }
            .frame(minHeight: ShannonTouchTarget.minimum)
        case .failed:
            ShannonButtonRow {
                Button(action: discard) { ShannonButtonLabel("残さない") }
                    .buttonStyle(.bordered)
                Button(action: keep) { ShannonButtonLabel("もう一度試す") }
                    .buttonStyle(.borderedProminent)
            }
            .frame(minHeight: ShannonTouchTarget.minimum)
        case .saving:
            ProgressView()
                .frame(maxWidth: .infinity, minHeight: ShannonTouchTarget.minimum)
                .accessibilityLabel("要約を作っています")
        case .saved:
            Button(action: discard) { ShannonButtonLabel("閉じる") }
                .buttonStyle(.bordered)
                .frame(minHeight: ShannonTouchTarget.minimum)
        }
    }
}
#endif
