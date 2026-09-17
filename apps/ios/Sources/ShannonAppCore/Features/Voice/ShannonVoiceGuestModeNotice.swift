import SwiftUI

struct ShannonVoiceGuestModeNotice: View {
    let palette: ShannonPalette

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Label("ゲストモード", systemImage: "person.2.fill")
                .font(.callout.weight(.semibold))
                .foregroundStyle(palette.textPrimary)
                .labelStyle(.titleAndIcon)
            Text("話者を識別せず、この通話を履歴・個人記憶へ保存しません。")
                .font(.caption)
                .foregroundStyle(palette.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(ShannonSpacing.medium)
        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: ShannonShape.large, style: .continuous))
        .accessibilityElement(children: .combine)
    }
}
