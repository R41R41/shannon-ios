import AppKit
import ShannonAppCore
import SwiftUI
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
            HStack(spacing: 0) {
                WorkStripValue(label: "目的", value: task.title)
                Divider().frame(height: 30)
                WorkStripValue(label: "いま", value: task.currentAction ?? task.summary)
                Divider().frame(height: 30)
                WorkStripValue(label: "次", value: ShannonDesktopWorkProjection.nextAction(for: task))
                Image(systemName: "chevron.right")
                    .foregroundStyle(.tertiary)
                    .padding(.trailing, 14)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .background(Color(nsColor: .textBackgroundColor))
    }
}

struct WorkStripValue: View {
    let label: String
    let value: String

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label)
                .font(.caption2)
                .foregroundStyle(.tertiary)
            Text(value)
                .font(.caption)
                .lineLimit(1)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 14)
        .padding(.vertical, 8)
    }
}
