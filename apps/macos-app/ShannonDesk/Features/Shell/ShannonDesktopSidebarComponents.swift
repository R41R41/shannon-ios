import AppKit
import ShannonAppCore
import SwiftUI

extension View {
    @ViewBuilder
    func desktopSearchFocused(_ binding: FocusState<Bool>.Binding) -> some View {
        if #available(macOS 15.0, *) {
            searchFocused(binding)
        } else {
            self
        }
    }
}
import UniformTypeIdentifiers

struct DesktopSidebarButton: View {
    let title: String
    let symbol: String
    let badge: Int
    let selected: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: ShannonDesktopSpacing.small) {
                Image(systemName: symbol)
                    .frame(width: 18)
                Text(title)
                Spacer()
                if badge > 0 {
                    Text("\(badge)")
                        .font(.shannonDesktop(.caption).monospacedDigit())
                        .foregroundStyle(.secondary)
                }
            }
            .padding(.horizontal, ShannonDesktopSpacing.medium)
            .frame(height: ShannonDesktopMetrics.rowHeight)
            .background(
                selected ? Color.primary.opacity(0.08) : Color.clear,
                in: RoundedRectangle(cornerRadius: ShannonDesktopRadius.small, style: .continuous)
            )
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .fontWeight(selected ? .semibold : .regular)
        .foregroundStyle(selected ? .primary : .secondary)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}

struct DesktopWorkStrip: View {
    let task: ShannonAgentTask
    let open: () -> Void

    var body: some View {
        Button(action: open) {
            HStack(spacing: ShannonDesktopSpacing.medium) {
                Label(task.stateName, systemImage: task.stateSymbolName)
                    .font(.shannonDesktop(.caption).weight(.semibold))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                Divider().frame(height: 18)
                Text(task.currentAction ?? task.summary)
                    .font(.shannonDesktop(.callout))
                    .lineLimit(1)
                Spacer(minLength: 12)
                Text("次: \(ShannonDesktopWorkProjection.nextAction(for: task))")
                    .font(.shannonDesktop(.caption))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                Image(systemName: "chevron.right")
                    .foregroundStyle(.tertiary)
            }
            .padding(.horizontal, ShannonDesktopSpacing.large)
            .frame(minHeight: ShannonDesktopMetrics.rowHeight)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .background(Color(nsColor: .textBackgroundColor))
        .accessibilityElement(children: .combine)
        .accessibilityLabel(
            "現在地、\(task.stateName)、\(task.currentAction ?? task.summary)。次、\(ShannonDesktopWorkProjection.nextAction(for: task))"
        )
        .accessibilityHint("詳細を開く")
    }
}
