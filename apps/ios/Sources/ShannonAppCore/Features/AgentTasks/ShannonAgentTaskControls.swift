import SwiftUI

struct AgentTaskControlBar: View {
    @Binding var text: String
    let palette: ShannonPalette
    let isBusy: Bool
    let send: () -> Void

    var body: some View {
        HStack(alignment: .bottom, spacing: ShannonSpacing.small) {
            TextField("シャノンへの追加の指示", text: $text, axis: .vertical)
                .lineLimit(1...3)
                .frame(minHeight: 44)
                .textFieldStyle(.roundedBorder)
                .onSubmit(send)
                .submitLabel(.send)
                .disabled(isBusy)

            Button(action: send) {
                Image(systemName: "arrow.up")
                    .font(.body.weight(.bold))
                    .frame(width: 44, height: 44)
            }
            .buttonStyle(.borderedProminent)
            .buttonBorderShape(.circle)
            .disabled(isBusy || text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            .accessibilityLabel("シャノンへ追加の指示を送る")
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
