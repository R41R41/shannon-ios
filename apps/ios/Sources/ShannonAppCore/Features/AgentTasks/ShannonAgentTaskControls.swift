import SwiftUI

/// Steering input placed with `safeAreaInset(edge: .bottom)`.
///
/// Matches the Talk composer's look (material rounded field, hairline border
/// that strengthens on focus, circular send button at the trailing edge)
/// without sharing its implementation, which also owns attachments and voice.
struct AgentTaskControlBar: View {
    @Binding var text: String
    let palette: ShannonPalette
    let isBusy: Bool
    let send: () -> Void

    @FocusState private var isFocused: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var hasText: Bool {
        !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private var canSend: Bool { !isBusy && hasText }

    private var isExpanded: Bool { isFocused || hasText }

    private var shape: RoundedRectangle {
        RoundedRectangle(cornerRadius: isExpanded ? 24 : ShannonShape.extraLarge, style: .continuous)
    }

    var body: some View {
        HStack(alignment: .bottom, spacing: ShannonSpacing.extraSmall) {
            TextField("シャノンへの追加の指示", text: $text, axis: .vertical)
                .font(.shannon(.body))
                .lineLimit(1...4)
                .padding(.horizontal, 10)
                .frame(minHeight: ShannonTouchTarget.minimum)
                .focused($isFocused)
                .onSubmit(send)
                .submitLabel(.send)
                .disabled(isBusy)
                .accessibilityHint("複数行入力できます")

            Button(action: send) {
                ZStack {
                    Circle()
                        .fill(canSend ? palette.action : palette.subtleSurface)
                    if isBusy {
                        ProgressView()
                            .tint(palette.textSecondary)
                            .controlSize(.small)
                    } else {
                        Image(systemName: "arrow.up")
                            .font(.system(size: 17, weight: .bold))
                            .foregroundStyle(canSend ? palette.onAction : palette.textSecondary)
                    }
                }
                .frame(width: 40, height: 40)
            }
            .frame(width: ShannonTouchTarget.minimum, height: ShannonTouchTarget.minimum)
            .buttonStyle(.plain)
            .disabled(!canSend)
            .accessibilityLabel("シャノンへ追加の指示を送る")
        }
        .padding(6)
        .background(.regularMaterial, in: shape)
        .overlay {
            shape.stroke(palette.divider.opacity(isFocused ? 0.95 : 0.62), lineWidth: isFocused ? 1.2 : 0.7)
        }
        .padding(.horizontal, ShannonSpacing.medium)
        .padding(.vertical, ShannonSpacing.small)
        .animation(reduceMotion ? nil : .easeOut(duration: 0.18), value: isExpanded)
    }
}

struct AgentTaskStatusBadge: View {
    let task: ShannonAgentTask
    let palette: ShannonPalette

    var body: some View {
        Label(task.stateName, systemImage: task.needsOwnerToContinue ? task.stateSymbolName : task.stage.symbolName)
            .font(.shannon(.caption2).weight(.bold))
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
        case .paused: task.needsOwnerToContinue ? palette.attention : palette.action
        default: palette.action
        }
    }
}
