import SwiftUI

struct ShannonAgentTaskOverviewProjection {
    let active: [ShannonAgentTask]
    let proposed: [ShannonAgentTask]
    let finished: [ShannonAgentTask]

    init(tasks: [ShannonAgentTask]) {
        let sorted = tasks.sorted { $0.updatedAt > $1.updatedAt }
        active = sorted.filter { $0.status.isActive }
        proposed = sorted.filter { $0.status == .proposed }
        finished = sorted.filter { $0.status.isTerminal }
    }
}

struct ShannonAgentTaskOverviewView: View {
    let model: ShannonConversationModel
    let openTask: (UUID) -> Void
    @Environment(\.colorScheme) var colorScheme

    var projection: ShannonAgentTaskOverviewProjection {
        ShannonAgentTaskOverviewProjection(tasks: model.agentTasks)
    }

    var body: some View {
        let palette = ShannonPalette.resolve(colorScheme)

        ScrollView {
            LazyVStack(alignment: .leading, spacing: ShannonSpacing.extraLarge) {
                VStack(alignment: .leading, spacing: ShannonSpacing.extraSmall) {
                    Text("作業全体")
                        .font(.largeTitle.bold())
                    Text("目指していること、現在地、次の一手をまとめて確認できます。")
                        .font(.callout)
                        .foregroundStyle(palette.textSecondary)
                }

                if model.agentTasks.isEmpty {
                    ContentUnavailableView(
                        "作業はありません",
                        systemImage: "checkmark.circle",
                        description: Text("会話でシャノンに作業を頼むと、ここに表示されます。")
                    )
                    .frame(maxWidth: .infinity, minHeight: 280)
                } else {
                    taskSection(
                        "いま",
                        detail: "進行・確認待ち・一時停止",
                        tasks: projection.active,
                        palette: palette
                    )
                    taskSection(
                        "これから",
                        detail: "開始するかはあなたが決めます",
                        tasks: projection.proposed,
                        palette: palette
                    )
                    taskSection(
                        "完了",
                        detail: "変更と検証結果",
                        tasks: projection.finished,
                        palette: palette
                    )
                }
            }
            .padding(.horizontal, ShannonSpacing.large)
            .padding(.top, ShannonWorkspaceChrome.contentTopInset + ShannonSpacing.large)
            .padding(.bottom, ShannonSpacing.huge)
        }
        .scrollIndicators(.hidden)
        .background(palette.canvas)
    }

    @ViewBuilder
    func taskSection(
        _ title: String,
        detail: String,
        tasks: [ShannonAgentTask],
        palette: ShannonPalette
    ) -> some View {
        if !tasks.isEmpty {
            VStack(alignment: .leading, spacing: ShannonSpacing.small) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(title).font(.title2.bold())
                    Text(detail).font(.caption).foregroundStyle(palette.textSecondary)
                }

                VStack(spacing: 0) {
                    ForEach(tasks) { task in
                        Button {
                            openTask(task.id)
                        } label: {
                            HStack(alignment: .top, spacing: ShannonSpacing.medium) {
                                Image(systemName: task.status.symbolName)
                                    .foregroundStyle(task.status == .waitingApproval ? palette.attention : palette.brandPresence)
                                    .frame(width: 24, height: 24)
                                VStack(alignment: .leading, spacing: 4) {
                                    HStack(alignment: .firstTextBaseline) {
                                        Text(task.title)
                                            .font(.headline)
                                            .foregroundStyle(palette.textPrimary)
                                            .lineLimit(2)
                                        Spacer(minLength: ShannonSpacing.small)
                                        Text(task.status.japaneseName)
                                            .font(.caption2.weight(.semibold))
                                            .foregroundStyle(palette.textSecondary)
                                    }
                                    Text(task.currentAction ?? task.summary)
                                        .font(.callout)
                                        .foregroundStyle(palette.textSecondary)
                                        .lineLimit(2)
                                    if let progress = task.progressFraction {
                                        ProgressView(value: progress)
                                            .tint(palette.action)
                                    }
                                }
                                Image(systemName: "chevron.right")
                                    .font(.caption.weight(.semibold))
                                    .foregroundStyle(palette.textSecondary)
                                    .padding(.top, 5)
                            }
                            .padding(ShannonSpacing.medium)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityHint("作業の詳細と操作を開きます")

                        if task.id != tasks.last?.id {
                            Divider().overlay(palette.divider.opacity(0.6))
                        }
                    }
                }
                .background(
                    palette.readingSurface,
                    in: RoundedRectangle(cornerRadius: ShannonShape.large, style: .continuous)
                )
                .overlay {
                    RoundedRectangle(cornerRadius: ShannonShape.large, style: .continuous)
                        .stroke(palette.divider.opacity(0.55), lineWidth: 0.7)
                }
            }
        }
    }
}
