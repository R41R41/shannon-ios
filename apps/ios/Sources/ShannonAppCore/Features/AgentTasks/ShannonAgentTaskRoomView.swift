import SwiftUI

struct ShannonAgentTaskRoomView: View {
    let task: ShannonAgentTask
    let actionIsInFlight: Bool
    let actionError: String?
    let dismiss: () -> Void
    let dismissActionError: () -> Void
    let steer: (String) -> Void
    let togglePause: () -> Void
    let cancel: () -> Void
    let resolveApproval: (Bool, Bool) -> Void
    let advancePreview: (() -> Void)?

    @State var steerText = ""
    @State var showsCancelConfirmation = false
    @State var showsDetailedProgress = false
    @Environment(\.colorScheme) var colorScheme
    @Environment(\.accessibilityReduceMotion) var reduceMotion

    var body: some View {
        let palette = M3Palette.resolve(colorScheme)

        ZStack {
            palette.surface.ignoresSafeArea()
            ScrollView {
                LazyVStack(alignment: .leading, spacing: M3Spacing.extraLarge) {
                    AgentTaskHero(task: task, palette: palette)

                    if let actionError {
                        AgentTaskActionErrorCard(
                            message: actionError,
                            palette: palette,
                            dismiss: dismissActionError
                        )
                    }

                    AgentTaskSection(title: "シャノンの作業段階", symbol: "point.3.connected.trianglepath.dotted", palette: palette) {
                        AgentTaskStageProgressView(task: task, palette: palette)
                    }

                    if let command = task.latestCommandActivity {
                        AgentTaskCommandActivityCard(event: command, palette: palette)
                    }

                    if !task.plan.isEmpty || !task.timeline.isEmpty {
                        DisclosureGroup(isExpanded: $showsDetailedProgress) {
                            VStack(alignment: .leading, spacing: M3Spacing.large) {
                                if !task.plan.isEmpty {
                                    AgentTaskSection(title: "計画の詳細", symbol: "list.bullet.clipboard", palette: palette) {
                                        VStack(spacing: 0) {
                                            ForEach(task.plan) { item in
                                                AgentTaskPlanRow(item: item, palette: palette)
                                            }
                                        }
                                    }
                                }

                                if !task.timeline.isEmpty {
                                    AgentTaskSection(title: "作業記録", symbol: "clock.arrow.circlepath", palette: palette) {
                                        VStack(spacing: 0) {
                                            let sortedEvents = task.timeline.sorted(by: { $0.sequence < $1.sequence })
                                            ForEach(sortedEvents) { event in
                                                AgentTaskTimelineRow(
                                                    event: event,
                                                    showsConnector: event.id != sortedEvents.last?.id,
                                                    palette: palette
                                                )
                                            }
                                        }
                                    }
                                }
                            }
                            .padding(.top, M3Spacing.medium)
                        } label: {
                            Label("細かな作業記録を表示", systemImage: "list.bullet")
                                .font(.callout.weight(.semibold))
                                .foregroundStyle(palette.onSurfaceVariant)
                        }
                        .tint(palette.primary)
                    }

                    if let approval = task.pendingApproval {
                        AgentTaskApprovalCard(
                            approval: approval,
                            palette: palette,
                            isSubmitting: actionIsInFlight,
                            acceptOnce: { resolveApproval(true, false) },
                            acceptForSession: { resolveApproval(true, true) },
                            decline: { resolveApproval(false, false) }
                        )
                    }

                    if !task.changes.isEmpty || !task.tests.isEmpty {
                        AgentTaskResultSection(task: task, palette: palette)
                    }
                }
                .padding(.horizontal, M3Spacing.large)
                .padding(.top, M3Spacing.medium)
                .padding(.bottom, task.status.isActive ? 122 : M3Spacing.huge)
            }
            .scrollIndicators(.hidden)
        }
        .safeAreaInset(edge: .top, spacing: 0) {
            AgentTaskRoomHeader(
                task: task,
                palette: palette,
                dismiss: dismiss,
                advancePreview: advancePreview
            )
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            if task.status.isActive {
                AgentTaskControlBar(
                    task: task,
                    text: $steerText,
                    palette: palette,
                    isBusy: actionIsInFlight,
                    send: sendSteer,
                    togglePause: togglePause,
                    cancel: { showsCancelConfirmation = true }
                )
            }
        }
        .confirmationDialog("シャノンの作業を中止しますか？", isPresented: $showsCancelConfirmation, titleVisibility: .visible) {
            Button("シャノンの作業を中止", role: .destructive) {
                cancel()
                dismiss()
            }
            Button("戻る", role: .cancel) {}
        } message: {
            Text("シャノンが完了した工程は残りますが、自動では再開しません。")
        }
        .animation(reduceMotion ? nil : .easeOut(duration: 0.22), value: task.status)
    }

    func sendSteer() {
        let value = steerText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty else { return }
        steer(value)
        steerText = ""
    }
}

struct AgentTaskRoomHeader: View {
    let task: ShannonAgentTask
    let palette: M3Palette
    let dismiss: () -> Void
    let advancePreview: (() -> Void)?

    var body: some View {
        HStack(spacing: M3Spacing.small) {
            Button(action: dismiss) {
                Image(systemName: "chevron.left")
                    .font(.body.weight(.semibold))
                    .frame(width: M3TouchTarget.minimum, height: M3TouchTarget.minimum)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("トークへ戻る")

            VStack(alignment: .leading, spacing: 2) {
                Text(task.title)
                    .font(.callout.weight(.semibold))
                    .lineLimit(1)
                Text(task.stage.japaneseName)
                    .font(.caption2)
                    .foregroundStyle(palette.onSurfaceVariant)
            }
            Spacer()

            if let advancePreview {
                Button(action: advancePreview) {
                    Image(systemName: "forward.frame.fill")
                        .frame(width: M3TouchTarget.minimum, height: M3TouchTarget.minimum)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("開発プレビューを次の状態へ進める")
            }
        }
        .padding(.horizontal, M3Spacing.small)
        .background(.ultraThinMaterial)
    }
}

struct AgentTaskHero: View {
    let task: ShannonAgentTask
    let palette: M3Palette

    var body: some View {
        HStack(alignment: .center, spacing: M3Spacing.large) {
            ShannonAvatarView(expression: task.expression, size: 68)
            VStack(alignment: .leading, spacing: M3Spacing.small) {
                Text(task.stageDescription)
                    .font(.title3.weight(.semibold))
                    .foregroundStyle(palette.onSurface)
                Text(task.summary)
                    .font(.caption)
                    .foregroundStyle(palette.onSurfaceVariant)
                    .lineLimit(3)
                AgentTaskStatusBadge(task: task, palette: palette)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(M3Spacing.large)
        .background(
            LinearGradient(
                colors: [palette.intelligenceSoft.opacity(0.72), palette.surfaceContainerLow],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            ),
            in: RoundedRectangle(cornerRadius: M3Shape.extraLarge, style: .continuous)
        )
    }
}

struct AgentTaskSection<Content: View>: View {
    let title: String
    let symbol: String
    let palette: M3Palette
    let content: Content

    init(title: String, symbol: String, palette: M3Palette, @ViewBuilder content: () -> Content) {
        self.title = title
        self.symbol = symbol
        self.palette = palette
        self.content = content()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: M3Spacing.medium) {
            Label(title, systemImage: symbol)
                .font(.headline)
                .foregroundStyle(palette.onSurface)
            content
        }
    }
}
