import SwiftUI

/// What the notice under the navigation bar says about a task that needs the owner.
public struct ShannonAgentTaskNoticePresentation: Equatable, Sendable {
    /// 「状態語：作業名」, so the owner always sees which task it is.
    public let headline: String
    /// What exactly is waiting: the command or destination to approve, or the next action.
    public let detail: String?
    /// Monospaced when the detail is a command, path, or destination.
    public let detailIsTarget: Bool
    /// Set only when the owner can read the whole target in the notice and grant it there.
    public let quickApproval: ShannonAgentApproval?

    /// - Parameter showsDetail: false at accessibility text sizes, where the notice keeps one line.
    public init(task: ShannonAgentTask, showsDetail: Bool = true) {
        let card = ShannonAgentTaskCardPresentation(task: task)
        headline = ShannonGeneratedStrings.taskNoticeHeadline(state: card.statusText, title: task.title)
        if task.status == .waitingApproval, let approval = task.pendingApproval {
            detail = showsDetail ? (approval.target ?? approval.title) : nil
            detailIsTarget = approval.target != nil
            quickApproval = showsDetail ? Self.quickApproval(for: task) : nil
        } else {
            detail = showsDetail ? task.nextAction.map { "次：\($0)" } : nil
            detailIsTarget = false
            quickApproval = nil
        }
    }

    /// A one-off command or file-change approval can be granted from the notice, but only
    /// when the notice shows the whole concrete target. Without a target, or with one that
    /// is long or truncated, the notice opens the task room instead. Network, permission
    /// and session-wide approvals keep the hold-to-confirm flow in the task room.
    public static func quickApproval(for task: ShannonAgentTask) -> ShannonAgentApproval? {
        guard task.status == .waitingApproval, let approval = task.pendingApproval,
              !approval.kind.requiresHoldToConfirm(.once),
              approval.noticeTarget != nil else { return nil }
        return approval
    }
}

/// Notice under the navigation bar for work that finished, stopped, or needs a decision.
/// It names the task and shows what is waiting; a one-off command or file-change approval
/// whose target is fully visible adds a trailing 「許可」 so it can be granted in place.
public struct ShannonAgentTaskCapsule: View {
    let task: ShannonAgentTask
    var actionError: String?
    let open: () -> Void
    var approveOnce: (() -> Void)?

    /// Also the Mac's notice above Talk (roadmap A14).
    public init(task: ShannonAgentTask, actionError: String? = nil, open: @escaping () -> Void, approveOnce: (() -> Void)? = nil) {
        self.task = task
        self.actionError = actionError
        self.open = open
        self.approveOnce = approveOnce
    }

    @Environment(\.colorScheme) var colorScheme
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @State private var approvedCount = 0
    /// The approval already sent from this notice, so a second tap cannot send it twice.
    @State private var sentApprovalID: UUID?

    public var body: some View {
        let palette = ShannonPalette.resolve(colorScheme)
        let card = ShannonAgentTaskCardPresentation(task: task)
        let notice = ShannonAgentTaskNoticePresentation(
            task: task,
            showsDetail: !dynamicTypeSize.isAccessibilitySize
        )
        let tint = card.color(palette)
        let tintBackground: Color = switch card.tone {
        case .attention: palette.attentionTint
        case .success: palette.successTint
        case .danger: palette.dangerTint
        default: palette.subtleSurface
        }
        let text: Color = switch card.tone {
        case .attention: palette.onAttentionTint
        case .success: palette.onSuccessTint
        case .danger: palette.onDangerTint
        default: palette.textPrimary
        }
        let approval = approveOnce == nil || actionError != nil ? nil : notice.quickApproval
        let detail = actionError == nil ? notice.detail : nil
        let shape = RoundedRectangle(cornerRadius: detail == nil ? 22 : ShannonShape.large, style: .continuous)

        HStack(spacing: ShannonSpacing.small) {
            Button(action: open) {
                HStack(alignment: .firstTextBaseline, spacing: ShannonSpacing.small) {
                    Image(systemName: actionError != nil ? "exclamationmark.triangle.fill" : card.symbolName)
                        .font(.shannon(.caption).weight(.bold))
                        .foregroundStyle(tint)
                        .accessibilityHidden(true)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(actionError != nil ? "判断を送信できませんでした：\(task.title)" : notice.headline)
                            .font(.shannon(.footnote).weight(.semibold))
                            .foregroundStyle(text)
                            .lineLimit(1)
                        if let detail {
                            // The target of an in-place approval is never cut off: what is granted is what is read.
                            Text(detail)
                                .font(notice.detailIsTarget ? .shannon(.caption).monospaced() : .shannon(.caption))
                                .foregroundStyle(text.opacity(0.86))
                                .lineLimit(approval == nil ? 2 : nil)
                                .fixedSize(horizontal: false, vertical: true)
                                .multilineTextAlignment(.leading)
                        }
                    }
                    Spacer(minLength: 0)
                    if approval == nil {
                        Image(systemName: "chevron.right")
                            .font(.shannon(.caption2).weight(.bold))
                            .foregroundStyle(text.opacity(0.7))
                            .accessibilityHidden(true)
                    }
                }
                .padding(.vertical, detail == nil ? 0 : ShannonSpacing.small)
                .frame(minHeight: ShannonTouchTarget.minimum)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(accessibilityLabel(card: card, detail: detail))
            .accessibilityHint("作業画面を開きます")

            if let approval, let approveOnce {
                Button {
                    guard sentApprovalID != approval.id else { return }
                    sentApprovalID = approval.id
                    approvedCount += 1
                    approveOnce()
                } label: {
                    Text("許可")
                        .font(.shannon(.footnote).weight(.bold))
                        .foregroundStyle(tintBackground)
                        .padding(.horizontal, ShannonSpacing.medium)
                        .frame(minHeight: 30)
                        .background(text, in: Capsule())
                        .frame(minHeight: ShannonTouchTarget.minimum)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .disabled(sentApprovalID == approval.id)
                .opacity(sentApprovalID == approval.id ? 0.5 : 1)
                .accessibilityLabel("今回だけ許可、\(approval.noticeTarget ?? approval.title)")
                .accessibilityHint("「\(task.title)」のこの\(approval.kind.japaneseName)を今回だけ許可します")
            }
        }
        .padding(.leading, ShannonSpacing.medium)
        .padding(.trailing, approval == nil ? ShannonSpacing.medium : ShannonSpacing.extraSmall + 2)
        .background(tintBackground, in: shape)
        .padding(.horizontal, ShannonSpacing.large)
        .sensoryFeedback(.success, trigger: approvedCount)
        .onChange(of: actionError) {
            if actionError != nil { sentApprovalID = nil }
        }
    }

    private func accessibilityLabel(card: ShannonAgentTaskCardPresentation, detail: String?) -> String {
        if let actionError { return "シャノンの作業、\(task.title)、\(actionError)" }
        return ["シャノンの作業", task.title, card.statusText, detail]
            .compactMap { $0 }
            .joined(separator: "、")
    }
}
