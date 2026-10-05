import SwiftUI

struct AgentTaskApprovalCard: View {
    let approval: ShannonAgentApproval
    let palette: ShannonPalette
    let isSubmitting: Bool
    let acceptOnce: () -> Void
    let acceptForSession: () -> Void
    let decline: () -> Void

    @State private var confirmsStoppingDecline = false

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

            Label(ShannonAgentTaskStatus.waitingApproval.japaneseName, systemImage: approval.kind.symbolName)
                .font(.caption.weight(.bold))
                .foregroundStyle(palette.attention)
            Text(approval.title).font(.headline)
            Text(approval.reason)
                .font(.callout)
                .foregroundStyle(palette.textSecondary)
            if let target = approval.target {
                Label(target, systemImage: "lock.fill")
                    .font(.caption.monospaced())
                    .foregroundStyle(palette.textSecondary)
                    .textSelection(.enabled)
                    .accessibilityLabel("許可する対象、\(target)")
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
                        title: ShannonGeneratedStrings.taskApprovalAllowOnce,
                        prominence: .prominent,
                        confirmationTitle: ShannonGeneratedStrings.taskApprovalConfirmOnce(kind: approval.kind.japaneseName),
                        confirmationMessage: approval.title,
                        confirmActionTitle: ShannonGeneratedStrings.taskApprovalAllowOnce,
                        action: acceptOnce
                    )
                } else {
                    Button(action: acceptOnce) { ShannonButtonLabel(ShannonGeneratedStrings.taskApprovalAllowOnce) }
                        .buttonStyle(.borderedProminent)
                        .controlSize(.large)
                }
                ShannonButtonRow {
                    ShannonHoldToConfirmButton(
                        title: ShannonGeneratedStrings.taskApprovalSession,
                        prominence: .standard,
                        confirmationTitle: ShannonGeneratedStrings.taskApprovalConfirmSession(kind: approval.kind.japaneseName),
                        confirmationMessage: ShannonGeneratedStrings.taskApprovalConfirmSessionMessage,
                        confirmActionTitle: ShannonGeneratedStrings.taskApprovalAllowSession,
                        action: acceptForSession
                    )
                    if approval.denyStopsTask {
                        // Declining here stops the whole task for good, so it says so and asks first.
                        Button(role: .destructive) { confirmsStoppingDecline = true } label: {
                            ShannonButtonLabel(Self.stoppingDeclineTitle)
                        }
                        .buttonStyle(.bordered)
                        .controlSize(.large)
                    } else {
                        Button(action: decline) { ShannonButtonLabel(ShannonGeneratedStrings.taskApprovalDeny) }
                            .buttonStyle(.bordered)
                            .controlSize(.large)
                            .accessibilityHint("この操作だけを断ります。作業は中止されません")
                    }
                }
                Text(holdHint)
                    .font(.caption)
                    .foregroundStyle(palette.textSecondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .disabled(isSubmitting)
        }
        .confirmationDialog(
            "許可せずに、この作業を中止しますか？",
            isPresented: $confirmsStoppingDecline,
            titleVisibility: .visible
        ) {
            Button(Self.stoppingDeclineTitle, role: .destructive, action: decline)
            Button(ShannonGeneratedStrings.commonBack, role: .cancel) {}
        } message: {
            Text(Self.stoppingDeclineMessage)
        }
        .padding(ShannonSpacing.large)
        .background(palette.elevatedSurface, in: RoundedRectangle(cornerRadius: ShannonShape.large))
        .overlay { RoundedRectangle(cornerRadius: ShannonShape.large).stroke(palette.attention.opacity(0.35)) }
        .accessibilityElement(children: .contain)
    }
}

extension AgentTaskApprovalCard {
    static let stoppingDeclineTitle = "許可せず作業を中止"
    static let stoppingDeclineMessage = "この実行先では、許可しないと作業全体が止まり、再開できません。完了した工程は残ります。"

    var holdHint: String {
        let target = approval.kind.requiresHoldToConfirm(.once) ? ShannonGeneratedStrings.taskApprovalHoldTargetAllow : ShannonGeneratedStrings.taskApprovalHoldTargetSession
        let decline = approval.denyStopsTask
            ? "「\(Self.stoppingDeclineTitle)」は作業全体を止めます。"
            : "「許可しない」はこの操作だけを断り、シャノンは別の進め方を探すか、次の一手を残して止まります。"
        return ShannonGeneratedStrings.taskApprovalHoldHint(target: target) + decline
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
