import SwiftUI

struct ShannonThreadListDestination: Identifiable {
    let title: String
    let symbol: String
    let badge: Int?
    /// A small mark instead of a count: something there deserves a look.
    var attention = false
    /// Why, in one line (運用 on the 設定 tile): read out with the mark.
    var attentionReason: String?
    let action: () -> Void

    var id: String { title }

    var accessibilityLabel: String {
        if attention, let attentionReason { return "\(title)、\(ShannonGeneratedStrings.entryOpsReason(reason: attentionReason))" }
        if attention { return "\(title)、確かめたいことがあります" }
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
                .font(.shannon(.title3).weight(.medium))
                .foregroundStyle(palette.action)
                .frame(height: 28)
            Text(destination.title)
                .font(.shannon(.subheadline).weight(.medium))
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
                    .font(.shannon(.caption2).weight(.bold))
                    .foregroundStyle(palette.onAction)
                    .padding(.horizontal, 6)
                    .frame(minWidth: 20, minHeight: 20)
                    .background(palette.action, in: Capsule())
                    .padding(ShannonSpacing.small)
            } else if destination.attention {
                Image(systemName: "exclamationmark.triangle.fill")
                    .font(.shannon(.caption).weight(.bold))
                    .foregroundStyle(palette.attention)
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
                    .font(.shannon(.subheadline))
                    .foregroundStyle(palette.textSecondary)
                    .lineLimit(2)
                    .frame(maxWidth: .infinity, alignment: .leading)
                if isInitiative {
                    Image(systemName: "sparkles")
                        .font(.shannon(.caption))
                        .foregroundStyle(palette.brandPresence)
                }
                if isCurrent {
                    Image(systemName: "checkmark")
                        .font(.shannon(.subheadline).weight(.semibold))
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
            .font(.shannon(.body).weight(isCurrent ? .semibold : .regular))
            .foregroundStyle(palette.textPrimary)
            .lineLimit(2)
    }

    var timeText: some View {
        Text(timeLabel)
            .font(.shannon(.subheadline))
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
    var attention = false
    let palette: ShannonPalette

    var body: some View {
        HStack(spacing: ShannonSpacing.medium) {
            Image(systemName: symbol)
                .font(.system(size: 17, weight: .medium))
                .foregroundStyle(palette.action)
                .frame(width: 28, height: 28)

            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.shannon(.body).weight(.medium))
                    .foregroundStyle(palette.textPrimary)
                if let detail {
                    Text(detail)
                        .font(.shannon(.caption))
                        .foregroundStyle(palette.textSecondary)
                        .lineLimit(1)
                }
            }

            Spacer(minLength: 0)

            if let badge, badge > 0 {
                Text(badge > 9 ? "9+" : "\(badge)")
                    .font(.shannon(.caption2).weight(.bold))
                    .foregroundStyle(palette.onAction)
                    .padding(.horizontal, 6)
                    .frame(minWidth: 20, minHeight: 20)
                    .background(palette.action, in: Capsule())
            } else if attention {
                Image(systemName: "exclamationmark.triangle.fill")
                    .font(.shannon(.footnote).weight(.bold))
                    .foregroundStyle(palette.attention)
            }

            Image(systemName: "chevron.right")
                .font(.shannon(.caption).weight(.semibold))
                .foregroundStyle(palette.textSecondary)
        }
        .padding(.horizontal, ShannonSpacing.medium)
        .frame(minHeight: 52)
        .contentShape(Rectangle())
    }
}
