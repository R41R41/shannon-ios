import SwiftUI

struct AgentTaskApprovalCard: View {
    let approval: ShannonAgentApproval
    let palette: ShannonPalette
    let isSubmitting: Bool
    let acceptOnce: () -> Void
    let acceptForSession: () -> Void
    let decline: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: ShannonSpacing.medium) {
            HStack(alignment: .center, spacing: ShannonSpacing.small) {
                ShannonAvatarView(expression: ShannonAgentTaskStatus.waitingApproval.expression, size: 28)
                Text(ShannonAgentTaskRoomPresentation.approvalHeader)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(palette.textPrimary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .accessibilityElement(children: .combine)
            .accessibilityAddTraits(.isHeader)

            Label("判断が必要", systemImage: approval.kind.symbolName)
                .font(.caption.weight(.bold))
                .foregroundStyle(palette.attention)
            Text(approval.title).font(.headline)
            Text(approval.reason)
                .font(.callout)
                .foregroundStyle(palette.textSecondary)
            if let resource = approval.resource {
                Label(resource, systemImage: "lock.fill")
                    .font(.caption.monospaced())
                    .foregroundStyle(palette.textSecondary)
            }
            VStack(spacing: ShannonSpacing.small) {
                if isSubmitting {
                    HStack(spacing: ShannonSpacing.small) {
                        ProgressView().controlSize(.small)
                        Text("送信中…").lineLimit(1)
                    }
                    .font(.body.weight(.semibold))
                    .foregroundStyle(palette.textSecondary)
                    .frame(maxWidth: .infinity, minHeight: 50)
                } else if approval.kind.requiresHoldToConfirm(.once) {
                    ShannonHoldToConfirmButton(
                        title: "今回だけ許可",
                        prominence: .prominent,
                        confirmationTitle: "今回だけ\(approval.kind.japaneseName)を許可しますか？",
                        confirmationMessage: approval.title,
                        confirmActionTitle: "今回だけ許可",
                        action: acceptOnce
                    )
                } else {
                    Button(action: acceptOnce) { ShannonButtonLabel("今回だけ許可") }
                        .buttonStyle(.borderedProminent)
                        .controlSize(.large)
                }
                ShannonButtonRow {
                    ShannonHoldToConfirmButton(
                        title: "この作業中",
                        prominence: .standard,
                        confirmationTitle: "この作業が終わるまで\(approval.kind.japaneseName)を許可しますか？",
                        confirmationMessage: "この作業が終わるまで有効です。",
                        confirmActionTitle: "この作業中は許可",
                        action: acceptForSession
                    )
                    Button(action: decline) { ShannonButtonLabel("許可しない") }
                        .buttonStyle(.bordered)
                        .controlSize(.large)
                }
                Text(holdHint)
                    .font(.caption)
                    .foregroundStyle(palette.textSecondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .disabled(isSubmitting)
        }
        .padding(ShannonSpacing.large)
        .background(palette.elevatedSurface, in: RoundedRectangle(cornerRadius: ShannonShape.large))
        .overlay { RoundedRectangle(cornerRadius: ShannonShape.large).stroke(palette.attention.opacity(0.35)) }
        .accessibilityElement(children: .contain)
    }
}

extension AgentTaskApprovalCard {
    var holdHint: String {
        let target = approval.kind.requiresHoldToConfirm(.once) ? "許可ボタン" : "「この作業中」"
        return "\(target)は長押しで決定。タップすると確認してから決定します。"
    }
}

struct AgentTaskActionErrorCard: View {
    let message: String
    let palette: ShannonPalette
    let dismiss: () -> Void

    var body: some View {
        HStack(alignment: .top, spacing: ShannonSpacing.medium) {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(palette.danger)
            Text(message)
                .font(.callout)
                .foregroundStyle(palette.onDangerTint)
                .frame(maxWidth: .infinity, alignment: .leading)
            Button(action: dismiss) {
                Image(systemName: "xmark")
                    .font(.caption.weight(.bold))
                    .frame(width: 28, height: 28)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("エラーを閉じる")
        }
        .padding(ShannonSpacing.medium)
        .background(palette.dangerTint, in: RoundedRectangle(cornerRadius: ShannonShape.medium))
        .accessibilityElement(children: .combine)
    }
}

struct AgentTaskResultSection: View {
    let task: ShannonAgentTask
    let palette: ShannonPalette

    var body: some View {
        VStack(alignment: .leading, spacing: ShannonSpacing.large) {
            if !task.changes.isEmpty {
                AgentTaskSection(title: "変更", symbol: "doc.badge.gearshape", palette: palette) {
                    VStack(spacing: ShannonSpacing.small) {
                        ForEach(task.changes) { change in
                            HStack(alignment: .top, spacing: ShannonSpacing.medium) {
                                Image(systemName: "doc.text")
                                    .foregroundStyle(palette.action)
                                VStack(alignment: .leading, spacing: 3) {
                                    Text(change.displayName).font(.callout.weight(.semibold))
                                    if let path = change.path, path != change.displayName {
                                        Text(path)
                                            .font(.caption2.monospaced())
                                            .foregroundStyle(palette.textSecondary)
                                            .textSelection(.enabled)
                                    }
                                    Text(change.summary).font(.caption).foregroundStyle(palette.textSecondary)
                                    if let diff = change.diffPreview, !diff.isEmpty {
                                        DisclosureGroup("差分を表示") {
                                            ScrollView(.horizontal) {
                                                Text(diff)
                                                    .font(.caption2.monospaced())
                                                    .textSelection(.enabled)
                                                    .frame(maxWidth: .infinity, alignment: .leading)
                                                    .padding(.top, ShannonSpacing.small)
                                            }
                                        }
                                        .font(.caption)
                                        .tint(palette.action)
                                    }
                                }
                                Spacer()
                                Text("+\(change.additions) −\(change.deletions)")
                                    .font(.caption2.monospacedDigit())
                                    .foregroundStyle(palette.textSecondary)
                            }
                            .padding(ShannonSpacing.medium)
                            .background(palette.readingSurface, in: RoundedRectangle(cornerRadius: ShannonShape.medium))
                        }
                    }
                }
            }

            if !task.tests.isEmpty {
                AgentTaskSection(title: "確認", symbol: "checkmark.seal", palette: palette) {
                    VStack(spacing: ShannonSpacing.small) {
                        ForEach(task.tests) { test in
                            HStack(spacing: ShannonSpacing.medium) {
                                Image(systemName: testSymbol(test.status))
                                    .foregroundStyle(test.status == .failed ? palette.danger : palette.action)
                                Text(test.name).font(.callout)
                                Spacer()
                                if let detail = test.detail {
                                    Text(detail).font(.caption).foregroundStyle(palette.textSecondary)
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
