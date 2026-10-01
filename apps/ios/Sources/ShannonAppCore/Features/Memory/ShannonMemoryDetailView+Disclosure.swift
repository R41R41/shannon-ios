import SwiftUI

extension ShannonMemoryDetailView {
    /// Who was present when this was said, whether it is 機微 or ふつう, and the owner's way to change it.
    func disclosureCard(
        _ item: ShannonMemoryItemDTO, _ disclosure: ShannonMemoryDisclosureDTO, _ palette: ShannonPalette
    ) -> some View {
        let next: ShannonMemorySensitivityDTO = disclosure.sensitivity == .sensitive ? .ordinary : .sensitive
        return VStack(alignment: .leading, spacing: ShannonSpacing.small) {
            Text("ほかの人がいる場での扱い").font(.headline)
            LabeledContent("話した時", value: disclosure.audience)
            LabeledContent("扱い") {
                Label(disclosure.sensitivity.japaneseName, systemImage: disclosure.sensitivity.symbolName)
                    .foregroundStyle(disclosure.sensitivity == .sensitive ? palette.attention : palette.textPrimary)
            }
            Text(disclosure.decidedBy == "owner" ? disclosure.sensitivity.chosenExplanation : disclosure.sensitivity.explanation)
                .font(.caption).foregroundStyle(palette.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
            Text(ShannonMemoryDisclosureCopy.reason(disclosure))
                .font(.caption).foregroundStyle(palette.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
            if item.status == .active {
                Button {
                    perform(next == .sensitive ? .markSensitive : .markOrdinary)
                } label: {
                    Label("\(next.japaneseName)にする", systemImage: next.symbolName)
                        .frame(maxWidth: .infinity, minHeight: ShannonTouchTarget.minimum)
                }
                .buttonStyle(.bordered)
                .disabled(model.mutatingMemoryID != nil)
                .accessibilityHint(next.chosenExplanation)
            }
        }
        .padding(ShannonSpacing.large)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(palette.canvas, in: RoundedRectangle(cornerRadius: ShannonShape.large))
    }
}

enum ShannonMemoryDisclosureCopy {
    /// 「シャノンが内容から判断：お金（「借金」を含む）」
    static func reason(_ disclosure: ShannonMemoryDisclosureDTO) -> String {
        disclosure.reason.isEmpty ? disclosure.decidedByLabel : "\(disclosure.decidedByLabel)：\(disclosure.reason)"
    }
}
