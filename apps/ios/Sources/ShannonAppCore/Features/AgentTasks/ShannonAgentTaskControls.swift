import SwiftUI

struct AgentTaskControlBar: View {
    let task: ShannonAgentTask
    @Binding var text: String
    let palette: ShannonPalette
    let isBusy: Bool
    let send: () -> Void
    let togglePause: () -> Void
    let cancel: () -> Void

    var body: some View {
        HStack(alignment: .bottom, spacing: ShannonSpacing.small) {
            TextField("シャノンへの追加の指示", text: $text, axis: .vertical)
                .lineLimit(1...3)
                .padding(.horizontal, ShannonSpacing.medium)
                .frame(minHeight: 44)
                .background(palette.elevatedSurface, in: RoundedRectangle(cornerRadius: ShannonShape.extraLarge))
                .onSubmit(send)
                .submitLabel(.send)
                .disabled(isBusy)

            if text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                Button(action: togglePause) {
                    Image(systemName: task.status == .paused ? "play.fill" : "pause.fill")
                        .frame(width: 44, height: 44)
                        .background(palette.elevatedSurface, in: Circle())
                }
                .buttonStyle(.plain)
                .disabled(isBusy || !task.status.isActive || task.status == .waitingApproval)
                .accessibilityLabel(task.status == .paused ? "作業を再開" : "作業を一時停止")

                Button(action: cancel) {
                    Image(systemName: "stop.fill")
                        .foregroundStyle(palette.danger)
                        .frame(width: 44, height: 44)
                        .background(palette.dangerTint.opacity(0.5), in: Circle())
                }
                .buttonStyle(.plain)
                .disabled(isBusy)
                .accessibilityLabel("作業を中止")
            } else {
                Button(action: send) {
                    Image(systemName: "arrow.up")
                        .font(.body.weight(.bold))
                        .foregroundStyle(palette.onAction)
                        .frame(width: 44, height: 44)
                        .background(palette.action, in: Circle())
                }
                .buttonStyle(.plain)
                .disabled(isBusy)
                .accessibilityLabel("シャノンへ追加の指示を送る")
            }
        }
        .padding(.horizontal, ShannonSpacing.medium)
        .padding(.vertical, ShannonSpacing.small)
        .background(.ultraThinMaterial)
    }
}

struct AgentTaskStatusBadge: View {
    let task: ShannonAgentTask
    let palette: ShannonPalette

    var body: some View {
        Label(task.stage.japaneseName, systemImage: task.stage.symbolName)
            .font(.caption2.weight(.bold))
            .foregroundStyle(foreground)
            .padding(.horizontal, ShannonSpacing.small)
            .frame(minHeight: 25)
            .background(foreground.opacity(0.12), in: Capsule())
    }

    var foreground: Color {
        switch task.stage {
        case .completion: palette.success
        case .failed: palette.danger
        case .cancelled: palette.textSecondary
        case .review: palette.attention
        default: palette.action
        }
    }
}

struct AgentTaskProminentButtonStyle: ButtonStyle {
    let palette: ShannonPalette

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.callout.weight(.semibold))
            .foregroundStyle(palette.onAction)
            .frame(maxWidth: .infinity, minHeight: 42)
            .background(palette.action.opacity(configuration.isPressed ? 0.74 : 1), in: Capsule())
    }
}

struct AgentTaskQuietButtonStyle: ButtonStyle {
    let palette: ShannonPalette

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.callout.weight(.semibold))
            .foregroundStyle(palette.textPrimary)
            .frame(maxWidth: .infinity, minHeight: 42)
            .background(palette.canvas.opacity(configuration.isPressed ? 0.64 : 1), in: Capsule())
            .overlay { Capsule().stroke(palette.divider, lineWidth: 0.8) }
    }
}
