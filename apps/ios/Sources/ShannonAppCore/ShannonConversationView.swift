import SwiftUI

public struct ShannonConversationView: View {
    @State private var model: ShannonConversationModel
    @State private var connectionModel: ShannonConnectionModel?
    @State private var memoryModel: ShannonMemoryModel
    @State private var showsStateDetails = false
    @State private var showsConnectionDetails = false
    @State private var selectedPage: ShannonWorkspacePage = .talk
    @FocusState private var composerIsFocused: Bool

    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    public init(
        model: ShannonConversationModel = ShannonConversationModel(),
        connectionModel: ShannonConnectionModel? = nil,
        memoryModel: ShannonMemoryModel = ShannonMemoryModel()
    ) {
        _model = State(initialValue: model)
        _connectionModel = State(initialValue: connectionModel)
        _memoryModel = State(initialValue: memoryModel)
    }

    public var body: some View {
        let palette = M3Palette.resolve(colorScheme)

        ZStack(alignment: .top) {
            workspacePages(palette)

            ShannonWorkspaceSwitcher(selection: $selectedPage)
                .padding(.top, M3Spacing.extraSmall)
        }
        .background(palette.surface)
        .foregroundStyle(palette.onSurface)
        .onChange(of: selectedPage) {
            composerIsFocused = false
            guard selectedPage == .memory else { return }
            Task { await memoryModel.reload() }
        }
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

    @ViewBuilder
    private func workspacePages(_ palette: M3Palette) -> some View {
#if os(iOS)
        TabView(selection: $selectedPage) {
            talkPage(palette).tag(ShannonWorkspacePage.talk)
            ShannonMemoryView(
                model: memoryModel,
                showsDismissButton: false,
                workspaceTopInset: ShannonWorkspaceChrome.contentTopInset
            )
                .tag(ShannonWorkspacePage.memory)
            settingsPage(palette).tag(ShannonWorkspacePage.settings)
        }
        .tabViewStyle(.page(indexDisplayMode: .never))
#else
        switch selectedPage {
        case .talk: talkPage(palette)
        case .memory:
            ShannonMemoryView(
                model: memoryModel,
                showsDismissButton: false,
                workspaceTopInset: ShannonWorkspaceChrome.contentTopInset
            )
        case .settings: settingsPage(palette)
        }
#endif
    }

    private func talkPage(_ palette: M3Palette) -> some View {
        VStack(spacing: 0) {
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
        .animation(reduceMotion ? nil : .easeOut(duration: 0.22), value: model.errorMessage)
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
                .padding(.top, ShannonWorkspaceChrome.contentTopInset)
                .padding(.bottom, M3Spacing.extraLarge)
            }
            .scrollIndicators(.hidden)
            .shannonKeyboardDismissMode()
            .background(palette.surfaceContainerLow)
            .contentShape(Rectangle())
            .simultaneousGesture(TapGesture().onEnded { composerIsFocused = false })
            .onChange(of: model.messages.count) {
                scrollToBottom(proxy)
            }
            .onChange(of: model.isSending) {
                scrollToBottom(proxy)
            }
        }
    }

    private func composer(_ palette: M3Palette) -> some View {
        HStack(alignment: .bottom, spacing: M3Spacing.extraSmall) {
            TextField("メッセージ", text: $model.draft, axis: .vertical)
                .font(.body)
                .lineLimit(1...5)
                .frame(minHeight: 40)
                .focused($composerIsFocused)
                .padding(.leading, M3Spacing.medium)
                .padding(.vertical, M3Spacing.small)
                .onSubmit { sendDraft() }
                .submitLabel(.send)
                .accessibilityHint("複数行入力できます")

            Button(action: sendDraft) {
                ZStack {
                    Circle()
                        .fill(model.canSendDraft ? palette.primary : palette.surface)
                    if model.isSending {
                        ProgressView()
                            .tint(palette.onSurfaceVariant)
                            .controlSize(.small)
                    } else {
                        Image(systemName: "arrow.up")
                            .font(.system(size: 17, weight: .bold))
                            .foregroundStyle(model.canSendDraft ? palette.onPrimary : palette.onSurfaceVariant)
                    }
                }
                .frame(width: 40, height: 40)
            }
            .frame(width: M3TouchTarget.minimum, height: M3TouchTarget.minimum)
            .buttonStyle(.plain)
            .disabled(!model.canSendDraft)
            .accessibilityLabel(model.isSending ? "送信中" : "送信")
        }
        .padding(M3Spacing.extraSmall)
        .background(palette.surfaceContainerHigh, in: RoundedRectangle(cornerRadius: M3Shape.extraLarge, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: M3Shape.extraLarge, style: .continuous)
                .stroke(composerIsFocused ? palette.primary : palette.outlineVariant, lineWidth: composerIsFocused ? 2 : 0.7)
        }
        .padding(.horizontal, M3Spacing.medium)
        .padding(.vertical, M3Spacing.small)
        .background(.ultraThinMaterial)
    }

    private func settingsPage(_ palette: M3Palette) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: M3Spacing.large) {
                Text("設定")
                    .font(.largeTitle.bold())
                    .padding(.horizontal, M3Spacing.extraSmall)

                Button { showsStateDetails = true } label: {
                    ShannonSettingsRow(
                        title: "シャノンの状態",
                        detail: model.state == nil
                            ? model.currentExpression.japaneseName
                            : "\(model.currentExpression.japaneseName)・v\(model.state?.version ?? 0)",
                        symbol: "waveform.path.ecg"
                    )
                }
                .buttonStyle(.plain)

                if let connectionModel {
                    Button { showsConnectionDetails = true } label: {
                        ShannonSettingsRow(
                            title: "接続",
                            detail: connectionModel.statusLabel,
                            symbol: "link"
                        )
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.horizontal, M3Spacing.large)
            .padding(.top, ShannonWorkspaceChrome.contentTopInset)
            .padding(.bottom, M3Spacing.huge)
        }
        .scrollIndicators(.hidden)
        .background(palette.surfaceContainerLow)
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

private enum ShannonWorkspacePage: Int, CaseIterable, Identifiable {
    case talk
    case memory
    case settings

    var id: Int { rawValue }
    var title: String {
        switch self {
        case .talk: "トーク"
        case .memory: "メモリー"
        case .settings: "設定"
        }
    }
    var symbol: String {
        switch self {
        case .talk: "bubble.left.and.bubble.right.fill"
        case .memory: "brain.head.profile.fill"
        case .settings: "gearshape.fill"
        }
    }
}

private enum ShannonWorkspaceChrome {
    static let contentTopInset: CGFloat = 72
}

private struct ShannonWorkspaceSwitcher: View {
    @Binding var selection: ShannonWorkspacePage
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        let palette = M3Palette.resolve(colorScheme)

        HStack(spacing: M3Spacing.small) {
            HStack(spacing: M3Spacing.extraSmall) {
                ForEach([ShannonWorkspacePage.talk, .memory]) { page in
                    workspaceButton(page, palette: palette)
                }
            }
            .frame(maxWidth: .infinity)
            .padding(M3Spacing.extraSmall)
            .background(.ultraThinMaterial, in: Capsule())
            .overlay {
                Capsule().stroke(palette.outlineVariant.opacity(0.65), lineWidth: 0.7)
            }

            Button {
                withAnimation(reduceMotion ? nil : .snappy(duration: 0.28)) { selection = .settings }
            } label: {
                Image(systemName: ShannonWorkspacePage.settings.symbol)
                    .font(.system(size: 18, weight: .semibold))
                    .foregroundStyle(selection == .settings ? palette.onPrimary : palette.onSurfaceVariant)
                    .frame(width: M3TouchTarget.minimum, height: M3TouchTarget.minimum)
                    .background(selection == .settings ? palette.primary : Color.clear, in: Circle())
            }
            .buttonStyle(.plain)
            .background(.ultraThinMaterial, in: Circle())
            .overlay {
                Circle().stroke(palette.outlineVariant.opacity(0.65), lineWidth: 0.7)
            }
            .accessibilityLabel("設定")
            .accessibilityAddTraits(selection == .settings ? .isSelected : [])
        }
        .padding(.horizontal, M3Spacing.large)
        .frame(maxWidth: .infinity)
    }

    private func workspaceButton(_ page: ShannonWorkspacePage, palette: M3Palette) -> some View {
        Button {
            withAnimation(reduceMotion ? nil : .snappy(duration: 0.28)) { selection = page }
        } label: {
            Label(page.title, systemImage: page.symbol)
                .font(.callout.weight(.semibold))
                .foregroundStyle(selection == page ? palette.onPrimary : palette.onSurfaceVariant)
                .frame(maxWidth: .infinity, minHeight: 40)
                .background(selection == page ? palette.primary : Color.clear, in: Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(selection == page ? .isSelected : [])
    }
}

private struct ShannonSettingsRow: View {
    let title: String
    let detail: String
    let symbol: String
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        let palette = M3Palette.resolve(colorScheme)

        HStack(spacing: M3Spacing.medium) {
            Image(systemName: symbol)
                .font(.system(size: 20, weight: .medium))
                .foregroundStyle(palette.primary)
                .frame(width: 44, height: 44)
                .background(palette.secondaryContainer, in: Circle())

            VStack(alignment: .leading, spacing: 3) {
                Text(title)
                    .font(.body.weight(.semibold))
                    .foregroundStyle(palette.onSurface)
                Text(detail)
                    .font(.caption)
                    .foregroundStyle(palette.onSurfaceVariant)
            }

            Spacer()
            Image(systemName: "chevron.right")
                .foregroundStyle(palette.onSurfaceVariant)
        }
        .padding(M3Spacing.large)
        .frame(maxWidth: .infinity, minHeight: 72, alignment: .leading)
        .background(palette.surface, in: RoundedRectangle(cornerRadius: M3Shape.large))
        .overlay {
            RoundedRectangle(cornerRadius: M3Shape.large)
                .stroke(palette.outlineVariant.opacity(0.7), lineWidth: 0.7)
        }
    }
}

private extension View {
    @ViewBuilder
    func shannonKeyboardDismissMode() -> some View {
#if os(iOS)
        scrollDismissesKeyboard(.interactively)
#else
        self
#endif
    }
}

private struct ShannonEmptyConversation: View {
    var body: some View {
        ShannonAvatarView(expression: .curious, size: 96)
            .frame(maxWidth: .infinity)
            .padding(M3Spacing.extraLarge)
            .accessibilityLabel("シャノン")
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
