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
            HStack(spacing: 9) {
                Image(systemName: symbol)
                    .frame(width: 18)
                Text(title)
                Spacer()
                if badge > 0 {
                    Text("\(badge)")
                        .font(.caption.monospacedDigit())
                        .foregroundStyle(.secondary)
                }
            }
            .padding(.horizontal, 10)
            .frame(height: 36)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .fontWeight(selected ? .semibold : .regular)
        .foregroundStyle(selected ? .primary : .secondary)
    }
}

struct DesktopWorkStrip: View {
    let task: ShannonAgentTask
    let open: () -> Void

    var body: some View {
        Button(action: open) {
            HStack(spacing: 10) {
                Label(task.status.japaneseName, systemImage: task.status.symbolName)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                Divider().frame(height: 18)
                Text(task.currentAction ?? task.summary)
                    .font(.callout)
                    .lineLimit(1)
                Spacer(minLength: 12)
                Text("次: \(ShannonDesktopWorkProjection.nextAction(for: task))")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                Image(systemName: "chevron.right")
                    .foregroundStyle(.tertiary)
            }
            .padding(.horizontal, 14)
            .frame(minHeight: 38)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .background(Color(nsColor: .textBackgroundColor))
        .accessibilityElement(children: .combine)
        .accessibilityLabel(
            "現在地、\(task.status.japaneseName)、\(task.currentAction ?? task.summary)。次、\(ShannonDesktopWorkProjection.nextAction(for: task))"
        )
        .accessibilityHint("詳細を開く")
    }
}
