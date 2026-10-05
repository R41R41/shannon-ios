import SwiftUI

/// Shown once a call that had a 「友人も一緒」 period has ended. It takes the place of the call
/// pill (the Mac: of the call bar in Talk), so it never blocks the screen. The call is already remembered; the card says what was
/// kept and lets the owner take it back with 「今回は残さない」.
struct ShannonVoiceCallMemoryCard: View {
    let state: ShannonVoiceCallMemoryState
    let retry: () -> Void
    let discard: () -> Void
    let close: () -> Void

    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    @Environment(\.colorSchemeContrast) private var contrast

    var body: some View {
        let palette = ShannonPalette.resolve(colorScheme)
        let shape = RoundedRectangle(cornerRadius: ShannonShape.large, style: .continuous)
        VStack(alignment: .leading, spacing: ShannonSpacing.small) {
            Label(state.title, systemImage: state.symbol)
                .font(.shannon(.subheadline).weight(.semibold))
                .labelStyle(.titleAndIcon)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityAddTraits(.isHeader)
            Text(state.detail)
                .font(.shannon(.caption))
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
        .onChange(of: state.phase, initial: true) {
            AccessibilityNotification.Announcement("\(state.title)。\(state.detail)").post()
        }
    }

    @ViewBuilder
    private var actions: some View {
        switch state.phase {
        case .remembering, .discarding:
            ProgressView()
                .frame(maxWidth: .infinity, minHeight: ShannonTouchTarget.minimum)
                .accessibilityLabel(state.title)
        case .remembered:
            ShannonButtonRow {
                Button(role: .destructive, action: discard) { ShannonButtonLabel(ShannonVoiceCallMemoryState.discardLabel) }
                    .buttonStyle(.bordered)
                    .accessibilityHint("この通話で聞いたお名前と会話の記録を消します。")
                Button(action: close) { ShannonButtonLabel("閉じる") }
                    .buttonStyle(.borderedProminent)
            }
            .frame(minHeight: ShannonTouchTarget.minimum)
        case .rememberFailed:
            ShannonButtonRow {
                Button(role: .destructive, action: discard) { ShannonButtonLabel(ShannonVoiceCallMemoryState.discardLabel) }
                    .buttonStyle(.bordered)
                Button(action: retry) { ShannonButtonLabel("もう一度試す") }
                    .buttonStyle(.borderedProminent)
            }
            .frame(minHeight: ShannonTouchTarget.minimum)
        case .discardFailed:
            ShannonButtonRow {
                Button(action: close) { ShannonButtonLabel("閉じる") }
                    .buttonStyle(.bordered)
                Button(action: discard) { ShannonButtonLabel("もう一度試す") }
                    .buttonStyle(.borderedProminent)
            }
            .frame(minHeight: ShannonTouchTarget.minimum)
        case .discarded:
            Button(action: close) { ShannonButtonLabel("閉じる") }
                .buttonStyle(.bordered)
                .frame(minHeight: ShannonTouchTarget.minimum)
        }
    }
}
