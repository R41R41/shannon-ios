import SwiftUI

public struct ShannonConversationView: View {
    @State private var model: ShannonConversationModel
    @State private var connectionModel: ShannonConnectionModel?
    @State private var showsStateDetails = false
    @State private var showsConnectionDetails = false
    @FocusState private var composerIsFocused: Bool

    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    public init(
        model: ShannonConversationModel = ShannonConversationModel(),
        connectionModel: ShannonConnectionModel? = nil
    ) {
        _model = State(initialValue: model)
        _connectionModel = State(initialValue: connectionModel)
    }

    public var body: some View {
        let palette = M3Palette.resolve(colorScheme)

        NavigationStack {
            VStack(spacing: 0) {
                ShannonTopAppBar(
                    expression: model.currentExpression,
                    isThinking: model.isSending,
                    stateVersion: model.state?.version,
                    stateAction: { showsStateDetails = true },
                    connectionAction: connectionModel == nil ? nil : { showsConnectionDetails = true }
                )

                messageList(palette)

                if let errorMessage = model.errorMessage {
                    ShannonSnackbar(
                        message: errorMessage,
                        showsRetry: model.hasFailedMessage,
                        retry: { Task { await model.retryLastFailed() } },
                        dismiss: model.dismissError
                    )
                    .padding(.horizontal, M3Spacing.large)
                    .padding(.bottom, M3Spacing.small)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
                }

                composer(palette)
            }
            .background(palette.surface)
            .foregroundStyle(palette.onSurface)
            .animation(reduceMotion ? nil : .easeOut(duration: 0.22), value: model.errorMessage)
            .sheet(isPresented: $showsStateDetails) {
                ShannonStateSheet(state: model.state, expression: model.currentExpression)
            }
            .sheet(isPresented: $showsConnectionDetails) {
                if let connectionModel {
                    ShannonConnectionView(model: connectionModel)
                }
            }
            .task {
                connectionModel?.refreshFromKeychain()
                await model.loadConversationIfNeeded()
            }
        }
    }

    private func messageList(_ palette: M3Palette) -> some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(spacing: M3Spacing.large) {
                    if model.isLoadingHistory {
                        ProgressView("これまでの会話を思い出している…")
                            .tint(palette.primary)
                            .foregroundStyle(palette.onSurfaceVariant)
                            .padding(.top, 72)
                    } else if model.messages.isEmpty {
                        ShannonEmptyConversation()
                            .padding(.top, 56)
                    }

                    ForEach(model.messages) { message in
                        ShannonMessageRow(message: message)
                            .id(message.id)
                    }

                    if model.isSending {
                        ShannonTypingIndicator(expression: model.currentExpression)
                            .id("shannon-is-typing")
                    }

                    Color.clear.frame(height: 1).id("conversation-bottom")
                }
                .padding(.horizontal, M3Spacing.large)
                .padding(.vertical, M3Spacing.extraLarge)
            }
            .scrollIndicators(.hidden)
            .background(palette.surfaceContainerLow)
            .onChange(of: model.messages.count) {
                scrollToBottom(proxy)
            }
            .onChange(of: model.isSending) {
                scrollToBottom(proxy)
            }
        }
    }

    private func composer(_ palette: M3Palette) -> some View {
        HStack(alignment: .bottom, spacing: M3Spacing.small) {
            TextField("シャノンに話す", text: $model.draft, axis: .vertical)
                .font(.body)
                .lineLimit(1...5)
                .frame(minHeight: M3TouchTarget.minimum)
                .focused($composerIsFocused)
                .padding(.horizontal, M3Spacing.large)
                .padding(.vertical, 13)
                .background(
                    palette.surfaceContainerHigh,
                    in: RoundedRectangle(cornerRadius: M3Shape.extraLarge, style: .continuous)
                )
                .overlay {
                    RoundedRectangle(cornerRadius: M3Shape.extraLarge, style: .continuous)
                        .stroke(
                            composerIsFocused ? palette.primary : Color.clear,
                            lineWidth: composerIsFocused ? 2 : 0
                        )
                }
                .onSubmit { sendDraft() }
                .submitLabel(.send)
                .accessibilityHint("複数行入力できます")

            Button(action: sendDraft) {
                ZStack {
                    Circle()
                        .fill(model.canSendDraft ? palette.primary : palette.surfaceContainerHigh)
                    if model.isSending {
                        ProgressView()
                            .tint(palette.onSurfaceVariant)
                            .controlSize(.small)
                    } else {
                        Image(systemName: "arrow.up")
                            .font(.system(size: 19, weight: .bold))
                            .foregroundStyle(model.canSendDraft ? palette.onPrimary : palette.onSurfaceVariant)
                    }
                }
                .frame(width: M3TouchTarget.minimum, height: M3TouchTarget.minimum)
            }
            .buttonStyle(.plain)
            .disabled(!model.canSendDraft)
            .accessibilityLabel(model.isSending ? "送信中" : "送信")
        }
        .padding(.horizontal, M3Spacing.large)
        .padding(.vertical, M3Spacing.medium)
        .background(palette.surface)
        .overlay(alignment: .top) {
            Rectangle()
                .fill(palette.outlineVariant.opacity(0.7))
                .frame(height: 0.5)
        }
    }

    private func sendDraft() {
        guard model.canSendDraft else { return }
        Task { await model.sendDraft() }
    }

    private func scrollToBottom(_ proxy: ScrollViewProxy) {
        withAnimation(reduceMotion ? nil : .easeOut(duration: 0.25)) {
            proxy.scrollTo("conversation-bottom", anchor: .bottom)
        }
    }
}

private struct ShannonTopAppBar: View {
    let expression: ShannonExpressionDTO
    let isThinking: Bool
    let stateVersion: Int?
    let stateAction: () -> Void
    let connectionAction: (() -> Void)?

    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        let palette = M3Palette.resolve(colorScheme)

        HStack(spacing: M3Spacing.medium) {
            Button(action: stateAction) {
                HStack(spacing: M3Spacing.medium) {
                    ShannonAvatarView(expression: expression, size: 52)

                    VStack(alignment: .leading, spacing: 2) {
                        Text("シャノン")
                            .font(.title3.weight(.semibold))
                            .foregroundStyle(palette.onSurface)

                        HStack(spacing: 6) {
                            Circle()
                                .fill(isThinking ? palette.tertiary : Color(hex: 0x2E7D32))
                                .frame(width: 8, height: 8)
                            Text(isThinking ? "考えている…" : "ここにいる・\(expression.japaneseName)")
                                .font(.caption)
                                .foregroundStyle(palette.onSurfaceVariant)
                        }
                    }
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("シャノンの状態を見る。現在は\(expression.japaneseName)")

            Spacer(minLength: M3Spacing.small)

            if let stateVersion {
                Text("v\(stateVersion)")
                    .font(.caption2.monospacedDigit().weight(.medium))
                    .foregroundStyle(palette.onSecondaryContainer)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 6)
                    .background(palette.secondaryContainer, in: Capsule())
            }

            if let connectionAction {
                Button(action: connectionAction) {
                    Image(systemName: "link.circle")
                        .font(.system(size: 21, weight: .medium))
                        .foregroundStyle(palette.primary)
                        .frame(width: M3TouchTarget.minimum, height: M3TouchTarget.minimum)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("シャノンとの接続設定")
            } else {
                Image(systemName: "info.circle")
                    .font(.system(size: 20, weight: .medium))
                    .foregroundStyle(palette.primary)
                    .frame(width: M3TouchTarget.minimum, height: M3TouchTarget.minimum)
            }
        }
        .padding(.leading, M3Spacing.large)
        .padding(.trailing, M3Spacing.small)
        .padding(.vertical, M3Spacing.small)
        .background(palette.surface)
    }
}

private struct ShannonEmptyConversation: View {
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        let palette = M3Palette.resolve(colorScheme)

        VStack(spacing: M3Spacing.large) {
            ShannonAvatarView(expression: .curious, size: 88)
            VStack(spacing: M3Spacing.small) {
                Text("今日は、どんな日？")
                    .font(.title2.weight(.semibold))
                    .foregroundStyle(palette.onSurface)
                Text("まだ知らないことが多いから、\nあなたの言葉で少しずつ教えてほしい。")
                    .font(.body)
                    .multilineTextAlignment(.center)
                    .foregroundStyle(palette.onSurfaceVariant)
                    .lineSpacing(3)
            }
        }
        .frame(maxWidth: .infinity)
        .padding(M3Spacing.extraLarge)
        .accessibilityElement(children: .combine)
    }
}

private struct ShannonMessageRow: View {
    let message: ConversationMessage

    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        let palette = M3Palette.resolve(colorScheme)

        HStack(alignment: .bottom, spacing: M3Spacing.small) {
            if message.role == .shannon {
                ShannonAvatarView(
                    expression: message.emotionSnapshot?.expression ?? .neutral,
                    size: 48
                )
            } else {
                Spacer(minLength: 56)
            }

            VStack(alignment: message.role == .shannon ? .leading : .trailing, spacing: 5) {
                Text(message.text)
                    .font(.body)
                    .lineSpacing(3)
                    .textSelection(.enabled)
                    .foregroundStyle(message.role == .user ? palette.onPrimary : palette.onSurface)
                    .padding(.horizontal, M3Spacing.large)
                    .padding(.vertical, M3Spacing.medium)
                    .background(
                        message.role == .user ? palette.primary : palette.surfaceContainerHigh,
                        in: RoundedRectangle(cornerRadius: M3Shape.large, style: .continuous)
                    )

                HStack(spacing: 5) {
                    if let expression = message.emotionSnapshot?.expression {
                        Text(expression.japaneseName)
                    }
                    Text(message.sentAt.formatted(date: .omitted, time: .shortened))
                    if message.role == .user {
                        deliveryIcon(palette)
                    }
                }
                .font(.caption2)
                .foregroundStyle(message.deliveryState == .failed ? palette.error : palette.onSurfaceVariant)
                .padding(.horizontal, M3Spacing.extraSmall)
            }

            if message.role == .shannon {
                Spacer(minLength: 28)
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(accessibilityLabel)
    }

    @ViewBuilder
    private func deliveryIcon(_ palette: M3Palette) -> some View {
        switch message.deliveryState {
        case .sending:
            Image(systemName: "clock")
        case .sent:
            Image(systemName: "checkmark")
        case .failed:
            Image(systemName: "exclamationmark.circle.fill")
                .foregroundStyle(palette.error)
        }
    }

    private var accessibilityLabel: String {
        let speaker = message.role == .shannon ? "シャノン" : "あなた"
        let emotion = message.emotionSnapshot.map { "。\($0.expression.japaneseName)表情" } ?? ""
        let delivery = message.deliveryState == .failed ? "。送信失敗" : ""
        return "\(speaker)。\(message.text)\(emotion)\(delivery)"
    }
}

private struct ShannonTypingIndicator: View {
    let expression: ShannonExpressionDTO

    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        let palette = M3Palette.resolve(colorScheme)

        HStack(alignment: .bottom, spacing: M3Spacing.small) {
            ShannonAvatarView(expression: expression, size: 48)
            HStack(spacing: M3Spacing.small) {
                ProgressView()
                    .controlSize(.small)
                    .tint(palette.primary)
                Text("考えている…")
                    .font(.callout)
                    .foregroundStyle(palette.onSurfaceVariant)
            }
            .padding(.horizontal, M3Spacing.large)
            .frame(minHeight: M3TouchTarget.minimum)
            .background(palette.surfaceContainerHigh, in: Capsule())
            Spacer()
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("シャノンが考えています")
    }
}

private struct ShannonSnackbar: View {
    let message: String
    let showsRetry: Bool
    let retry: () -> Void
    let dismiss: () -> Void

    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        let palette = M3Palette.resolve(colorScheme)

        HStack(spacing: M3Spacing.small) {
            Image(systemName: "wifi.exclamationmark")
            Text(message)
                .font(.callout)
                .lineLimit(2)
            Spacer(minLength: M3Spacing.small)
            if showsRetry {
                Button("再送", action: retry)
                    .font(.labelStyle)
                    .foregroundStyle(palette.primaryContainer)
                    .frame(minHeight: M3TouchTarget.minimum)
            }
            Button(action: dismiss) {
                Image(systemName: "xmark")
                    .frame(width: M3TouchTarget.minimum, height: M3TouchTarget.minimum)
            }
            .accessibilityLabel("閉じる")
        }
        .foregroundStyle(palette.surface)
        .padding(.leading, M3Spacing.large)
        .padding(.trailing, M3Spacing.extraSmall)
        .background(palette.onSurface, in: RoundedRectangle(cornerRadius: M3Shape.small, style: .continuous))
        .shadow(color: .black.opacity(0.16), radius: 8, y: 3)
    }
}

private struct ShannonStateSheet: View {
    let state: CompanionStateDTO?
    let expression: ShannonExpressionDTO

    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        let palette = M3Palette.resolve(colorScheme)

        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: M3Spacing.extraLarge) {
                    HStack(spacing: M3Spacing.large) {
                        ShannonAvatarView(expression: expression, size: 72)
                        VStack(alignment: .leading, spacing: 4) {
                            Text(expression.japaneseName)
                                .font(.title2.weight(.semibold))
                            Text("シャノンのいま")
                                .font(.body)
                                .foregroundStyle(palette.onSurfaceVariant)
                        }
                    }

                    if let state {
                        VStack(spacing: M3Spacing.medium) {
                            StateMeter(label: "好奇心", value: state.temperament.curiosity, palette: palette)
                            StateMeter(label: "親密さ", value: state.temperament.closeness, palette: palette)
                            StateMeter(label: "活性", value: state.emotion.arousal, palette: palette)
                            StateMeter(label: "心の開き", value: state.emotion.openness, palette: palette)
                        }
                        .padding(M3Spacing.large)
                        .background(palette.surfaceContainer, in: RoundedRectangle(cornerRadius: M3Shape.extraLarge))

                        if !state.interests.isEmpty {
                            VStack(alignment: .leading, spacing: M3Spacing.medium) {
                                Text("いま興味があること")
                                    .font(.title3.weight(.semibold))
                                FlowLikeChips(values: state.interests, palette: palette)
                            }
                        }
                    } else {
                        Text("最初の会話のあとに、シャノンの状態がここに現れます。")
                            .font(.body)
                            .foregroundStyle(palette.onSurfaceVariant)
                            .padding(M3Spacing.large)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .background(palette.surfaceContainer, in: RoundedRectangle(cornerRadius: M3Shape.extraLarge))
                    }
                }
                .padding(M3Spacing.extraLarge)
            }
            .background(palette.surface)
            .navigationTitle("シャノンの状態")
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("閉じる") { dismiss() }
                }
            }
        }
        .presentationDetents([.medium, .large])
    }
}

private struct StateMeter: View {
    let label: String
    let value: Double
    let palette: M3Palette

    var body: some View {
        VStack(spacing: 6) {
            HStack {
                Text(label).font(.callout.weight(.medium))
                Spacer()
                Text(value.formatted(.percent.precision(.fractionLength(0))))
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(palette.onSurfaceVariant)
            }
            ProgressView(value: value)
                .tint(palette.primary)
        }
    }
}

private struct FlowLikeChips: View {
    let values: [String]
    let palette: M3Palette

    var body: some View {
        ScrollView(.horizontal) {
            HStack(spacing: M3Spacing.small) {
                ForEach(values, id: \.self) { value in
                    Text(value)
                        .font(.labelStyle)
                        .foregroundStyle(palette.onSecondaryContainer)
                        .padding(.horizontal, M3Spacing.medium)
                        .frame(minHeight: 40)
                        .background(palette.secondaryContainer, in: Capsule())
                }
            }
        }
        .scrollIndicators(.hidden)
    }
}

private extension Font {
    static var labelStyle: Font { .callout.weight(.semibold) }
}
