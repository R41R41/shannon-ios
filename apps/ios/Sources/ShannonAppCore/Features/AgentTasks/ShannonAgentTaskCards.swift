import SwiftUI

/// How a task appears inside the conversation. Only a proposal, which needs the
/// user's decision, keeps a full card; running work is a one-line summary and
/// finished work is a quiet line so the conversation stays readable.
public struct ShannonAgentTaskCardPresentation: Equatable, Sendable {
    public enum Style: Equatable, Sendable {
        case proposal
        case active
        case quiet
    }

    public enum Tone: Equatable, Sendable {
        case action
        case attention
        case success
        case danger
        case secondary
    }

    public let style: Style
    public let statusText: String
    public let symbolName: String
    public let tone: Tone

    public init(task: ShannonAgentTask) {
        switch task.status {
        case .proposed:
            style = .proposal
            statusText = "提案"
            symbolName = "sparkles"
            tone = .action
        case .running:
            style = .active
            statusText = task.plan.isEmpty
                ? task.status.japaneseName
                : "\(task.status.japaneseName) \(task.completedPlanCount)/\(task.plan.count)"
            symbolName = "hammer"
            tone = .action
        case .waitingApproval:
            style = .active
            statusText = "許可が必要"
            symbolName = "hand.raised.fill"
            tone = .attention
        case .queued, .starting, .paused:
            style = .active
            statusText = task.status.japaneseName
            symbolName = task.status.symbolName
            tone = .action
        case .completed:
            style = .quiet
            statusText = "完了"
            symbolName = "checkmark.circle.fill"
            tone = .success
        case .failed:
            style = .quiet
            statusText = "問題あり"
            symbolName = "exclamationmark.triangle.fill"
            tone = .danger
        case .cancelled:
            style = .quiet
            statusText = "中止"
            symbolName = "xmark.circle"
            tone = .secondary
        }
    }

    /// A one-off command or file-change approval can be granted from the notice itself.
    /// Network, permission and session-wide approvals keep the hold-to-confirm flow in the task room.
    public static func quickApproval(for task: ShannonAgentTask) -> ShannonAgentApproval? {
        guard task.status == .waitingApproval, let approval = task.pendingApproval,
              !approval.kind.requiresHoldToConfirm(.once) else { return nil }
        return approval
    }

    func color(_ palette: ShannonPalette) -> Color {
        switch tone {
        case .action: palette.action
        case .attention: palette.attention
        case .success: palette.success
        case .danger: palette.danger
        case .secondary: palette.textSecondary
        }
    }
}

struct ShannonAgentTaskCardView: View {
    let task: ShannonAgentTask
    let cancel: () -> Void
    let open: () -> Void

    @Environment(\.colorScheme) var colorScheme

    var body: some View {
        let palette = ShannonPalette.resolve(colorScheme)
        let presentation = ShannonAgentTaskCardPresentation(task: task)

        Group {
            switch presentation.style {
            case .proposal:
                proposalCard(presentation, palette)
            case .active, .quiet:
                summaryRow(presentation, palette)
            }
        }
        .padding(.leading, 62)
    }

    func proposalCard(_ presentation: ShannonAgentTaskCardPresentation, _ palette: ShannonPalette) -> some View {
        VStack(alignment: .leading, spacing: ShannonSpacing.small) {
            HStack(alignment: .firstTextBaseline, spacing: ShannonSpacing.small) {
                Text(task.title)
                    .font(.callout.weight(.semibold))
                    .foregroundStyle(palette.textPrimary)
                    .lineLimit(2)
                Spacer(minLength: ShannonSpacing.small)
                Label(presentation.statusText, systemImage: presentation.symbolName)
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(palette.brandPresence)
                    .padding(.horizontal, ShannonSpacing.small)
                    .frame(minHeight: 22)
                    .background(palette.intelligenceSoft, in: Capsule())
            }

            Text(task.summary)
                .font(.caption)
                .foregroundStyle(palette.textSecondary)
                .lineLimit(3)

            ViewThatFits(in: .horizontal) {
                HStack(spacing: ShannonSpacing.small) {
                    Spacer(minLength: 0)
                    proposalButtons
                }
                VStack(alignment: .trailing, spacing: ShannonSpacing.small) {
                    proposalButtons
                }
            }
        }
        .padding(ShannonSpacing.medium)
        .background(
            palette.userMessage.opacity(colorScheme == .dark ? 0.34 : 0.48),
            in: RoundedRectangle(cornerRadius: ShannonShape.large, style: .continuous)
        )
        .overlay {
            RoundedRectangle(cornerRadius: ShannonShape.large, style: .continuous)
                .stroke(palette.action.opacity(0.26), lineWidth: 0.8)
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("シャノンの作業の提案、\(task.title)")
    }

    @ViewBuilder
    var proposalButtons: some View {
        Button("今はやめる", action: cancel)
            .buttonStyle(.bordered)
            .lineLimit(1)
        Button("設定して始める", action: open)
            .buttonStyle(.borderedProminent)
            .lineLimit(1)
    }

    func summaryRow(_ presentation: ShannonAgentTaskCardPresentation, _ palette: ShannonPalette) -> some View {
        let tint = presentation.color(palette)
        let isActive = presentation.style == .active
        return Button(action: open) {
            HStack(spacing: ShannonSpacing.small) {
                Image(systemName: presentation.symbolName)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(tint)
                    .frame(width: 20)
                    .accessibilityHidden(true)
                Text(task.title)
                    .font(.subheadline.weight(isActive ? .semibold : .regular))
                    .foregroundStyle(isActive ? palette.textPrimary : palette.textSecondary)
                    .lineLimit(1)
                Spacer(minLength: ShannonSpacing.small)
                Text(presentation.statusText)
                    .font(.caption.weight(isActive ? .semibold : .regular))
                    .foregroundStyle(presentation.tone == .action ? palette.textSecondary : tint)
                    .monospacedDigit()
                    .lineLimit(1)
                    .fixedSize()
                Image(systemName: "chevron.right")
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(palette.textSecondary)
                    .accessibilityHidden(true)
            }
            .padding(.horizontal, ShannonSpacing.medium)
            .frame(minHeight: ShannonTouchTarget.minimum)
            .background {
                if isActive {
                    RoundedRectangle(cornerRadius: ShannonShape.medium, style: .continuous)
                        .fill(palette.userMessage.opacity(colorScheme == .dark ? 0.34 : 0.48))
                        .overlay {
                            RoundedRectangle(cornerRadius: ShannonShape.medium, style: .continuous)
                                .stroke(tint.opacity(0.26), lineWidth: 0.8)
                        }
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("シャノンの作業、\(task.title)、\(presentation.statusText)")
        .accessibilityHint("作業画面を開きます")
    }
}

/// One-line notice under the navigation bar for work that finished or needs a decision.
/// A one-off command or file-change approval adds a trailing 「許可」 so it can be granted in place.
struct ShannonAgentTaskCapsule: View {
    let task: ShannonAgentTask
    var actionError: String?
    let open: () -> Void
    var approveOnce: (() -> Void)?

    @Environment(\.colorScheme) var colorScheme
    @State private var approvedCount = 0
    /// The approval already sent from this notice, so a second tap cannot send it twice.
    @State private var sentApprovalID: UUID?

    var body: some View {
        let palette = ShannonPalette.resolve(colorScheme)
        let presentation = ShannonAgentTaskCardPresentation(task: task)
        let tint = presentation.color(palette)
        let tintBackground: Color = switch presentation.tone {
        case .attention: palette.attentionTint
        case .success: palette.successTint
        case .danger: palette.dangerTint
        default: palette.subtleSurface
        }
        let text: Color = switch presentation.tone {
        case .attention: palette.onAttentionTint
        case .success: palette.onSuccessTint
        case .danger: palette.onDangerTint
        default: palette.textPrimary
        }
        let approval = approveOnce == nil || actionError != nil
            ? nil : ShannonAgentTaskCardPresentation.quickApproval(for: task)
        let message = actionError != nil
            ? "判断を送信できませんでした：\(task.title)"
            : "\(presentation.statusText)：\(approval?.title ?? task.title)"

        HStack(spacing: ShannonSpacing.small) {
            Button(action: open) {
                HStack(spacing: ShannonSpacing.small) {
                    Image(systemName: actionError != nil ? "exclamationmark.triangle.fill" : presentation.symbolName)
                        .font(.caption.weight(.bold))
                        .foregroundStyle(tint)
                        .accessibilityHidden(true)
                    Text(message)
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(text)
                        .lineLimit(1)
                    Spacer(minLength: 0)
                    if approval == nil {
                        Image(systemName: "chevron.right")
                            .font(.caption2.weight(.bold))
                            .foregroundStyle(text.opacity(0.7))
                            .accessibilityHidden(true)
                    }
                }
                .frame(minHeight: approval == nil ? 36 : ShannonTouchTarget.minimum)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("シャノンの作業、\(task.title)、\(actionError ?? presentation.statusText)")
            .accessibilityHint("作業画面を開きます")

            if let approval, let approveOnce {
                Button {
                    guard sentApprovalID != approval.id else { return }
                    sentApprovalID = approval.id
                    approvedCount += 1
                    approveOnce()
                } label: {
                    Text("許可")
                        .font(.footnote.weight(.bold))
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
                .accessibilityLabel("今回だけ許可、\(approval.title)")
                .accessibilityHint("この\(approval.kind.japaneseName)を今回だけ許可します。内容は左の通知から開けます")
            }
        }
        .padding(.leading, ShannonSpacing.medium)
        .padding(.trailing, approval == nil ? ShannonSpacing.medium : ShannonSpacing.extraSmall + 2)
        .background(tintBackground, in: Capsule())
        .frame(minHeight: ShannonTouchTarget.minimum)
        .padding(.horizontal, ShannonSpacing.large)
        .sensoryFeedback(.success, trigger: approvedCount)
        .onChange(of: actionError) {
            if actionError != nil { sentApprovalID = nil }
        }
    }
}
