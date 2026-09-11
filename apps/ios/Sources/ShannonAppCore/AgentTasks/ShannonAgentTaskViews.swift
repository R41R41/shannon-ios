import SwiftUI

struct ShannonAgentTaskCardView: View {
    let task: ShannonAgentTask
    let start: () -> Void
    let cancel: () -> Void
    let open: () -> Void

    @Environment(\.colorScheme) private var colorScheme

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

    @Environment(\.colorScheme) private var colorScheme

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

    @State private var steerText = ""
    @State private var showsCancelConfirmation = false
    @State private var showsDetailedProgress = false
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

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

    private func sendSteer() {
        let value = steerText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty else { return }
        steer(value)
        steerText = ""
    }
}

private struct AgentTaskRoomHeader: View {
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

private struct AgentTaskHero: View {
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

private struct AgentTaskSection<Content: View>: View {
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

private struct AgentTaskStageProgressView: View {
    let task: ShannonAgentTask
    let palette: M3Palette

    var body: some View {
        HStack(alignment: .top, spacing: 0) {
            ForEach(Array(task.stageProgress.enumerated()), id: \.element.id) { index, step in
                VStack(spacing: M3Spacing.small) {
                    Image(systemName: symbol(for: step.state))
                        .font(.caption.weight(.bold))
                        .foregroundStyle(color(for: step.state))
                        .frame(width: 28, height: 28)
                        .background(color(for: step.state).opacity(0.12), in: Circle())
                    Text(step.stage.japaneseName)
                        .font(.caption2.weight(step.state == .current ? .bold : .regular))
                        .foregroundStyle(step.state == .pending ? palette.onSurfaceVariant : palette.onSurface)
                        .lineLimit(1)
                }
                .frame(maxWidth: .infinity)

                if index < task.stageProgress.count - 1 {
                    Rectangle()
                        .fill(connectorColor(after: step.state))
                        .frame(height: 1)
                        .padding(.top, 14)
                        .frame(maxWidth: .infinity)
                }
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("シャノンの作業段階: \(task.stage.japaneseName)")
    }

    private func symbol(for state: ShannonAgentTaskStageState) -> String {
        switch state {
        case .pending: "circle"
        case .current: "circle.inset.filled"
        case .completed: "checkmark"
        }
    }

    private func color(for state: ShannonAgentTaskStageState) -> Color {
        switch state {
        case .pending: palette.outline
        case .current: palette.primary
        case .completed: palette.success
        }
    }

    private func connectorColor(after state: ShannonAgentTaskStageState) -> Color {
        state == .completed ? palette.success.opacity(0.65) : palette.outlineVariant
    }
}

private struct AgentTaskCommandActivityCard: View {
    let event: ShannonAgentTimelineEvent
    let palette: M3Palette

    private var activity: ShannonAgentTimelineActivity? { event.activity }

    var body: some View {
        guard let activity else { return AnyView(EmptyView()) }
        return AnyView(
            HStack(alignment: .top, spacing: M3Spacing.medium) {
                AgentTaskActivityIndicator(isActive: activity.status == .running, color: color(for: activity.status))
                    .padding(.top, 1)
                VStack(alignment: .leading, spacing: 3) {
                    Text(title(for: activity.status))
                        .font(.callout.weight(.semibold))
                        .foregroundStyle(palette.onSurface)
                    Text(event.title)
                        .font(.caption)
                        .foregroundStyle(palette.onSurfaceVariant)
                        .lineLimit(2)
                }
                Spacer(minLength: 0)
                Image(systemName: symbol(for: activity.status))
                    .foregroundStyle(color(for: activity.status))
                    .font(.body.weight(.semibold))
            }
            .padding(M3Spacing.medium)
            .background(color(for: activity.status).opacity(0.10), in: RoundedRectangle(cornerRadius: M3Shape.large))
            .overlay {
                RoundedRectangle(cornerRadius: M3Shape.large)
                    .stroke(color(for: activity.status).opacity(0.28), lineWidth: 0.8)
            }
            .accessibilityElement(children: .combine)
            .accessibilityLabel("シャノンが\(title(for: activity.status))。\(event.title)")
        )
    }

    private func title(for status: ShannonAgentTimelineActivityStatus) -> String {
        switch status {
        case .running: "コマンドを実行中"
        case .completed: "コマンドの実行が完了"
        case .failed: "コマンドで問題を検出"
        }
    }

    private func symbol(for status: ShannonAgentTimelineActivityStatus) -> String {
        switch status {
        case .running: "terminal"
        case .completed: "checkmark.circle.fill"
        case .failed: "exclamationmark.triangle.fill"
        }
    }

    private func color(for status: ShannonAgentTimelineActivityStatus) -> Color {
        switch status {
        case .running: palette.primary
        case .completed: palette.success
        case .failed: palette.error
        }
    }
}

private struct AgentTaskActivityIndicator: View {
    let isActive: Bool
    let color: Color

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var isPulsing = false

    var body: some View {
        ZStack {
            Circle()
                .fill(color.opacity(isPulsing ? 0.10 : 0.18))
                .frame(width: 22, height: 22)
            Circle()
                .fill(color)
                .frame(width: 9, height: 9)
        }
        .onAppear(perform: updatePulse)
        .onChange(of: isActive) { _, _ in updatePulse() }
        .onChange(of: reduceMotion) { _, _ in updatePulse() }
        .accessibilityHidden(true)
    }

    private func updatePulse() {
        guard isActive, !reduceMotion else {
            isPulsing = false
            return
        }
        isPulsing = false
        withAnimation(.easeInOut(duration: 1.1).repeatForever(autoreverses: true)) {
            isPulsing = true
        }
    }
}

private struct AgentTaskPlanRow: View {
    let item: ShannonAgentPlanItem
    let palette: M3Palette

    var body: some View {
        HStack(spacing: M3Spacing.medium) {
            Image(systemName: item.status.symbolName)
                .foregroundStyle(item.status == .pending ? palette.outline : palette.primary)
                .frame(width: 22)
            Text(item.title)
                .font(.body)
                .foregroundStyle(item.status == .pending ? palette.onSurfaceVariant : palette.onSurface)
            Spacer()
        }
        .frame(minHeight: M3TouchTarget.minimum)
        .accessibilityElement(children: .combine)
    }
}

private struct AgentTaskTimelineRow: View {
    let event: ShannonAgentTimelineEvent
    let showsConnector: Bool
    let palette: M3Palette

    var body: some View {
        HStack(alignment: .top, spacing: M3Spacing.medium) {
            ZStack(alignment: .top) {
                if showsConnector {
                    Rectangle()
                        .fill(palette.outlineVariant)
                        .frame(width: 1, height: 56)
                        .offset(y: 15)
                }
                Circle()
                    .fill(toneColor)
                    .frame(width: 12, height: 12)
                    .overlay { Circle().stroke(palette.surface, lineWidth: 3) }
                    .padding(.top, 5)
            }
            .frame(width: 16)

            VStack(alignment: .leading, spacing: 3) {
                HStack(alignment: .firstTextBaseline) {
                    Text(event.title).font(.body.weight(.medium))
                    Spacer()
                    Text(event.occurredAt.formatted(date: .omitted, time: .shortened))
                        .font(.caption2.monospacedDigit())
                        .foregroundStyle(palette.onSurfaceVariant)
                }
                if let detail = event.detail {
                    Text(detail)
                        .font(.caption)
                        .foregroundStyle(palette.onSurfaceVariant)
                }
            }
            .padding(.bottom, M3Spacing.large)
        }
        .accessibilityElement(children: .combine)
    }

    private var toneColor: Color {
        switch event.tone {
        case .neutral: palette.outline
        case .progress: palette.primary
        case .success: palette.success
        case .warning: palette.warning
        case .error: palette.error
        }
    }
}

private struct AgentTaskApprovalCard: View {
    let approval: ShannonAgentApproval
    let palette: M3Palette
    let isSubmitting: Bool
    let acceptOnce: () -> Void
    let acceptForSession: () -> Void
    let decline: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: M3Spacing.medium) {
            Label("判断が必要", systemImage: approval.kind.symbolName)
                .font(.caption.weight(.bold))
                .foregroundStyle(palette.warning)
            Text(approval.title).font(.headline)
            Text(approval.reason)
                .font(.callout)
                .foregroundStyle(palette.onSurfaceVariant)
            if let resource = approval.resource {
                Label(resource, systemImage: "lock.fill")
                    .font(.caption.monospaced())
                    .foregroundStyle(palette.onSurfaceVariant)
            }
            VStack(spacing: M3Spacing.small) {
                Button(action: acceptOnce) {
                    HStack(spacing: M3Spacing.small) {
                        if isSubmitting { ProgressView().controlSize(.small).tint(palette.onPrimary) }
                        Text(isSubmitting ? "送信中…" : "今回だけ許可")
                    }
                }
                    .buttonStyle(AgentTaskProminentButtonStyle(palette: palette))
                    .disabled(isSubmitting)
                HStack(spacing: M3Spacing.small) {
                    Button("この作業中", action: acceptForSession)
                        .buttonStyle(AgentTaskQuietButtonStyle(palette: palette))
                        .disabled(isSubmitting)
                    Button("許可しない", action: decline)
                        .buttonStyle(AgentTaskQuietButtonStyle(palette: palette))
                        .disabled(isSubmitting)
                }
            }
        }
        .padding(M3Spacing.large)
        .background(palette.surfaceContainerHigh, in: RoundedRectangle(cornerRadius: M3Shape.large))
        .overlay { RoundedRectangle(cornerRadius: M3Shape.large).stroke(palette.warning.opacity(0.35)) }
        .accessibilityElement(children: .contain)
    }
}

private struct AgentTaskActionErrorCard: View {
    let message: String
    let palette: M3Palette
    let dismiss: () -> Void

    var body: some View {
        HStack(alignment: .top, spacing: M3Spacing.medium) {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(palette.error)
            Text(message)
                .font(.callout)
                .foregroundStyle(palette.onErrorContainer)
                .frame(maxWidth: .infinity, alignment: .leading)
            Button(action: dismiss) {
                Image(systemName: "xmark")
                    .font(.caption.weight(.bold))
                    .frame(width: 28, height: 28)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("エラーを閉じる")
        }
        .padding(M3Spacing.medium)
        .background(palette.errorContainer, in: RoundedRectangle(cornerRadius: M3Shape.medium))
        .accessibilityElement(children: .combine)
    }
}

private struct AgentTaskResultSection: View {
    let task: ShannonAgentTask
    let palette: M3Palette

    var body: some View {
        VStack(alignment: .leading, spacing: M3Spacing.large) {
            if !task.changes.isEmpty {
                AgentTaskSection(title: "変更", symbol: "doc.badge.gearshape", palette: palette) {
                    VStack(spacing: M3Spacing.small) {
                        ForEach(task.changes) { change in
                            HStack(alignment: .top, spacing: M3Spacing.medium) {
                                Image(systemName: "doc.text")
                                    .foregroundStyle(palette.primary)
                                VStack(alignment: .leading, spacing: 3) {
                                    Text(change.displayName).font(.callout.weight(.semibold))
                                    Text(change.summary).font(.caption).foregroundStyle(palette.onSurfaceVariant)
                                }
                                Spacer()
                                Text("+\(change.additions) −\(change.deletions)")
                                    .font(.caption2.monospacedDigit())
                                    .foregroundStyle(palette.onSurfaceVariant)
                            }
                            .padding(M3Spacing.medium)
                            .background(palette.surfaceContainerLow, in: RoundedRectangle(cornerRadius: M3Shape.medium))
                        }
                    }
                }
            }

            if !task.tests.isEmpty {
                AgentTaskSection(title: "確認", symbol: "checkmark.seal", palette: palette) {
                    VStack(spacing: M3Spacing.small) {
                        ForEach(task.tests) { test in
                            HStack(spacing: M3Spacing.medium) {
                                Image(systemName: testSymbol(test.status))
                                    .foregroundStyle(test.status == .failed ? palette.error : palette.primary)
                                Text(test.name).font(.callout)
                                Spacer()
                                if let detail = test.detail {
                                    Text(detail).font(.caption).foregroundStyle(palette.onSurfaceVariant)
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    private func testSymbol(_ status: ShannonAgentTestStatus) -> String {
        switch status {
        case .pending: "circle.dotted"
        case .passed: "checkmark.circle.fill"
        case .failed: "xmark.circle.fill"
        }
    }
}

private struct AgentTaskControlBar: View {
    let task: ShannonAgentTask
    @Binding var text: String
    let palette: M3Palette
    let isBusy: Bool
    let send: () -> Void
    let togglePause: () -> Void
    let cancel: () -> Void

    var body: some View {
        HStack(alignment: .bottom, spacing: M3Spacing.small) {
            TextField("シャノンへの追加の指示", text: $text, axis: .vertical)
                .lineLimit(1...3)
                .padding(.horizontal, M3Spacing.medium)
                .frame(minHeight: 44)
                .background(palette.surfaceContainerHigh, in: RoundedRectangle(cornerRadius: M3Shape.extraLarge))
                .onSubmit(send)
                .submitLabel(.send)
                .disabled(isBusy)

            if text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                Button(action: togglePause) {
                    Image(systemName: task.status == .paused ? "play.fill" : "pause.fill")
                        .frame(width: 44, height: 44)
                        .background(palette.surfaceContainerHigh, in: Circle())
                }
                .buttonStyle(.plain)
                .disabled(isBusy || !task.status.isActive || task.status == .waitingApproval)
                .accessibilityLabel(task.status == .paused ? "作業を再開" : "作業を一時停止")

                Button(action: cancel) {
                    Image(systemName: "stop.fill")
                        .foregroundStyle(palette.error)
                        .frame(width: 44, height: 44)
                        .background(palette.errorContainer.opacity(0.5), in: Circle())
                }
                .buttonStyle(.plain)
                .disabled(isBusy)
                .accessibilityLabel("作業を中止")
            } else {
                Button(action: send) {
                    Image(systemName: "arrow.up")
                        .font(.body.weight(.bold))
                        .foregroundStyle(palette.onPrimary)
                        .frame(width: 44, height: 44)
                        .background(palette.primary, in: Circle())
                }
                .buttonStyle(.plain)
                .disabled(isBusy)
                .accessibilityLabel("シャノンへ追加の指示を送る")
            }
        }
        .padding(.horizontal, M3Spacing.medium)
        .padding(.vertical, M3Spacing.small)
        .background(.ultraThinMaterial)
    }
}

private struct AgentTaskStatusBadge: View {
    let task: ShannonAgentTask
    let palette: M3Palette

    var body: some View {
        Label(task.stage.japaneseName, systemImage: task.stage.symbolName)
            .font(.caption2.weight(.bold))
            .foregroundStyle(foreground)
            .padding(.horizontal, M3Spacing.small)
            .frame(minHeight: 25)
            .background(foreground.opacity(0.12), in: Capsule())
    }

    private var foreground: Color {
        switch task.stage {
        case .completion: palette.success
        case .failed: palette.error
        case .cancelled: palette.onSurfaceVariant
        case .review: palette.warning
        default: palette.primary
        }
    }
}

private struct AgentTaskProminentButtonStyle: ButtonStyle {
    let palette: M3Palette

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.callout.weight(.semibold))
            .foregroundStyle(palette.onPrimary)
            .frame(maxWidth: .infinity, minHeight: 42)
            .background(palette.primary.opacity(configuration.isPressed ? 0.74 : 1), in: Capsule())
    }
}

private struct AgentTaskQuietButtonStyle: ButtonStyle {
    let palette: M3Palette

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.callout.weight(.semibold))
            .foregroundStyle(palette.onSurface)
            .frame(maxWidth: .infinity, minHeight: 42)
            .background(palette.surface.opacity(configuration.isPressed ? 0.64 : 1), in: Capsule())
            .overlay { Capsule().stroke(palette.outlineVariant, lineWidth: 0.8) }
    }
}
