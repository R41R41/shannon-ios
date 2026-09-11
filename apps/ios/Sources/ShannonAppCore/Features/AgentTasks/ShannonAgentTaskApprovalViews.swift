import SwiftUI

struct AgentTaskApprovalCard: View {
    let approval: ShannonAgentApproval
    let palette: M3Palette
    let isSubmitting: Bool
    let acceptOnce: () -> Void
    let acceptForSession: () -> Void
    let decline: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: M3Spacing.medium) {
            Label("判断が必要", systemImage: approval.kind.symbolName)
                .font(.caption.weight(.bold))
                .foregroundStyle(palette.warning)
            Text(approval.title).font(.headline)
            Text(approval.reason)
                .font(.callout)
                .foregroundStyle(palette.onSurfaceVariant)
            if let resource = approval.resource {
                Label(resource, systemImage: "lock.fill")
                    .font(.caption.monospaced())
                    .foregroundStyle(palette.onSurfaceVariant)
            }
            VStack(spacing: M3Spacing.small) {
                Button(action: acceptOnce) {
                    HStack(spacing: M3Spacing.small) {
                        if isSubmitting { ProgressView().controlSize(.small).tint(palette.onPrimary) }
                        Text(isSubmitting ? "送信中…" : "今回だけ許可")
                    }
                }
                    .buttonStyle(AgentTaskProminentButtonStyle(palette: palette))
                    .disabled(isSubmitting)
                HStack(spacing: M3Spacing.small) {
                    Button("この作業中", action: acceptForSession)
                        .buttonStyle(AgentTaskQuietButtonStyle(palette: palette))
                        .disabled(isSubmitting)
                    Button("許可しない", action: decline)
                        .buttonStyle(AgentTaskQuietButtonStyle(palette: palette))
                        .disabled(isSubmitting)
                }
            }
        }
        .padding(M3Spacing.large)
        .background(palette.surfaceContainerHigh, in: RoundedRectangle(cornerRadius: M3Shape.large))
        .overlay { RoundedRectangle(cornerRadius: M3Shape.large).stroke(palette.warning.opacity(0.35)) }
        .accessibilityElement(children: .contain)
    }
}

struct AgentTaskActionErrorCard: View {
    let message: String
    let palette: M3Palette
    let dismiss: () -> Void

    var body: some View {
        HStack(alignment: .top, spacing: M3Spacing.medium) {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(palette.error)
            Text(message)
                .font(.callout)
                .foregroundStyle(palette.onErrorContainer)
                .frame(maxWidth: .infinity, alignment: .leading)
            Button(action: dismiss) {
                Image(systemName: "xmark")
                    .font(.caption.weight(.bold))
                    .frame(width: 28, height: 28)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("エラーを閉じる")
        }
        .padding(M3Spacing.medium)
        .background(palette.errorContainer, in: RoundedRectangle(cornerRadius: M3Shape.medium))
        .accessibilityElement(children: .combine)
    }
}

struct AgentTaskResultSection: View {
    let task: ShannonAgentTask
    let palette: M3Palette

    var body: some View {
        VStack(alignment: .leading, spacing: M3Spacing.large) {
            if !task.changes.isEmpty {
                AgentTaskSection(title: "変更", symbol: "doc.badge.gearshape", palette: palette) {
                    VStack(spacing: M3Spacing.small) {
                        ForEach(task.changes) { change in
                            HStack(alignment: .top, spacing: M3Spacing.medium) {
                                Image(systemName: "doc.text")
                                    .foregroundStyle(palette.primary)
                                VStack(alignment: .leading, spacing: 3) {
                                    Text(change.displayName).font(.callout.weight(.semibold))
                                    Text(change.summary).font(.caption).foregroundStyle(palette.onSurfaceVariant)
                                }
                                Spacer()
                                Text("+\(change.additions) −\(change.deletions)")
                                    .font(.caption2.monospacedDigit())
                                    .foregroundStyle(palette.onSurfaceVariant)
                            }
                            .padding(M3Spacing.medium)
                            .background(palette.surfaceContainerLow, in: RoundedRectangle(cornerRadius: M3Shape.medium))
                        }
                    }
                }
            }

            if !task.tests.isEmpty {
                AgentTaskSection(title: "確認", symbol: "checkmark.seal", palette: palette) {
                    VStack(spacing: M3Spacing.small) {
                        ForEach(task.tests) { test in
                            HStack(spacing: M3Spacing.medium) {
                                Image(systemName: testSymbol(test.status))
                                    .foregroundStyle(test.status == .failed ? palette.error : palette.primary)
                                Text(test.name).font(.callout)
                                Spacer()
                                if let detail = test.detail {
                                    Text(detail).font(.caption).foregroundStyle(palette.onSurfaceVariant)
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    func testSymbol(_ status: ShannonAgentTestStatus) -> String {
        switch status {
        case .pending: "circle.dotted"
        case .passed: "checkmark.circle.fill"
        case .failed: "xmark.circle.fill"
        }
    }
}
