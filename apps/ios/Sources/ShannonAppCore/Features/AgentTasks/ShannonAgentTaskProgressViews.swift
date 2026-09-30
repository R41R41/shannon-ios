import SwiftUI

struct AgentTaskStageProgressView: View {
    let task: ShannonAgentTask
    let palette: ShannonPalette

    var body: some View {
        HStack(alignment: .top, spacing: 0) {
            ForEach(Array(task.stageProgress.enumerated()), id: \.element.id) { index, step in
                VStack(spacing: ShannonSpacing.small) {
                    Image(systemName: symbol(for: step.state))
                        .font(.caption.weight(.bold))
                        .foregroundStyle(color(for: step.state))
                        .frame(width: 28, height: 28)
                        .background(color(for: step.state).opacity(0.12), in: Circle())
                    Text(step.stage.japaneseName)
                        .font(.caption2.weight(step.state == .current ? .bold : .regular))
                        .foregroundStyle(step.state == .pending ? palette.textSecondary : palette.textPrimary)
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

    func symbol(for state: ShannonAgentTaskStageState) -> String {
        switch state {
        case .pending: "circle"
        case .current: "circle.inset.filled"
        case .completed: "checkmark"
        }
    }

    func color(for state: ShannonAgentTaskStageState) -> Color {
        switch state {
        case .pending: palette.borderStrong
        case .current: palette.action
        case .completed: palette.success
        }
    }

    func connectorColor(after state: ShannonAgentTaskStageState) -> Color {
        state == .completed ? palette.success.opacity(0.65) : palette.divider
    }
}

struct AgentTaskCommandActivityCard: View {
    let event: ShannonAgentTimelineEvent
    let palette: ShannonPalette

    var activity: ShannonAgentTimelineActivity? { event.activity }

    var body: some View {
        guard let activity else { return AnyView(EmptyView()) }
        return AnyView(
            HStack(alignment: .top, spacing: ShannonSpacing.medium) {
                AgentTaskActivityIndicator(isActive: activity.status == .running, color: color(for: activity.status))
                    .padding(.top, 1)
                VStack(alignment: .leading, spacing: 3) {
                    Text(title(for: activity.status))
                        .font(.callout.weight(.semibold))
                        .foregroundStyle(palette.textPrimary)
                    Text(event.title)
                        .font(.caption)
                        .foregroundStyle(palette.textSecondary)
                        .lineLimit(2)
                }
                Spacer(minLength: 0)
                Image(systemName: symbol(for: activity.status))
                    .foregroundStyle(color(for: activity.status))
                    .font(.body.weight(.semibold))
            }
            .padding(ShannonSpacing.medium)
            .background(color(for: activity.status).opacity(0.10), in: RoundedRectangle(cornerRadius: ShannonShape.large))
            .overlay {
                RoundedRectangle(cornerRadius: ShannonShape.large)
                    .stroke(color(for: activity.status).opacity(0.28), lineWidth: 0.8)
            }
            .accessibilityElement(children: .combine)
            .accessibilityLabel("シャノンが\(title(for: activity.status))。\(event.title)")
        )
    }

    func title(for status: ShannonAgentTimelineActivityStatus) -> String {
        switch status {
        case .running: "コマンドを実行中"
        case .completed: "コマンドの実行が完了"
        case .failed: "コマンドで問題を検出"
        }
    }

    func symbol(for status: ShannonAgentTimelineActivityStatus) -> String {
        switch status {
        case .running: "terminal"
        case .completed: "checkmark.circle.fill"
        case .failed: "exclamationmark.triangle.fill"
        }
    }

    func color(for status: ShannonAgentTimelineActivityStatus) -> Color {
        switch status {
        case .running: palette.action
        case .completed: palette.success
        case .failed: palette.danger
        }
    }
}

struct AgentTaskActivityIndicator: View {
    let isActive: Bool
    let color: Color

    @Environment(\.accessibilityReduceMotion) var reduceMotion
    @State var isPulsing = false

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

    func updatePulse() {
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

struct AgentTaskTimelineRow: View {
    let event: ShannonAgentTimelineEvent
    let showsConnector: Bool
    let palette: ShannonPalette

    var body: some View {
        HStack(alignment: .top, spacing: ShannonSpacing.medium) {
            ZStack(alignment: .top) {
                if showsConnector {
                    Rectangle()
                        .fill(palette.divider)
                        .frame(width: 1, height: 56)
                        .offset(y: 15)
                }
                Circle()
                    .fill(toneColor)
                    .frame(width: 12, height: 12)
                    .overlay { Circle().stroke(palette.canvas, lineWidth: 3) }
                    .padding(.top, 5)
            }
            .frame(width: 16)

            VStack(alignment: .leading, spacing: 3) {
                HStack(alignment: .firstTextBaseline) {
                    Text(event.title).font(.body.weight(.medium))
                    Spacer()
                    Text(event.occurredAt.formatted(date: .omitted, time: .shortened))
                        .font(.caption2.monospacedDigit())
                        .foregroundStyle(palette.textSecondary)
                }
                if let detail = event.detail {
                    Text(detail)
                        .font(.caption)
                        .foregroundStyle(palette.textSecondary)
                }
            }
            .padding(.bottom, ShannonSpacing.large)
        }
        .accessibilityElement(children: .combine)
    }

    var toneColor: Color {
        switch event.tone {
        case .neutral: palette.borderStrong
        case .progress: palette.action
        case .success: palette.success
        case .warning: palette.attention
        case .error: palette.danger
        }
    }
}
