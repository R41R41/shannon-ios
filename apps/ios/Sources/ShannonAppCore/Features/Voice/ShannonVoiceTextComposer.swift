import SwiftUI

struct ShannonVoiceTextComposer: View {
    @Bindable var model: ShannonRealtimeVoiceSessionModel
    let palette: ShannonPalette
    let onDismiss: () -> Void

    @State private var textDraft = ""
    @FocusState private var isFocused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: ShannonSpacing.small) {
                TextField("メッセージ", text: $textDraft, axis: .vertical)
                    .lineLimit(1...3)
                    .textFieldStyle(.roundedBorder)
                    .focused($isFocused)
                    .submitLabel(.send)
                    .onSubmit(send)
                    .accessibilityLabel("音声会話へのテキスト入力")

                Button(action: send) {
                    if model.isSendingText {
                        ProgressView()
                            .controlSize(.small)
                            .frame(width: ShannonTouchTarget.minimum, height: ShannonTouchTarget.minimum)
                    } else {
                        Image(systemName: "arrow.up")
                            .font(.body.weight(.semibold))
                            .frame(width: ShannonTouchTarget.minimum, height: ShannonTouchTarget.minimum)
                    }
                }
                .buttonStyle(.borderedProminent)
                .buttonBorderShape(.circle)
                .tint(palette.action)
                .disabled(textDraft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !model.canSendText)
                .accessibilityLabel(model.isSendingText ? "送信中" : "テキストを送信")

                Button(action: dismissComposer) {
                    Image(systemName: "chevron.down")
                        .frame(width: ShannonTouchTarget.minimum, height: ShannonTouchTarget.minimum)
                }
                .buttonStyle(.bordered)
                .buttonBorderShape(.circle)
                .accessibilityLabel("テキスト入力を閉じる")
            }

            if let message = model.textSendErrorMessage {
                Text(message)
                    .font(.caption)
                    .foregroundStyle(palette.danger)
            }
        }
#if os(iOS)
        .toolbar {
            ToolbarItemGroup(placement: .keyboard) {
                Spacer()
                Button("完了", action: dismissComposer)
            }
        }
#endif
        .task {
            await Task.yield()
            isFocused = true
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
                dismissComposer()
            } catch {
                isFocused = true
            }
        }
    }

    private func dismissComposer() {
        isFocused = false
        onDismiss()
    }
}
