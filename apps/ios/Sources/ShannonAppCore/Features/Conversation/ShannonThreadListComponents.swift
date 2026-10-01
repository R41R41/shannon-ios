import SwiftUI

struct ShannonThreadListDestination: Identifiable {
    let title: String
    let symbol: String
    let badge: Int?
    let action: () -> Void

    var id: String { title }

    var accessibilityLabel: String {
        guard let badge, badge > 0 else { return title }
        return "\(title)、\(badge)件"
    }
}

struct ShannonThreadListDestinationTile: View {
    let destination: ShannonThreadListDestination
    let palette: ShannonPalette

    var body: some View {
        VStack(spacing: ShannonSpacing.small) {
            Image(systemName: destination.symbol)
                .font(.title3.weight(.medium))
                .foregroundStyle(palette.action)
                .frame(height: 28)
            Text(destination.title)
                .font(.subheadline.weight(.medium))
                .foregroundStyle(palette.textPrimary)
                .lineLimit(1)
                .minimumScaleFactor(0.8)
        }
        .padding(.vertical, ShannonSpacing.medium)
        .padding(.horizontal, ShannonSpacing.small)
        .frame(maxWidth: .infinity, minHeight: 76)
        .background(
            palette.elevatedSurface,
            in: RoundedRectangle(cornerRadius: ShannonShape.large, style: .continuous)
        )
        .overlay(alignment: .topTrailing) {
            if let badge = destination.badge, badge > 0 {
                Text(badge > 9 ? "9+" : "\(badge)")
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(palette.onAction)
                    .padding(.horizontal, 6)
                    .frame(minWidth: 20, minHeight: 20)
                    .background(palette.action, in: Capsule())
                    .padding(ShannonSpacing.small)
            }
        }
        .contentShape(RoundedRectangle(cornerRadius: ShannonShape.large, style: .continuous))
    }
}

struct ShannonThreadListRow: View {
    let title: String
    let timeLabel: String
    let detail: String
    let isCurrent: Bool
    let isInitiative: Bool
    let palette: ShannonPalette

    @Environment(\.dynamicTypeSize) var dynamicTypeSize

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            if dynamicTypeSize.isAccessibilitySize {
                titleText
                timeText
            } else {
                HStack(alignment: .firstTextBaseline, spacing: ShannonSpacing.small) {
                    titleText
                    Spacer(minLength: ShannonSpacing.small)
                    timeText
                }
            }
            HStack(alignment: .top, spacing: ShannonSpacing.small) {
                Text(detail)
                    .font(.subheadline)
                    .foregroundStyle(palette.textSecondary)
                    .lineLimit(2)
                    .frame(maxWidth: .infinity, alignment: .leading)
                if isInitiative {
                    Image(systemName: "sparkles")
                        .font(.caption)
                        .foregroundStyle(palette.brandPresence)
                }
                if isCurrent {
                    Image(systemName: "checkmark")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(palette.action)
                }
            }
        }
        .padding(.vertical, ShannonSpacing.extraSmall)
        .frame(maxWidth: .infinity, minHeight: 52, alignment: .leading)
        .contentShape(Rectangle())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibilityText)
    }

    var titleText: some View {
        Text(title)
            .font(.body.weight(isCurrent ? .semibold : .regular))
            .foregroundStyle(palette.textPrimary)
            .lineLimit(2)
    }

    var timeText: some View {
        Text(timeLabel)
            .font(.subheadline)
            .foregroundStyle(palette.textSecondary)
            .lineLimit(1)
    }

    var accessibilityText: String {
        var parts = [title]
        if isCurrent { parts.append("選択中") }
        if isInitiative { parts.append("シャノンからの新しい話") }
        parts.append(timeLabel)
        parts.append(detail)
        return parts.joined(separator: "、")
    }
}

struct ShannonDrawerDestinationRow: View {
    let title: String
    let detail: String?
    let symbol: String
    let badge: Int?
    let palette: ShannonPalette

    var body: some View {
        HStack(spacing: ShannonSpacing.medium) {
            Image(systemName: symbol)
                .font(.system(size: 17, weight: .medium))
                .foregroundStyle(palette.action)
                .frame(width: 28, height: 28)

            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.body.weight(.medium))
                    .foregroundStyle(palette.textPrimary)
                if let detail {
                    Text(detail)
                        .font(.caption)
                        .foregroundStyle(palette.textSecondary)
                        .lineLimit(1)
                }
            }

            Spacer(minLength: 0)

            if let badge, badge > 0 {
                Text(badge > 9 ? "9+" : "\(badge)")
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(palette.onAction)
                    .padding(.horizontal, 6)
                    .frame(minWidth: 20, minHeight: 20)
                    .background(palette.action, in: Capsule())
            }

            Image(systemName: "chevron.right")
                .font(.caption.weight(.semibold))
                .foregroundStyle(palette.textSecondary)
        }
        .padding(.horizontal, ShannonSpacing.medium)
        .frame(minHeight: 52)
        .contentShape(Rectangle())
    }
}
