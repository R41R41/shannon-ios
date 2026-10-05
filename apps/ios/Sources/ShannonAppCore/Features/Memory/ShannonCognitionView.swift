import SwiftUI

struct ShannonCognitionView: View {
    @Bindable var model: ShannonMemoryModel
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        let palette = ShannonPalette.resolve(colorScheme)
        List {
            if model.isLoading && model.cognition == .empty {
                ProgressView("目的を読み込み中…")
            }

            intentionSection(
                title: "継続中",
                emptyMessage: "継続中の目的はありません。会話で「目標は〜」と伝えると、ここに残ります。",
                intents: model.activeIntents,
                palette: palette
            )
            intentionSection(
                title: "一時停止",
                emptyMessage: "一時停止中の目的はありません。",
                intents: model.pausedIntents,
                palette: palette
            )
            intentionSection(
                title: "完了・取り下げ",
                emptyMessage: "完了または取り下げた目的はありません。",
                intents: model.closedIntents,
                palette: palette
            )

            Section("最近の認知履歴") {
                if model.cognition.recentCycles.isEmpty {
                    Text("まだ認知履歴はありません。会話すると、何を意識して応答したかがここに残ります。")
                        .foregroundStyle(palette.textSecondary)
                } else {
                    ForEach(model.cognition.recentCycles) { cycle in
                        ShannonCognitiveCycleRow(cycle: cycle, palette: palette)
                    }
                }
                Text("ここに表示するのは目的・想起・実行結果の要約です。非公開の思考過程は保存しません。")
                    .font(.shannon(.caption))
                    .foregroundStyle(palette.textSecondary)
            }

            if let error = model.cognitionErrorMessage {
                Section {
                    MemoryErrorCard(message: error, palette: palette) {
                        Task { await model.reload() }
                    }
                }
            }
        }
        .navigationTitle("目的と認知履歴")
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button { Task { await model.reload() } } label: {
                    Label("目的を更新", systemImage: "arrow.clockwise")
                }
                .disabled(model.isLoading || model.mutatingIntentID != nil)
            }
        }
        .task { await model.loadIfNeeded() }
        .refreshable { await model.reload() }
    }

    @ViewBuilder
    private func intentionSection(
        title: String,
        emptyMessage: String,
        intents: [ShannonCognitiveIntentDTO],
        palette: ShannonPalette
    ) -> some View {
        Section(title) {
            if intents.isEmpty {
                Text(emptyMessage)
                    .foregroundStyle(palette.textSecondary)
            } else {
                ForEach(intents) { intent in
                    ShannonCognitiveIntentRow(
                        intent: intent,
                        isUpdating: model.mutatingIntentID == intent.id,
                        palette: palette
                    ) { status in
                        Task { await model.updateIntent(intent, status: status) }
                    }
                    .accessibilityIdentifier("cognitive-intent-\(intent.id)")
                }
            }
        }
    }
}

struct ShannonCognitionManagementLabel: View {
    let cognition: ShannonCognitionDashboardDTO
    let isLoading: Bool
    let hasError: Bool
    let palette: ShannonPalette

    var body: some View {
        HStack(spacing: ShannonSpacing.medium) {
            Image(systemName: "target")
                .foregroundStyle(palette.brandPresence)
            VStack(alignment: .leading, spacing: ShannonSpacing.extraSmall) {
                Text("継続中の目的")
                    .font(.shannon(.headline))
                    .foregroundStyle(palette.textPrimary)
                Text(summary)
                    .font(.shannon(.caption))
                    .foregroundStyle(palette.textSecondary)
                Text("確認・一時停止・完了・再開")
                    .font(.shannon(.caption))
                    .foregroundStyle(palette.textSecondary)
            }
            Spacer(minLength: 0)
            Image(systemName: "chevron.right")
                .font(.shannon(.caption))
                .foregroundStyle(palette.textSecondary)
        }
        .padding(ShannonSpacing.large)
        .frame(maxWidth: .infinity, minHeight: ShannonTouchTarget.minimum, alignment: .leading)
        .background(palette.canvas, in: RoundedRectangle(cornerRadius: ShannonShape.large))
        .accessibilityElement(children: .combine)
    }

    private var summary: String {
        if isLoading && cognition == .empty { return "読み込み中…" }
        if hasError && cognition == .empty { return "読み込めませんでした。開いて再試行できます" }
        let active = cognition.intents.filter { $0.status == .active }.count
        let paused = cognition.intents.filter { $0.status == .paused }.count
        if active == 0 && paused == 0 { return "会話から目的を見つける準備ができています" }
        return "継続中 \(active)件・一時停止 \(paused)件"
    }
}

struct ShannonCognitiveIntentRow: View {
    let intent: ShannonCognitiveIntentDTO
    let isUpdating: Bool
    let palette: ShannonPalette
    var showsActionMenu = true
    let update: (ShannonCognitiveIntentStatusDTO) -> Void

    var body: some View {
        HStack(alignment: .top, spacing: ShannonSpacing.small) {
            VStack(alignment: .leading, spacing: ShannonSpacing.extraSmall) {
                Text(intent.title)
                    .font(.shannon(.body).weight(.semibold))
                    .foregroundStyle(palette.textPrimary)
                    .fixedSize(horizontal: false, vertical: true)
                if intent.desiredOutcome != intent.title {
                    Text(intent.desiredOutcome)
                        .font(.shannon(.callout))
                        .foregroundStyle(palette.textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Label(intent.status.japaneseName, systemImage: intent.status.symbolName)
                    .font(.shannon(.caption))
                    .foregroundStyle(statusColor)
                if let work = intent.verifiedWork {
                    verifiedWorkView(work)
                }
                if let nextStep = intent.nextStep, !nextStep.isEmpty {
                    VStack(alignment: .leading, spacing: ShannonSpacing.extraSmall) {
                        Label("次の一手", systemImage: "arrow.right.circle")
                            .font(.shannon(.caption).weight(.semibold))
                            .foregroundStyle(palette.action)
                        Text(nextStep)
                            .font(.shannon(.caption))
                            .foregroundStyle(palette.textSecondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                if let planSteps = intent.planSteps, !planSteps.isEmpty {
                    VStack(alignment: .leading, spacing: ShannonSpacing.extraSmall) {
                        Label("計画案", systemImage: "list.number")
                            .font(.shannon(.caption).weight(.semibold))
                            .foregroundStyle(palette.brandPresence)
                        ForEach(Array(planSteps.prefix(5).enumerated()), id: \.offset) { index, step in
                            HStack(alignment: .firstTextBaseline, spacing: ShannonSpacing.extraSmall) {
                                Text("\(index + 1)")
                                    .font(.shannon(.caption2).monospacedDigit().weight(.semibold))
                                    .foregroundStyle(palette.brandPresence)
                                    .frame(width: 18, height: 18)
                                    .background(palette.intelligenceSoft, in: Circle())
                                Text(step)
                                    .font(.shannon(.caption))
                                    .foregroundStyle(palette.textSecondary)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                        }
                        Text("計画は提案です。実行・完了は検証済みの記録で確認します。")
                            .font(.shannon(.caption2))
                            .foregroundStyle(palette.textSecondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                Text("更新 \(displayDate(intent.updatedAt))")
                    .font(.shannon(.caption2))
                    .foregroundStyle(palette.textSecondary)
            }
            Spacer(minLength: ShannonSpacing.small)
            if isUpdating {
                ProgressView()
                    .controlSize(.small)
                    .frame(width: ShannonTouchTarget.minimum, height: ShannonTouchTarget.minimum)
                    .accessibilityLabel("目的を更新中")
            } else if showsActionMenu {
                Menu {
                    actions
                } label: {
                    Image(systemName: "ellipsis.circle")
                        .frame(width: ShannonTouchTarget.minimum, height: ShannonTouchTarget.minimum)
                }
                .foregroundStyle(palette.action)
                .accessibilityLabel("\(intent.title)の状態を変更")
            } else {
                Image(systemName: "ellipsis.circle")
                    .frame(width: ShannonTouchTarget.minimum, height: ShannonTouchTarget.minimum)
                    .foregroundStyle(palette.action)
                    .accessibilityHidden(true)
            }
        }
        .frame(minHeight: ShannonTouchTarget.minimum, alignment: .leading)
        .accessibilityElement(children: .contain)
    }

    @ViewBuilder
    private func verifiedWorkView(_ work: ShannonVerifiedWorkDTO) -> some View {
        VStack(alignment: .leading, spacing: ShannonSpacing.extraSmall) {
            Label("検証済みの作業 · \(work.statusLabel)", systemImage: "checkmark.seal")
                .font(.shannon(.caption).weight(.semibold))
                .foregroundStyle(work.testsFailed > 0 ? palette.danger : palette.success)
            Text(work.title)
                .font(.shannon(.caption))
                .foregroundStyle(palette.textPrimary)
                .fixedSize(horizontal: false, vertical: true)
            if let currentAction = work.currentAction, !currentAction.isEmpty {
                Text("いま: \(currentAction)")
                    .font(.shannon(.caption2))
                    .foregroundStyle(palette.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if work.totalPlanSteps > 0 {
                GeometryReader { geometry in
                    ZStack(alignment: .leading) {
                        Capsule().fill(palette.success.opacity(0.16))
                        Capsule()
                            .fill(palette.success)
                            .frame(width: geometry.size.width * verifiedProgress(work))
                    }
                }
                .frame(height: 6)
                    .accessibilityLabel("検証済み作業の進捗")
                    .accessibilityValue("\(work.completedPlanSteps) / \(work.totalPlanSteps)")
                Text("計画 \(work.completedPlanSteps)/\(work.totalPlanSteps)・テスト成功 \(work.testsPassed)・失敗 \(work.testsFailed)")
                    .font(.shannon(.caption2).monospacedDigit())
                    .foregroundStyle(palette.textSecondary)
            }
            Text("Agent Hostの記録から同期。目的の完了は自動では確定しません。")
                .font(.shannon(.caption2))
                .foregroundStyle(palette.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.vertical, ShannonSpacing.extraSmall)
        .accessibilityElement(children: .combine)
    }

    private func verifiedProgress(_ work: ShannonVerifiedWorkDTO) -> Double {
        guard work.totalPlanSteps > 0 else { return 0 }
        return min(1, max(0, Double(work.completedPlanSteps) / Double(work.totalPlanSteps)))
    }

    @ViewBuilder
    private var actions: some View {
        if intent.status == .active {
            Button { update(.paused) } label: { Label("一時停止", systemImage: "pause.circle") }
        } else {
            Button { update(.active) } label: { Label("継続中に戻す", systemImage: "play.circle") }
        }
        if intent.status != .completed {
            Button { update(.completed) } label: { Label("完了にする", systemImage: "checkmark.circle") }
        }
        if intent.status != .dismissed {
            Button(role: .destructive) { update(.dismissed) } label: {
                Label("取り下げる", systemImage: "xmark.circle")
            }
        }
    }

    private var statusColor: Color {
        switch intent.status {
        case .active: palette.action
        case .paused: palette.attention
        case .completed: palette.success
        case .dismissed: palette.textSecondary
        }
    }
}

struct ShannonCognitiveCycleRow: View {
    let cycle: ShannonCognitiveCycleDTO
    let palette: ShannonPalette

    var body: some View {
        VStack(alignment: .leading, spacing: ShannonSpacing.extraSmall) {
            HStack(alignment: .firstTextBaseline) {
                Label(cycle.actionLabel, systemImage: cycle.outcome == "failed" ? "exclamationmark.circle" : "checkmark.circle")
                    .font(.shannon(.caption).weight(.semibold))
                    .foregroundStyle(cycle.outcome == "failed" ? palette.danger : palette.success)
                Spacer()
                Text(displayDate(cycle.occurredAt))
                    .font(.shannon(.caption2))
                    .foregroundStyle(palette.textSecondary)
            }
            Text(cycle.summary)
                .font(.shannon(.body))
                .foregroundStyle(palette.textPrimary)
                .fixedSize(horizontal: false, vertical: true)
            HStack(spacing: ShannonSpacing.small) {
                Label(cycle.channelLabel, systemImage: channelSymbol)
                if !cycle.recalledMemoryIDs.isEmpty {
                    Label("記憶 \(cycle.recalledMemoryIDs.count)件", systemImage: "brain")
                }
            }
            .font(.shannon(.caption))
            .foregroundStyle(palette.textSecondary)
        }
        .frame(minHeight: ShannonTouchTarget.minimum, alignment: .leading)
        .accessibilityElement(children: .combine)
    }

    private var channelSymbol: String {
        switch cycle.channel {
        case "voice": "waveform"
        case "discord": "bubble.left.and.bubble.right"
        case "vision": "camera"
        case "platform": "network"
        case "system": "gearshape"
        default: "text.bubble"
        }
    }
}
