import SwiftUI

/// The first card of 「シャノン」 (docs/product/information-architecture.md): her face, her mood,
/// what she does in her own time and what waits for the owner. Pressing it opens ようす.
/// The iPhone shows it at the top of its one column; the Mac at the top of the second column.
public struct ShannonHubCard: View {
    private let now: ShannonNowModel
    private let fallbackMood: CompanionPresenceDTO.Mood?
    private let approvals: [ShannonNowWaitingItem]
    private let isSelected: Bool
    private let open: () -> Void

    @Environment(\.colorScheme) private var colorScheme

    public init(
        now: ShannonNowModel,
        fallbackMood: CompanionPresenceDTO.Mood?,
        approvals: [ShannonNowWaitingItem],
        isSelected: Bool = false,
        open: @escaping () -> Void
    ) {
        self.now = now
        self.fallbackMood = fallbackMood
        self.approvals = approvals
        self.isSelected = isSelected
        self.open = open
    }

    private var waiting: [ShannonNowWaitingItem] { now.waiting(approvals: approvals) }

    private var moodFace: ShannonFace? {
        now.now?.feeling.present?.face ?? now.now?.feeling.mood?.face ?? fallbackMood?.face
    }

    private var waitingLine: String {
        let items = waiting
        guard !items.isEmpty else { return ShannonGeneratedStrings.shannonCardNothingWaiting }
        return ShannonGeneratedStrings.hubCardWaiting(count: String(items.count), summary: ShannonNowText.waitingSummary(items))
    }

    public var body: some View {
        let palette = ShannonPalette.resolve(colorScheme)
        Button(action: open) {
            HStack(alignment: .center, spacing: ShannonSpacing.medium) {
                ShannonAvatarView(face: moodFace ?? ShannonFace(expression: .neutral), size: 56)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: ShannonSpacing.extraSmall) {
                    Text(ShannonGeneratedStrings.navNow)
                        .font(.shannon(.caption).weight(.semibold))
                        .foregroundStyle(palette.textSecondary)
                    Text(moodFace?.japaneseName ?? "まだ分かりません")
                        .font(.shannon(.title3).weight(.semibold))
                        .foregroundStyle(palette.textPrimary)
                    if let line = now.ownTimeLine {
                        Text(line)
                            .font(.shannon(.footnote))
                            .foregroundStyle(palette.textSecondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    Text(waitingLine)
                        .font(.shannon(.callout).weight(waiting.isEmpty ? .regular : .semibold))
                        .foregroundStyle(waiting.isEmpty ? palette.textSecondary : palette.textPrimary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 0)
                Image(systemName: "chevron.right")
                    .font(.shannon(.caption).weight(.semibold))
                    .foregroundStyle(palette.textSecondary)
                    .accessibilityHidden(true)
            }
            .padding(.vertical, ShannonSpacing.small)
            .frame(maxWidth: .infinity, minHeight: ShannonTouchTarget.minimum, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibilityLabel)
        .accessibilityHint(ShannonGeneratedStrings.hubCardHint)
        .accessibilityAddTraits(isSelected ? [.isButton, .isSelected] : .isButton)
        .accessibilityIdentifier("shannon-hub-card")
    }

    private var accessibilityLabel: String {
        [ShannonGeneratedStrings.navNow, moodFace?.japaneseName ?? "まだ分かりません", now.ownTimeLine, waitingLine]
            .compactMap { $0 }
            .joined(separator: "、")
    }
}
