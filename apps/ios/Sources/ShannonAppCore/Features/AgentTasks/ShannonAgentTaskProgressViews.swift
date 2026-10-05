import SwiftUI

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
                        .font(.shannon(.callout).weight(.semibold))
                        .foregroundStyle(palette.textPrimary)
                    Text(event.title)
                        .font(.shannon(.caption))
                        .foregroundStyle(palette.textSecondary)
                        .lineLimit(2)
                }
                Spacer(minLength: 0)
                Image(systemName: symbol(for: activity.status))
                    .foregroundStyle(color(for: activity.status))
                    .font(.shannon(.body).weight(.semibold))
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
                    Text(event.title).font(.shannon(.body).weight(.medium))
                    Spacer()
                    Text(event.occurredAt.formatted(date: .omitted, time: .shortened))
                        .font(.shannon(.caption2).monospacedDigit())
                        .foregroundStyle(palette.textSecondary)
                }
                if let detail = event.detail {
                    Text(detail)
                        .font(.shannon(.caption))
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
