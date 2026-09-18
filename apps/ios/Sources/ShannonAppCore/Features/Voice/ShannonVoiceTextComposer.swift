import SwiftUI

struct ShannonVoiceTextComposer: View {
    @Bindable var model: ShannonRealtimeVoiceSessionModel
    let palette: ShannonPalette

    @State private var textDraft = ""
    @FocusState private var isFocused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .bottom, spacing: ShannonSpacing.small) {
                TextField("音声会話へテキストを送る", text: $textDraft, axis: .vertical)
                    .lineLimit(1...4)
                    .textFieldStyle(.plain)
                    .focused($isFocused)
                    .submitLabel(.send)
                    .onSubmit(send)
                    .padding(.horizontal, ShannonSpacing.medium)
                    .padding(.vertical, 10)
                    .background(
                        palette.canvas.opacity(0.82),
                        in: RoundedRectangle(cornerRadius: ShannonShape.large, style: .continuous)
                    )
                    .overlay {
                        RoundedRectangle(cornerRadius: ShannonShape.large, style: .continuous)
                            .stroke(palette.divider.opacity(0.75), lineWidth: 0.7)
                    }
                    .accessibilityLabel("音声会話へのテキスト入力")

                Button(action: send) {
                    Group {
                        if model.isSendingText {
                            ProgressView()
                                .controlSize(.small)
                        } else {
                            Image(systemName: "arrow.up")
                                .font(.body.weight(.bold))
                        }
                    }
                    .frame(width: ShannonTouchTarget.minimum, height: ShannonTouchTarget.minimum)
                    .foregroundStyle(.white)
                    .background(palette.action, in: Circle())
                }
                .buttonStyle(.plain)
                .disabled(textDraft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !model.canSendText)
                .accessibilityLabel(model.isSendingText ? "送信中" : "テキストを送信")
            }

            ViewThatFits(in: .horizontal) {
                HStack(spacing: ShannonSpacing.small) {
                    statusLabels
                }
                VStack(alignment: .leading, spacing: 2) {
                    statusLabels
                }
            }
            .font(.caption)
            .foregroundStyle(palette.textSecondary)
        }
    }

    @ViewBuilder
    private var statusLabels: some View {
        Label(model.inputState.activeInputLabel, systemImage: "mic.fill")
        if let message = model.textSendErrorMessage {
            Text(message).foregroundStyle(palette.danger)
        }
    }

    private func send() {
        let content = textDraft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !content.isEmpty, model.canSendText else { return }
        Task { @MainActor in
            do {
                try await model.sendText(content)
                if textDraft.trimmingCharacters(in: .whitespacesAndNewlines) == content {
                    textDraft = ""
                }
            } catch {
                isFocused = true
            }
        }
    }
}
