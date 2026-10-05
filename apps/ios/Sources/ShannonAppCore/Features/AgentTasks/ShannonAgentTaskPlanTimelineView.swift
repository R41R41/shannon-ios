// Adapted from Swift Pieces "Status Timeline" (registry/swift/lists/StatusTimeline.swift, v2.0.0)
// by Saivion Hayes — https://github.com/Saivion/SwiftPieces
// MIT + Commons Clause License Condition v1.0. See THIRD_PARTY_NOTICES.md.
// Rewritten for Shannon: plan status only, semantic roles, no pulsing node, and
// running-step details sourced from durable task events.

import SwiftUI

/// Plan section for the iPhone task room: a header disclosure with compact
/// progress, then the timeline with already-completed steps folded into one row.
struct AgentTaskPlanSection: View {
    let task: ShannonAgentTask
    let palette: ShannonPalette

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var isExpanded = true

    var body: some View {
        VStack(alignment: .leading, spacing: ShannonSpacing.small) {
            Button {
                withAnimation(AgentTaskPlanMotion.expansion(reduceMotion: reduceMotion)) {
                    isExpanded.toggle()
                }
            } label: {
                HStack(alignment: .firstTextBaseline, spacing: ShannonSpacing.small) {
                    Label("計画", systemImage: "list.bullet.clipboard")
                        .font(.shannon(.headline))
                        .foregroundStyle(palette.textPrimary)
                    Spacer(minLength: ShannonSpacing.small)
                    Text(ShannonAgentTaskRoomPresentation.planProgress(for: task))
                        .font(.shannon(.subheadline).monospacedDigit())
                        .foregroundStyle(palette.textSecondary)
                    Image(systemName: "chevron.down")
                        .font(.shannon(.caption).weight(.bold))
                        .foregroundStyle(palette.textSecondary)
                        .rotationEffect(.degrees(isExpanded ? 0 : -90))
                }
                .frame(minHeight: ShannonTouchTarget.minimum)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("計画")
            .accessibilityValue(ShannonAgentPlanTimeline.summary(for: task))
            .accessibilityHint(isExpanded ? "計画を閉じます" : "計画を開きます")
            .accessibilityAddTraits([.isButton, .isHeader])

            if isExpanded {
                AgentTaskPlanTimelineView(task: task, palette: palette)
                    .transition(.opacity)
            }
        }
    }
}

enum AgentTaskPlanMotion {
    /// DESIGN.md: expansion uses a 0.35 s damped spring, or a 0.15 s ease-out under Reduce Motion.
    static func expansion(reduceMotion: Bool) -> Animation {
        reduceMotion ? .easeOut(duration: 0.15) : .spring(duration: 0.35, bounce: 0)
    }
}

/// Vertical plan timeline for the iPhone task room.
struct AgentTaskPlanTimelineView: View {
    let task: ShannonAgentTask
    let palette: ShannonPalette

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var collapsedRunningIDs: Set<String> = []
    @State private var showsCompletedSteps = false

    private let nodeSize: CGFloat = 28
    private let column: CGFloat = 36

    var body: some View {
        let entries = ShannonAgentPlanTimeline.entries(for: task)
        let rows = ShannonAgentPlanTimeline.rows(for: entries, showsCompleted: showsCompletedSteps)
        VStack(alignment: .leading, spacing: 0) {
            ForEach(rows) { row in
                switch row {
                case .completedGroup(let count, let isExpanded, let isLast):
                    completedGroupRow(count: count, isExpanded: isExpanded, isLast: isLast)
                case .entry(let entry):
                    self.row(entry)
                }
            }
        }
        .animation(reduceMotion ? .easeOut(duration: 0.15) : .easeInOut(duration: 0.45), value: entries.map(\.status))
        .accessibilityElement(children: .contain)
        .accessibilityLabel("計画")
        .accessibilityValue(ShannonAgentPlanTimeline.summary(for: task))
    }

    /// One row standing in for the leading run of completed steps.
    private func completedGroupRow(count: Int, isExpanded: Bool, isLast: Bool) -> some View {
        HStack(alignment: .top, spacing: ShannonSpacing.small) {
            VStack(spacing: 0) {
                ZStack {
                    Circle().fill(palette.success)
                    Image(systemName: "checkmark")
                        .font(.system(size: 12, weight: .heavy))
                        .foregroundStyle(palette.onAction)
                }
                .frame(width: nodeSize, height: nodeSize)
                .padding(.top, ShannonSpacing.medium)
                if !isLast {
                    connector(completed: true)
                        .frame(maxHeight: .infinity)
                }
            }
            .frame(width: column)
            .accessibilityHidden(true)

            Button {
                withAnimation(AgentTaskPlanMotion.expansion(reduceMotion: reduceMotion)) {
                    showsCompletedSteps.toggle()
                }
            } label: {
                HStack(alignment: .firstTextBaseline, spacing: ShannonSpacing.small) {
                    Text(ShannonAgentPlanTimeline.completedGroupTitle(count: count))
                        .font(.shannon(.body).weight(.medium))
                        .foregroundStyle(palette.textPrimary)
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    Image(systemName: "chevron.down")
                        .font(.shannon(.caption).weight(.bold))
                        .foregroundStyle(palette.textSecondary)
                        .rotationEffect(.degrees(isExpanded ? -180 : 0))
                        .accessibilityHidden(true)
                }
                .frame(minHeight: ShannonTouchTarget.minimum - ShannonSpacing.medium, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .padding(.horizontal, ShannonSpacing.extraSmall)
            .padding(.vertical, ShannonSpacing.extraSmall)
            .padding(.bottom, isLast ? 0 : ShannonSpacing.small)
            .accessibilityLabel("完了した工程")
            .accessibilityValue("\(count)工程完了")
            .accessibilityHint(isExpanded ? "完了した工程を畳みます" : "完了した工程を表示します")
        }
        .fixedSize(horizontal: false, vertical: true)
    }

    private func row(_ entry: ShannonAgentPlanTimeline.Entry) -> some View {
        let isRunning = entry.status == .running
        let isExpanded = isRunning && !entry.details.isEmpty && !collapsedRunningIDs.contains(entry.id)

        return HStack(alignment: .top, spacing: ShannonSpacing.small) {
            VStack(spacing: 0) {
                node(entry)
                    .padding(.top, ShannonSpacing.medium)
                if !entry.isLast {
                    connector(completed: entry.status == .completed)
                        .frame(maxHeight: .infinity)
                }
            }
            .frame(width: column)

            VStack(alignment: .leading, spacing: ShannonSpacing.small) {
                if isRunning, !entry.details.isEmpty {
                    Button {
                        withAnimation(reduceMotion ? nil : .spring(duration: 0.35, bounce: 0)) {
                            if isExpanded { collapsedRunningIDs.insert(entry.id) } else { collapsedRunningIDs.remove(entry.id) }
                        }
                    } label: {
                        titleRow(entry, isExpanded: isExpanded)
                            .frame(minHeight: ShannonTouchTarget.minimum - ShannonSpacing.medium, alignment: .leading)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                } else {
                    titleRow(entry, isExpanded: false)
                        .padding(.top, 6)
                }

                if isExpanded {
                    VStack(alignment: .leading, spacing: ShannonSpacing.small) {
                        ForEach(Array(entry.details.enumerated()), id: \.offset) { _, detail in
                            detailRow(detail)
                        }
                    }
                    .transition(.opacity)
                }
            }
            .padding(.horizontal, isRunning ? ShannonSpacing.medium : ShannonSpacing.extraSmall)
            .padding(.vertical, isRunning ? ShannonSpacing.small : ShannonSpacing.extraSmall)
            .background {
                if isRunning {
                    RoundedRectangle(cornerRadius: ShannonShape.large, style: .continuous)
                        .fill(palette.intelligenceSoft)
                        .transition(.opacity)
                }
            }
            .padding(.bottom, entry.isLast ? 0 : ShannonSpacing.small)
        }
        .fixedSize(horizontal: false, vertical: true)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(accessibilityLabel(entry, isExpanded: isExpanded))
        .accessibilityValue(entry.accessibilityValue)
        .accessibilityHint(isRunning && !entry.details.isEmpty ? (isExpanded ? "詳細を閉じます" : "詳細を開きます") : "")
    }

    private func titleRow(_ entry: ShannonAgentPlanTimeline.Entry, isExpanded: Bool) -> some View {
        let isRunning = entry.status == .running
        return HStack(alignment: .firstTextBaseline, spacing: ShannonSpacing.small) {
            Text(entry.title)
                .font(.shannon(.body).weight(isRunning ? .semibold : (entry.status == .completed ? .medium : .regular)))
                .foregroundStyle(entry.status == .pending ? palette.textSecondary : palette.textPrimary)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
            if isRunning, !entry.details.isEmpty {
                Image(systemName: "chevron.down")
                    .font(.shannon(.caption).weight(.bold))
                    .foregroundStyle(palette.textSecondary)
                    .rotationEffect(.degrees(isExpanded ? -180 : 0))
                    .accessibilityHidden(true)
            }
        }
    }

    private func node(_ entry: ShannonAgentPlanTimeline.Entry) -> some View {
        ZStack {
            switch entry.status {
            case .completed:
                Circle().fill(palette.success)
                Image(systemName: "checkmark")
                    .font(.system(size: 12, weight: .heavy))
                    .foregroundStyle(palette.onAction)
                    .transition(.scale(scale: 0.5).combined(with: .opacity))
            case .running:
                Circle().fill(palette.brandPresence)
                Text("\(entry.number)")
                    .font(.system(size: 13, weight: .bold, design: .rounded))
                    .foregroundStyle(palette.onAction)
            case .pending:
                Circle().strokeBorder(palette.borderStrong.opacity(0.7), lineWidth: 1.5)
                Text("\(entry.number)")
                    .font(.system(size: 13, weight: .semibold, design: .rounded))
                    .foregroundStyle(palette.textSecondary)
            }
        }
        .frame(width: nodeSize, height: nodeSize)
        .accessibilityHidden(true)
    }

    /// Track below a node; it draws in once that step is complete.
    private func connector(completed: Bool) -> some View {
        GeometryReader { proxy in
            let line = Path { path in
                path.move(to: CGPoint(x: proxy.size.width / 2, y: 3))
                path.addLine(to: CGPoint(x: proxy.size.width / 2, y: proxy.size.height + 9))
            }
            line.stroke(palette.divider, style: StrokeStyle(lineWidth: 2, lineCap: .round))
            line.trim(from: 0, to: completed ? 1 : 0)
                .stroke(palette.success, style: StrokeStyle(lineWidth: 2, lineCap: .round))
        }
        .frame(width: nodeSize)
        .accessibilityHidden(true)
    }

    private func detailRow(_ detail: ShannonAgentPlanTimeline.Detail) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: ShannonSpacing.small) {
            Image(systemName: symbol(for: detail))
                .font(.shannon(.caption).weight(.semibold))
                .foregroundStyle(toneColor(detail.tone))
                .frame(width: 18)
            VStack(alignment: .leading, spacing: 2) {
                Text(detail.title)
                    .font(.shannon(.callout).weight(.medium))
                    .foregroundStyle(palette.textPrimary)
                if let text = detail.text, !text.isEmpty {
                    Text(text)
                        .font(.shannon(.caption))
                        .foregroundStyle(palette.textSecondary)
                        .lineLimit(3)
                }
            }
        }
    }

    private func symbol(for detail: ShannonAgentPlanTimeline.Detail) -> String {
        switch (detail.kind, detail.tone) {
        case (.command, .error), (.verification, .error): "exclamationmark.triangle.fill"
        case (.command, .success), (.verification, .success): "checkmark.circle.fill"
        case (.command, _): "terminal"
        case (.verification, _): "checklist"
        case (.event, _): "clock"
        }
    }

    private func toneColor(_ tone: ShannonAgentEventTone) -> Color {
        switch tone {
        case .neutral: palette.textSecondary
        case .progress: palette.action
        case .success: palette.success
        case .warning: palette.attention
        case .error: palette.danger
        }
    }

    private func accessibilityLabel(_ entry: ShannonAgentPlanTimeline.Entry, isExpanded: Bool) -> String {
        var label = "工程\(entry.number): \(entry.title)"
        if isExpanded {
            let details = entry.details.map { [$0.title, $0.text].compactMap { $0 }.joined(separator: "、") }
            label += "。" + details.joined(separator: "。")
        }
        return label
    }
}
