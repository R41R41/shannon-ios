import SwiftUI

struct ShannonAgentTaskCardView: View {
    let task: ShannonAgentTask
    let start: () -> Void
    let cancel: () -> Void
    let open: () -> Void

    @Environment(\.colorScheme) var colorScheme

    var body: some View {
        let palette = M3Palette.resolve(colorScheme)

        VStack(alignment: .leading, spacing: M3Spacing.medium) {
            HStack(alignment: .firstTextBaseline, spacing: M3Spacing.small) {
                Text(task.title)
                    .font(.callout.weight(.semibold))
                    .foregroundStyle(palette.onSurface)
                    .lineLimit(2)
                Spacer(minLength: M3Spacing.small)
                AgentTaskStatusBadge(task: task, palette: palette)
            }

            Text(task.summary)
                .font(.caption)
                .foregroundStyle(palette.onSurfaceVariant)
                .lineLimit(3)

            if let progress = task.progressFraction, !task.status.isTerminal {
                ProgressView(value: progress)
                    .tint(palette.primary)
                    .accessibilityLabel("作業の進み具合")
                    .accessibilityValue("全\(task.plan.count)工程中\(task.completedPlanCount)工程完了")
            }

            switch task.status {
            case .proposed:
                HStack(spacing: M3Spacing.small) {
                    Button("始める", action: start)
                        .buttonStyle(AgentTaskProminentButtonStyle(palette: palette))
                    Button("今はやめる", action: cancel)
                        .buttonStyle(AgentTaskQuietButtonStyle(palette: palette))
                }
            case .cancelled:
                EmptyView()
            default:
                Button(action: open) {
                    HStack {
                        Text(task.status == .completed ? "結果を見る"
                            : task.status == .waitingApproval ? "許可内容を見る"
                            : "作業を見る")
                        Spacer()
                        Image(systemName: "arrow.right")
                    }
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(palette.primary)
                    .frame(minHeight: 34)
                }
                .buttonStyle(.plain)
            }
        }
        .padding(M3Spacing.large)
        .background(
            palette.primaryContainer.opacity(colorScheme == .dark ? 0.34 : 0.48),
            in: RoundedRectangle(cornerRadius: M3Shape.large, style: .continuous)
        )
        .overlay {
            RoundedRectangle(cornerRadius: M3Shape.large, style: .continuous)
                .stroke(palette.primary.opacity(0.26), lineWidth: 0.8)
        }
        .padding(.leading, 62)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("シャノンの作業、\(task.title)、\(task.stage.japaneseName)")
    }
}

struct ShannonAgentTaskCapsule: View {
    let task: ShannonAgentTask
    let open: () -> Void

    @Environment(\.colorScheme) var colorScheme

    var body: some View {
        let palette = M3Palette.resolve(colorScheme)

        Button(action: open) {
            HStack(spacing: M3Spacing.medium) {
                ShannonAvatarView(expression: task.expression, size: 36)
                VStack(alignment: .leading, spacing: 2) {
                    if task.status == .waitingApproval {
                        Label("許可が必要です", systemImage: "hand.raised.fill")
                            .font(.caption.weight(.bold))
                            .foregroundStyle(palette.warning)
                            .lineLimit(1)
                    } else {
                        Text(task.stageDescription)
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(palette.onSurface)
                            .lineLimit(1)
                    }
                    Text(task.status == .waitingApproval
                        ? "タップして内容を確認"
                        : "\(task.stage.japaneseName) · シャノンの作業を見る")
                        .font(.caption2)
                        .foregroundStyle(palette.onSurfaceVariant)
                }
                Spacer(minLength: 0)
                Image(systemName: "chevron.up")
                    .font(.caption.weight(.bold))
                    .foregroundStyle(palette.primary)
            }
            .padding(.horizontal, M3Spacing.medium)
            .frame(minHeight: 50)
            .background(.ultraThinMaterial, in: Capsule())
            .overlay { Capsule().stroke(palette.primary.opacity(0.28), lineWidth: 0.8) }
        }
        .buttonStyle(.plain)
        .padding(.horizontal, M3Spacing.large)
        .accessibilityLabel("シャノンの作業、\(task.title)、\(task.stage.japaneseName)。作業画面を開く")
    }
}
