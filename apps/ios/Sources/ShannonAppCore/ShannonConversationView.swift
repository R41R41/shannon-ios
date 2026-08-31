import SwiftUI

public struct ShannonConversationView: View {
    @State private var model: ShannonConversationModel

    public init(model: ShannonConversationModel = ShannonConversationModel()) {
        _model = State(initialValue: model)
    }

    public var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                stateHeader
                Divider()
                messageList
                composer
            }
            .background(Color.secondary.opacity(0.06))
            .navigationTitle("Shannon")
        }
    }

    private var stateHeader: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Circle()
                    .fill(model.isSending ? Color.orange : Color.mint)
                    .frame(width: 10, height: 10)
                Text(model.isSending ? "考えている" : "ここにいる")
                    .font(.subheadline.weight(.semibold))
                Spacer()
                Text("state v\(model.state?.version ?? 0)")
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(.secondary)
            }

            if let state = model.state {
                HStack(spacing: 8) {
                    StateChip(label: "好奇心", value: state.temperament.curiosity)
                    StateChip(label: "親密さ", value: state.temperament.closeness)
                    StateChip(label: "活性", value: state.emotion.arousal)
                }
            } else {
                Text("最初の会話で、現在の状態を読み込みます。")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .padding()
        .background(.regularMaterial)
    }

    private var messageList: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(spacing: 12) {
                    if model.messages.isEmpty {
                        ContentUnavailableView(
                            "話しかけてみて",
                            systemImage: "sparkles",
                            description: Text("まだ何も知らないShannonとの最初の会話です。")
                        )
                        .padding(.top, 80)
                    }
                    ForEach(model.messages) { message in
                        MessageBubble(message: message)
                            .id(message.id)
                    }
                }
                .padding()
            }
            .onChange(of: model.messages.count) {
                guard let id = model.messages.last?.id else { return }
                withAnimation { proxy.scrollTo(id, anchor: .bottom) }
            }
        }
    }

    private var composer: some View {
        VStack(spacing: 7) {
            if let error = model.errorMessage {
                Text(error)
                    .font(.caption)
                    .foregroundStyle(.red)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            HStack(alignment: .bottom, spacing: 10) {
                TextField("Shannonに話す", text: $model.draft, axis: .vertical)
                    .textFieldStyle(.roundedBorder)
                    .lineLimit(1...5)
                    .onSubmit { Task { await model.sendDraft() } }
                Button {
                    Task { await model.sendDraft() }
                } label: {
                    Image(systemName: "arrow.up.circle.fill")
                        .font(.system(size: 31))
                }
                .disabled(model.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || model.isSending)
            }
        }
        .padding()
        .background(.regularMaterial)
    }
}

private struct StateChip: View {
    let label: String
    let value: Double

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label).font(.caption2).foregroundStyle(.secondary)
            ProgressView(value: value)
                .tint(.purple)
        }
        .padding(8)
        .frame(maxWidth: .infinity)
        .background(.quaternary, in: RoundedRectangle(cornerRadius: 10))
    }
}

private struct MessageBubble: View {
    let message: ConversationMessage

    var body: some View {
        HStack {
            if message.role == .user { Spacer(minLength: 48) }
            Text(message.text)
                .padding(.horizontal, 14)
                .padding(.vertical, 10)
                .foregroundStyle(message.role == .user ? Color.white : Color.primary)
                .background(
                    message.role == .user ? Color.purple : Color.secondary.opacity(0.12),
                    in: RoundedRectangle(cornerRadius: 17)
                )
            if message.role == .shannon { Spacer(minLength: 48) }
        }
    }
}
