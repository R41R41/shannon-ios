import SwiftUI

struct AgentTaskControlBar: View {
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

struct AgentTaskStatusBadge: View {
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

    var foreground: Color {
        switch task.stage {
        case .completion: palette.success
        case .failed: palette.error
        case .cancelled: palette.onSurfaceVariant
        case .review: palette.warning
        default: palette.primary
        }
    }
}

struct AgentTaskProminentButtonStyle: ButtonStyle {
    let palette: M3Palette

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.callout.weight(.semibold))
            .foregroundStyle(palette.onPrimary)
            .frame(maxWidth: .infinity, minHeight: 42)
            .background(palette.primary.opacity(configuration.isPressed ? 0.74 : 1), in: Capsule())
    }
}

struct AgentTaskQuietButtonStyle: ButtonStyle {
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
