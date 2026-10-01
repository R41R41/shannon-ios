import SwiftUI

/// How a task appears inside the conversation. Only a proposal, which needs the
/// owner's decision to start, keeps a full card; running work is a one-line summary and
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
            statusText = task.stateName
            symbolName = "sparkles"
            tone = .action
        case .running:
            style = .active
            statusText = task.plan.isEmpty
                ? task.stateName
                : "\(task.stateName) \(task.completedPlanCount)/\(task.plan.count)"
            symbolName = "hammer"
            tone = .action
        case .waitingApproval:
            style = .active
            statusText = task.stateName
            symbolName = "hand.raised.fill"
            tone = .attention
        case .queued, .starting, .paused:
            // A pause that needs the owner asks for attention; one the owner asked for stays quiet.
            style = .active
            statusText = task.stateName
            symbolName = task.stateSymbolName
            tone = task.needsOwnerToContinue ? .attention : .action
        case .completed:
            style = .quiet
            statusText = task.stateName
            symbolName = "checkmark.circle.fill"
            tone = .success
        case .failed:
            style = .quiet
            statusText = task.stateName
            symbolName = "exclamationmark.triangle.fill"
            tone = .danger
        case .cancelled:
            style = .quiet
            statusText = task.stateName
            symbolName = "xmark.circle"
            tone = .secondary
        }
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
