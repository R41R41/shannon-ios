import SwiftUI

/// Compact status row shown at the top of the room when no decision is pending:
/// small Shannon avatar, what Shannon is doing, and the stage name.
struct AgentTaskStatusRow: View {
    let task: ShannonAgentTask
    let palette: ShannonPalette

    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        let layout = dynamicTypeSize.isAccessibilitySize
            ? AnyLayout(VStackLayout(alignment: .leading, spacing: ShannonSpacing.small))
            : AnyLayout(HStackLayout(alignment: .center, spacing: ShannonSpacing.medium))

        layout {
            HStack(alignment: .center, spacing: ShannonSpacing.medium) {
                ShannonAvatarView(expression: task.expression, size: 32)
                VStack(alignment: .leading, spacing: 2) {
                    Text(task.stageDescription)
                        .font(.shannon(.subheadline).weight(.semibold))
                        .foregroundStyle(palette.textPrimary)
                        .fixedSize(horizontal: false, vertical: true)
                    if !task.summary.isEmpty {
                        // Stopped and finished work shows its whole summary: it is the report, not a ticker.
                        Text(task.summary)
                            .font(.shannon(.caption))
                            .foregroundStyle(palette.textSecondary)
                            .lineLimit(ShannonAgentTaskReport.leadsRoom(for: task) ? nil : 2)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            AgentTaskStatusBadge(task: task, palette: palette)
        }
        .frame(maxWidth: .infinity, minHeight: ShannonTouchTarget.minimum, alignment: .leading)
        .accessibilityElement(children: .combine)
    }
}

/// Puts the state and plan progress under the task title.
///
/// iOS 26 and later use the native navigation subtitle; earlier systems get a
/// two-line principal toolbar item with the same text.
struct AgentTaskRoomSubtitle: ViewModifier {
    let title: String
    let subtitle: String
    let palette: ShannonPalette

    func body(content: Content) -> some View {
#if os(iOS)
        if #available(iOS 26.0, *) {
            content.navigationSubtitle(subtitle)
        } else {
            content.toolbar {
                ToolbarItem(placement: .principal) {
                    VStack(spacing: 0) {
                        Text(title)
                            .font(.shannon(.headline))
                            .foregroundStyle(palette.textPrimary)
                        Text(subtitle)
                            .font(.shannon(.caption))
                            .foregroundStyle(palette.textSecondary)
                    }
                    .lineLimit(1)
                    .accessibilityElement(children: .combine)
                    .accessibilityAddTraits(.isHeader)
                }
            }
        }
#else
        content.navigationSubtitle(subtitle)
#endif
    }
}
