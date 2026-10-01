import SwiftUI

/// Shown first in the room when the host stopped and is waiting for the owner:
/// the next action in full, and the resume control on the screen instead of in a menu.
struct AgentTaskNextActionCard: View {
    let task: ShannonAgentTask
    let palette: ShannonPalette
    let isBusy: Bool
    let resume: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: ShannonSpacing.medium) {
            Label("次にあなたがすること", systemImage: "arrow.uturn.forward.circle.fill")
                .font(.caption.weight(.bold))
                .foregroundStyle(palette.attention)
            Text(task.nextAction ?? "残っている工程を確認してください。")
                .font(.headline)
                .foregroundStyle(palette.textPrimary)
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)
            Button(action: resume) {
                if isBusy {
                    HStack(spacing: ShannonSpacing.small) {
                        ProgressView().controlSize(.small)
                        ShannonButtonLabel("送信中…")
                    }
                } else {
                    ShannonButtonLabel("作業を再開")
                }
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
            .disabled(isBusy)
            .accessibilityHint("シャノンが止まったところから作業を続けます")
            Text("済んだら「作業を再開」。別の進め方にするときは、下の欄から指示を送ると、その内容で再開します。")
                .font(.caption)
                .foregroundStyle(palette.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(ShannonSpacing.large)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(palette.elevatedSurface, in: RoundedRectangle(cornerRadius: ShannonShape.large))
        .overlay { RoundedRectangle(cornerRadius: ShannonShape.large).stroke(palette.attention.opacity(0.35)) }
        .accessibilityElement(children: .contain)
    }
}

/// Next operations for finished, failed, and stopped work. A finished task takes no
/// more commands, so a follow-up continues in the thread the work came from.
struct AgentTaskFollowUpCard: View {
    let task: ShannonAgentTask
    /// Title of the source thread, or nil when that thread is no longer on this device.
    let sourceThreadTitle: String?
    let palette: ShannonPalette
    let followUp: (ShannonAgentTaskFollowUp) -> Void
    let openSourceThread: () -> Void

    var body: some View {
        AgentTaskSection(title: "次にできること", symbol: "arrow.turn.down.right", palette: palette) {
            VStack(alignment: .leading, spacing: ShannonSpacing.small) {
                if let sourceThreadTitle {
                    ShannonButtonRow {
                        ForEach(ShannonAgentTaskFollowUp.allCases, id: \.self) { kind in
                            Button { followUp(kind) } label: { ShannonButtonLabel(kind.title) }
                                .buttonStyle(.bordered)
                                .controlSize(.large)
                                .accessibilityHint("元のトークの入力欄に下書きを入れます。送信はしません")
                        }
                    }
                    Button(action: openSourceThread) { ShannonButtonLabel("元のトークへ戻る") }
                        .buttonStyle(.bordered)
                        .controlSize(.large)
                    Text("「修正を頼む」「続きを頼む」は、元のトーク「\(sourceThreadTitle)」の入力欄に下書きを入れます。送信するまで何も始まりません。")
                        .font(.caption)
                        .foregroundStyle(palette.textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                } else {
                    Text("この作業を頼んだトークは、この端末にありません。新しいトークで、作業名を添えて頼み直せます。")
                        .font(.callout)
                        .foregroundStyle(palette.textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }
}

/// The task result as 変更 / 検証 / 未解決. Empty sections are left out.
struct AgentTaskResultSection: View {
    let task: ShannonAgentTask
    let palette: ShannonPalette

    var body: some View {
        let report = ShannonAgentTaskReport(task: task)

        VStack(alignment: .leading, spacing: ShannonSpacing.large) {
            if !report.changes.isEmpty {
                AgentTaskSection(title: "変更", symbol: "doc.badge.gearshape", palette: palette) {
                    VStack(spacing: ShannonSpacing.small) {
                        ForEach(report.changes) { change in changeRow(change) }
                    }
                }
            }

            if !report.tests.isEmpty {
                AgentTaskSection(title: "検証", symbol: "checkmark.seal", palette: palette) {
                    VStack(alignment: .leading, spacing: ShannonSpacing.small) {
                        ForEach(report.tests) { test in
                            HStack(alignment: .firstTextBaseline, spacing: ShannonSpacing.medium) {
                                Image(systemName: testSymbol(test.status))
                                    .foregroundStyle(test.status == .failed ? palette.danger : palette.action)
                                    .accessibilityHidden(true)
                                Text(test.name).font(.callout)
                                Spacer()
                                Text(test.detail ?? testWord(test.status))
                                    .font(.caption)
                                    .foregroundStyle(test.status == .failed ? palette.danger : palette.textSecondary)
                            }
                            .accessibilityElement(children: .combine)
                        }
                    }
                }
            }

            if !report.unresolved.isEmpty {
                AgentTaskSection(title: "未解決", symbol: "exclamationmark.circle", palette: palette) {
                    VStack(alignment: .leading, spacing: ShannonSpacing.small) {
                        ForEach(report.unresolved, id: \.self) { item in
                            Label(item, systemImage: "circle.dashed")
                                .font(.callout)
                                .foregroundStyle(palette.textPrimary)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                }
            }
        }
    }

    func changeRow(_ change: ShannonAgentChangeSummary) -> some View {
        HStack(alignment: .top, spacing: ShannonSpacing.medium) {
            Image(systemName: "doc.text")
                .foregroundStyle(palette.action)
                .accessibilityHidden(true)
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

    func testSymbol(_ status: ShannonAgentTestStatus) -> String {
        switch status {
        case .pending: "circle.dotted"
        case .passed: "checkmark.circle.fill"
        case .failed: "xmark.circle.fill"
        }
    }

    func testWord(_ status: ShannonAgentTestStatus) -> String {
        switch status {
        case .pending: "未実行"
        case .passed: "成功"
        case .failed: "失敗"
        }
    }
}
