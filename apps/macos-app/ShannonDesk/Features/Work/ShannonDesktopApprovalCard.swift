import AppKit
import ShannonAppCore
import SwiftUI

/// The three choices of an approval on the Mac (roadmap A11, decision 2026-10-03):
/// 今回だけ許可／この作業中／許可しない. A permission that lasts (「この作業中」, and 「今回だけ許可」
/// for network and permission) is decided by holding the pointer down for 0.6 s; a click, the
/// keyboard and VoiceOver open a confirmation with the same words, so holding is never required.
extension ShannonDesktopRootView {
    /// Same decision material as iPhone: the task state word, the reason, and the concrete target.
    func taskApprovalCard(_ task: ShannonAgentTask, approval: ShannonAgentApproval) -> some View {
        VStack(alignment: .leading, spacing: ShannonDesktopSpacing.medium) {
            Label(ShannonAgentTaskStatus.waitingApproval.japaneseName, systemImage: approval.kind.symbolName)
                .font(.shannonDesktop(.headline))
            Text(approval.title)
            Text(approval.reason)
                .font(.shannonDesktop(.callout))
                .foregroundStyle(.secondary)
            if let target = approval.target {
                Label(target, systemImage: "lock.fill")
                    .font(.shannonDesktop(.callout).monospaced())
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
                    .accessibilityLabel("許可する対象、\(target)")
            }
            VStack(spacing: ShannonDesktopSpacing.small) {
                if approval.kind.requiresHoldToConfirm(.once) {
                    ShannonHoldToConfirmButton(
                        title: ShannonGeneratedStrings.taskApprovalAllowOnce,
                        prominence: .prominent,
                        confirmationTitle: ShannonGeneratedStrings.taskApprovalConfirmOnce(kind: approval.kind.japaneseName),
                        confirmationMessage: approval.title,
                        confirmActionTitle: ShannonGeneratedStrings.taskApprovalAllowOnce
                    ) {
                        Task { await conversation.resolveAgentApproval(task.id, accepted: true, requestID: approval.externalRequestID) }
                    }
                } else {
                    Button {
                        Task { await conversation.resolveAgentApproval(task.id, accepted: true, requestID: approval.externalRequestID) }
                    } label: {
                        Text(ShannonGeneratedStrings.taskApprovalAllowOnce)
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.large)
                }
                ShannonHoldToConfirmButton(
                    title: ShannonGeneratedStrings.taskApprovalSession,
                    prominence: .standard,
                    confirmationTitle: ShannonGeneratedStrings.taskApprovalConfirmSession(kind: approval.kind.japaneseName),
                    confirmationMessage: ShannonGeneratedStrings.taskApprovalConfirmSessionMessage,
                    confirmActionTitle: ShannonGeneratedStrings.taskApprovalAllowSession
                ) {
                    Task { await conversation.resolveAgentApproval(task.id, accepted: true, forSession: true, requestID: approval.externalRequestID) }
                }
                if approval.denyStopsTask {
                    Button(role: .destructive) {
                        taskStopConfirmation = .denyAndStop(task.id, requestID: approval.externalRequestID)
                    } label: {
                        Text("許可せず作業を中止").frame(maxWidth: .infinity)
                    }
                    .controlSize(.large)
                } else {
                    Button {
                        Task { await conversation.resolveAgentApproval(task.id, accepted: false, requestID: approval.externalRequestID) }
                    } label: {
                        Text(ShannonGeneratedStrings.taskApprovalDeny).frame(maxWidth: .infinity)
                    }
                    .controlSize(.large)
                    .help("この操作だけを断ります。作業は中止されません")
                }
            }
            .disabled(conversation.isAgentTaskActionInFlight(task.id))
            Text(DesktopApprovalCopy.hint(kind: approval.kind, denyStopsTask: approval.denyStopsTask))
                .font(.shannonDesktop(.caption))
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(ShannonDesktopSpacing.large)
        .background(Color.shannonAttention.opacity(0.10), in: RoundedRectangle(cornerRadius: ShannonDesktopRadius.medium))
    }
}

/// The sentence under the three choices: which one is held, and what 「許可しない」 does.
enum DesktopApprovalCopy {
    static func hint(kind: ShannonAgentApprovalKind, denyStopsTask: Bool) -> String {
        let target = kind.requiresHoldToConfirm(.once)
            ? ShannonGeneratedStrings.taskApprovalHoldTargetAllow
            : ShannonGeneratedStrings.taskApprovalHoldTargetSession
        let decline = denyStopsTask
            ? "「許可せず作業を中止」は作業全体を止めます。"
            : "「許可しない」はこの操作だけを断り、シャノンは別の進め方を探すか、次の一手を残して止まります。"
        return ShannonGeneratedStrings.taskApprovalHoldHintClick(target: target) + decline
    }
}
