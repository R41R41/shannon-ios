import AppKit
import ShannonAppCore
import SwiftUI

struct DesktopTaskSection: View {
    let title: String
    let subtitle: String
    let tasks: [ShannonAgentTask]
    let threads: [ChatThreadDTO]
    let selectedTaskID: UUID?
    let select: (ShannonAgentTask) -> Void
    /// Pin and archive from the row's menu (A14); the 開発 page has the same.
    var togglePinned: ((ShannonAgentTask) -> Void)?
    var setArchived: ((ShannonAgentTask, Bool) -> Void)?

    var body: some View {
        if !tasks.isEmpty {
            VStack(alignment: .leading, spacing: ShannonDesktopSpacing.medium) {
                HStack(alignment: .firstTextBaseline) {
                    Text(title).font(.shannonDesktop(.title2).weight(.semibold))
                    Text(subtitle).font(.shannonDesktop(.callout)).foregroundStyle(.secondary)
                }
                VStack(spacing: 0) {
                    ForEach(tasks) { task in
                        Button { select(task) } label: {
                            HStack(spacing: ShannonDesktopSpacing.large) {
                                Image(systemName: task.status.symbolName)
                                    .foregroundStyle(task.status == .waitingApproval ? Color.shannonAttention : .secondary)
                                    .frame(width: 20)
                                VStack(alignment: .leading, spacing: 3) {
                                    HStack {
                                        Text(task.title).font(.shannonDesktop(.headline))
                                        Text(task.stateName)
                                            .font(.shannonDesktop(.caption))
                                            .foregroundStyle(.secondary)
                                    }
                                    Text(task.currentAction ?? task.summary)
                                        .font(.shannonDesktop(.callout))
                                        .foregroundStyle(.secondary)
                                        .lineLimit(2)
                                    Label(
                                        ShannonDesktopConversationContext(task: task).title(in: threads),
                                        systemImage: "bubble.left"
                                    )
                                    .font(.shannonDesktop(.caption))
                                    .foregroundStyle(.tertiary)
                                    .lineLimit(1)
                                }
                                Spacer()
                                if let progress = task.progressFraction {
                                    ProgressView(value: progress)
                                        .frame(width: 90)
                                }
                                Image(systemName: "chevron.right")
                                    .foregroundStyle(.tertiary)
                            }
                            .padding(.horizontal, ShannonDesktopSpacing.large)
                            .padding(.vertical, ShannonDesktopSpacing.medium)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .background(selectedTaskID == task.id ? Color.shannonActionColor.opacity(0.08) : .clear)
                        .contextMenu {
                            if let togglePinned {
                                Button(task.isPinned ? "ピン留めを外す" : "ピン留め") { togglePinned(task) }
                            }
                            if let setArchived {
                                Button(task.isArchived ? "アーカイブから戻す" : "アーカイブ") { setArchived(task, !task.isArchived) }
                                    .disabled(!task.isArchived && task.status != .proposed && !task.status.isTerminal)
                            }
                        }
                        if task.id != tasks.last?.id { Divider().padding(.leading, 48) }
                    }
                }
                .background(Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: ShannonDesktopRadius.medium))
            }
        }
    }
}

struct DesktopInspectorSection<Content: View>: View {
    let title: String
    @ViewBuilder let content: Content

    init(title: String, @ViewBuilder content: () -> Content) {
        self.title = title
        self.content = content()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            Text(title)
                .font(.shannonDesktop(.caption).weight(.semibold))
                .foregroundStyle(.secondary)
                .textCase(.uppercase)
            content
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(ShannonDesktopSpacing.medium)
        .background(Color.primary.opacity(0.035), in: RoundedRectangle(cornerRadius: ShannonDesktopRadius.medium, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: ShannonDesktopRadius.medium, style: .continuous)
                .stroke(Color.primary.opacity(0.055), lineWidth: 0.75)
        }
    }
}

struct DesktopExpandableText: View {
    let value: String
    let collapsedLineLimit: Int
    @State private var isExpanded = false

    init(_ value: String, collapsedLineLimit: Int) {
        self.value = value
        self.collapsedLineLimit = collapsedLineLimit
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(value)
                .lineLimit(isExpanded ? nil : collapsedLineLimit)
                .textSelection(.enabled)
            if value.count > 180 {
                Button(isExpanded ? "折りたたむ" : "全文を表示") {
                    withAnimation(.easeOut(duration: 0.16)) {
                        isExpanded.toggle()
                    }
                }
                .buttonStyle(.link)
                .font(.shannonDesktop(.caption))
            }
        }
    }
}

struct DesktopTaskStageRail: View {
    let progress: [ShannonAgentTaskStageProgress]

    var body: some View {
        HStack(spacing: 5) {
            ForEach(progress) { item in
                VStack(spacing: ShannonDesktopSpacing.extraSmall) {
                    Image(systemName: symbolName(for: item))
                        .foregroundStyle(color(for: item))
                    Text(item.stage.japaneseName)
                        .font(.shannonDesktop(.caption2))
                        .foregroundStyle(item.state == .current ? .primary : .secondary)
                        .lineLimit(1)
                }
                .frame(maxWidth: .infinity)
                .accessibilityElement(children: .combine)
            }
        }
        .padding(.vertical, ShannonDesktopSpacing.small)
        .padding(.horizontal, 6)
        .background(Color.primary.opacity(0.025), in: RoundedRectangle(cornerRadius: ShannonDesktopRadius.medium, style: .continuous))
    }

    private func symbolName(for item: ShannonAgentTaskStageProgress) -> String {
        switch item.state {
        case .pending: "circle"
        case .current: "circle.inset.filled"
        case .completed: "checkmark.circle.fill"
        }
    }

    private func color(for item: ShannonAgentTaskStageProgress) -> Color {
        switch item.state {
        case .pending: .secondary
        case .current: Color.shannonActionColor
        case .completed: .shannonSuccess
        }
    }
}

extension ShannonAgentEventTone {
    var desktopSymbolName: String {
        switch self {
        case .neutral: "circle"
        case .progress: "arrow.right.circle.fill"
        case .success: "checkmark.circle.fill"
        case .warning: "exclamationmark.circle.fill"
        case .error: "xmark.octagon.fill"
        }
    }

    var desktopColor: Color {
        switch self {
        case .neutral: .secondary
        case .progress: Color.shannonActionColor
        case .success: Color.shannonSuccess
        case .warning: Color.shannonAttention
        case .error: Color.shannonDanger
        }
    }
}

extension ShannonAgentTestStatus {
    var desktopSymbolName: String {
        switch self {
        case .pending: "clock"
        case .passed: "checkmark.circle.fill"
        case .failed: "xmark.circle.fill"
        }
    }

    var desktopColor: Color {
        switch self {
        case .pending: .secondary
        case .passed: Color.shannonSuccess
        case .failed: Color.shannonDanger
        }
    }
}
