// Adapted from Swift Pieces "Status Timeline" (registry/swift/lists/StatusTimeline.swift, v2.0.0)
// by Saivion Hayes — https://github.com/Saivion/SwiftPieces
// MIT + Commons Clause License Condition v1.0. See THIRD_PARTY_NOTICES.md.
// Mac inspector expression of Shannon's plan timeline, driven by the shared
// ShannonAgentPlanTimeline projection (plan status only).

import ShannonAppCore
import SwiftUI

struct DesktopPlanTimelineView: View {
    let task: ShannonAgentTask

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var collapsedRunningIDs: Set<String> = []

    var body: some View {
        let entries = ShannonAgentPlanTimeline.entries(for: task)
        VStack(alignment: .leading, spacing: 0) {
            Text(ShannonAgentPlanTimeline.summary(for: task))
                .font(.caption)
                .foregroundStyle(.secondary)
                .padding(.bottom, 6)
            ForEach(entries) { entry in
                row(entry)
            }
        }
        .animation(reduceMotion ? .easeOut(duration: 0.15) : .easeInOut(duration: 0.4), value: entries.map(\.status))
        .accessibilityElement(children: .contain)
        .accessibilityLabel("計画")
        .accessibilityValue(ShannonAgentPlanTimeline.summary(for: task))
    }

    private func row(_ entry: ShannonAgentPlanTimeline.Entry) -> some View {
        let isRunning = entry.status == .running
        let canExpand = isRunning && !entry.details.isEmpty
        let isExpanded = canExpand && !collapsedRunningIDs.contains(entry.id)

        return HStack(alignment: .top, spacing: 8) {
            VStack(spacing: 0) {
                node(entry).padding(.top, 5)
                if !entry.isLast {
                    ZStack(alignment: .top) {
                        Capsule().fill(Color.primary.opacity(0.1)).frame(width: 2)
                        Capsule()
                            .fill(Color.shannonSuccess)
                            .frame(width: 2)
                            .scaleEffect(x: 1, y: entry.status == .completed ? 1 : 0, anchor: .top)
                    }
                    .padding(.vertical, 3)
                    .frame(maxHeight: .infinity)
                }
            }
            .frame(width: 22)

            VStack(alignment: .leading, spacing: 6) {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text(entry.title)
                        .fontWeight(isRunning ? .semibold : .regular)
                        .foregroundStyle(entry.status == .pending ? .secondary : .primary)
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    if canExpand {
                        Button {
                            withAnimation(reduceMotion ? nil : .spring(duration: 0.3, bounce: 0)) {
                                if isExpanded { collapsedRunningIDs.insert(entry.id) } else { collapsedRunningIDs.remove(entry.id) }
                            }
                        } label: {
                            Image(systemName: isExpanded ? "chevron.up" : "chevron.down")
                        }
                        .buttonStyle(.borderless)
                        .help(isExpanded ? "詳細を閉じる" : "詳細を開く")
                        .accessibilityLabel(isExpanded ? "詳細を閉じる" : "詳細を開く")
                    }
                }
                if isExpanded {
                    ForEach(Array(entry.details.enumerated()), id: \.offset) { _, detail in
                        Label {
                            VStack(alignment: .leading, spacing: 1) {
                                Text(detail.title).font(.callout)
                                if let text = detail.text, !text.isEmpty {
                                    Text(text)
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                        .lineLimit(3)
                                        .help(text)
                                }
                            }
                        } icon: {
                            Image(systemName: detail.tone.desktopSymbolName)
                                .foregroundStyle(detail.tone.desktopColor)
                        }
                        .transition(.opacity)
                    }
                }
            }
            .padding(.horizontal, isRunning ? 10 : 2)
            .padding(.vertical, isRunning ? 7 : 3)
            .background {
                if isRunning {
                    RoundedRectangle(cornerRadius: 8, style: .continuous)
                        .fill(Color.accentColor.opacity(0.12))
                }
            }
            .padding(.bottom, entry.isLast ? 0 : 6)
        }
        .fixedSize(horizontal: false, vertical: true)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("工程\(entry.number): \(entry.title)")
        .accessibilityValue(entry.accessibilityValue)
    }

    private func node(_ entry: ShannonAgentPlanTimeline.Entry) -> some View {
        ZStack {
            switch entry.status {
            case .completed:
                Circle().fill(Color.shannonSuccess)
                Image(systemName: "checkmark").font(.system(size: 9, weight: .heavy)).foregroundStyle(.white)
            case .running:
                Circle().fill(Color.accentColor)
                Text("\(entry.number)").font(.system(size: 10, weight: .bold, design: .rounded)).foregroundStyle(.white)
            case .pending:
                Circle().strokeBorder(Color.secondary.opacity(0.6), lineWidth: 1.2)
                Text("\(entry.number)").font(.system(size: 10, weight: .semibold, design: .rounded)).foregroundStyle(.secondary)
            }
        }
        .frame(width: 20, height: 20)
        .accessibilityHidden(true)
    }
}
