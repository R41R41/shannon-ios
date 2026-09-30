import SwiftUI

struct ShannonAgentTaskCardView: View {
    let task: ShannonAgentTask
    let cancel: () -> Void
    let open: () -> Void

    @Environment(\.colorScheme) var colorScheme

    var body: some View {
        let palette = ShannonPalette.resolve(colorScheme)

        VStack(alignment: .leading, spacing: ShannonSpacing.medium) {
            HStack(alignment: .firstTextBaseline, spacing: ShannonSpacing.small) {
                Text(task.title)
                    .font(.callout.weight(.semibold))
                    .foregroundStyle(palette.textPrimary)
                    .lineLimit(2)
                Spacer(minLength: ShannonSpacing.small)
                AgentTaskStatusBadge(task: task, palette: palette)
            }

            Text(task.summary)
                .font(.caption)
                .foregroundStyle(palette.textSecondary)
                .lineLimit(3)

            if let progress = task.progressFraction, !task.status.isTerminal {
                ProgressView(value: progress)
                    .tint(palette.action)
                    .accessibilityLabel("作業の進み具合")
                    .accessibilityValue("全\(task.plan.count)工程中\(task.completedPlanCount)工程完了")
            }

            switch task.status {
            case .proposed:
                ShannonButtonRow {
                    Button(action: open) { ShannonButtonLabel("設定して始める") }
                        .buttonStyle(.borderedProminent)
                        .controlSize(.large)
                    Button(action: cancel) { ShannonButtonLabel("今はやめる") }
                        .buttonStyle(.bordered)
                        .controlSize(.large)
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
                    .foregroundStyle(palette.action)
                    .frame(minHeight: 34)
                }
                .buttonStyle(.plain)
            }
        }
        .padding(ShannonSpacing.large)
        .background(
            palette.userMessage.opacity(colorScheme == .dark ? 0.34 : 0.48),
            in: RoundedRectangle(cornerRadius: ShannonShape.large, style: .continuous)
        )
        .overlay {
            RoundedRectangle(cornerRadius: ShannonShape.large, style: .continuous)
                .stroke(palette.action.opacity(0.26), lineWidth: 0.8)
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
    @Environment(\.dynamicTypeSize) var dynamicTypeSize

    var body: some View {
        let palette = ShannonPalette.resolve(colorScheme)

        Button(action: open) {
            HStack(spacing: ShannonSpacing.medium) {
                ShannonAvatarView(expression: task.expression, size: dynamicTypeSize.isAccessibilitySize ? 30 : 36)
                if dynamicTypeSize.isAccessibilitySize {
                    Text(task.status == .waitingApproval ? "許可が必要です" : task.stageDescription)
                        .font(.body.weight(.semibold))
                        .foregroundStyle(task.status == .waitingApproval ? palette.attention : palette.textPrimary)
                        .lineLimit(1)
                } else {
                    VStack(alignment: .leading, spacing: 2) {
                        if task.status == .waitingApproval {
                            Label("許可が必要です", systemImage: "hand.raised.fill")
                                .font(.caption.weight(.bold))
                                .foregroundStyle(palette.attention)
                                .lineLimit(1)
                        } else {
                            Text(task.stageDescription)
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(palette.textPrimary)
                                .lineLimit(1)
                        }
                        Text(task.status == .waitingApproval
                            ? "タップして内容を確認"
                            : "\(task.stage.japaneseName) · シャノンの作業を見る")
                            .font(.caption2)
                            .foregroundStyle(palette.textSecondary)
                    }
                }
                Spacer(minLength: 0)
                Image(systemName: "chevron.up")
                    .font(.caption.weight(.bold))
                    .foregroundStyle(palette.action)
            }
            .padding(.horizontal, ShannonSpacing.medium)
            .frame(minHeight: 50)
            .background(.ultraThinMaterial, in: Capsule())
            .overlay { Capsule().stroke(palette.action.opacity(0.28), lineWidth: 0.8) }
        }
        .buttonStyle(.plain)
        .padding(.horizontal, ShannonSpacing.large)
        .accessibilityLabel("シャノンの作業、\(task.title)、\(task.stage.japaneseName)。作業画面を開く")
    }
}
