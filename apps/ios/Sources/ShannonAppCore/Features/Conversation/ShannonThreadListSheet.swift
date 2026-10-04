import SwiftUI
#if canImport(UIKit)
import UIKit
#elseif canImport(AppKit)
import AppKit
#endif

/// iPhone conversation list: search on top, the three entries 作業／シャノン／設定
/// (the fourth, トーク, is this list itself), then threads grouped by date.
struct ShannonThreadListSheet: View {
    let model: ShannonConversationModel
    /// What the 「シャノン」 tile counts and the 「設定」 tile marks.
    let yousu: ShannonYousuModel
    let selectedThreadId: String?
    let openTalk: () -> Void
    let openWork: () -> Void
    let openShannon: () -> Void
    let openSettings: () -> Void
    let openAgentTask: (UUID) -> Void
    let close: () -> Void

    @Environment(\.colorScheme) var colorScheme
    @Environment(\.dynamicTypeSize) var dynamicTypeSize
    @Environment(\.accessibilityReduceMotion) var reduceMotion
    @State var isCreating = false
    @State var editingThread: ChatThreadDTO?
    @State var searchText = ""

    var isSearching: Bool {
        !searchText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    var visibleThreads: [ChatThreadDTO] {
        ShannonThreadSearch.matches(model.threads, query: searchText)
    }

    var initiativeThreads: [ChatThreadDTO] {
        guard !isSearching else { return [] }
        return visibleThreads.filter { model.initiativeThreadIDs.contains($0.threadId) }
    }

    var conversationThreads: [ChatThreadDTO] {
        guard !isSearching else { return visibleThreads }
        return visibleThreads.filter { !model.initiativeThreadIDs.contains($0.threadId) }
    }

    var destinations: [ShannonThreadListDestination] {
        [
            ShannonThreadListDestination(
                title: ShannonGeneratedStrings.navWork,
                symbol: "point.3.connected.trianglepath.dotted",
                badge: model.unreadAgentTaskCount,
                action: openWork
            ),
            ShannonThreadListDestination(
                title: ShannonGeneratedStrings.navShannon, symbol: "person.crop.circle",
                badge: yousu.now.waitingItems.count, attention: yousu.needsAttention, action: openShannon
            ),
            settingsDestination,
        ]
    }

    var body: some View {
        let palette = ShannonPalette.resolve(colorScheme)
        let now = Date()
        let calendar = Calendar.current

        NavigationStack {
            List {
                if !isSearching {
                    destinationsSection(palette: palette)
                }

                if visibleThreads.isEmpty {
                    Group {
                        if isSearching {
                            ContentUnavailableView.search(text: searchText)
                        } else {
                            ContentUnavailableView(
                                "トークはありません",
                                systemImage: "bubble.left.and.bubble.right",
                                description: Text("右上のボタンから新しいトークを始められます。")
                            )
                        }
                    }
                        .frame(maxWidth: .infinity, minHeight: 220)
                        .listRowBackground(Color.clear)
                } else if isSearching {
                    Section("検索結果") {
                        ForEach(conversationThreads, id: \.threadId) { thread in
                            threadRow(thread, now: now, calendar: calendar, palette: palette)
                        }
                    }
                } else {
                    if !initiativeThreads.isEmpty {
                        Section {
                            ForEach(initiativeThreads, id: \.threadId) { thread in
                                threadRow(thread, now: now, calendar: calendar, palette: palette)
                            }
                        } header: {
                            Label("シャノンから", systemImage: "sparkles")
                        }
                    }

                    ForEach(ShannonThreadDateGrouping.sections(
                        for: conversationThreads,
                        now: now,
                        calendar: calendar
                    )) { section in
                        Section(section.title) {
                            ForEach(section.threads, id: \.threadId) { thread in
                                threadRow(thread, now: now, calendar: calendar, palette: palette)
                            }
                        }
                    }
                }
            }
            .searchable(text: $searchText, placement: Self.searchPlacement, prompt: "トークを検索")
            // One read when the list opens, so the tiles can carry their count and mark; no polling here.
            .task {
                async let ops: Void = yousu.ops.refresh()
                async let now: Void = yousu.now.reload()
                _ = await (ops, now)
            }
            .navigationTitle("シャノン")
#if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
#endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("閉じる", action: close)
                }
                ToolbarItem(placement: .primaryAction) {
                    Button {
                        Task {
                            isCreating = true
                            defer { isCreating = false }
                            await model.createThread(title: nil)
                            openTalk()
                        }
                    } label: {
                        if isCreating {
                            ProgressView()
                        } else {
                            Image(systemName: "square.and.pencil")
                        }
                    }
                    .disabled(isCreating)
                    .accessibilityLabel(isCreating ? "新しいトークを作成中" : "新しいトーク")
                }
            }
        }
        .sheet(isPresented: Binding(
            get: { editingThread != nil },
            set: { if !$0 { editingThread = nil } }
        )) {
            if let editingThread {
                ShannonThreadTitleEditor(
                    initialTitle: editingThread.title,
                    save: { title in
                        await model.renameThread(editingThread.threadId, title: title)
                    },
                    cancel: { self.editingThread = nil }
                )
            }
        }
    }

    /// Three equal tiles; accessibility text sizes fall back to full-width native rows.
    @ViewBuilder
    func destinationsSection(palette: ShannonPalette) -> some View {
        if dynamicTypeSize.isAccessibilitySize {
            Section {
                ForEach(destinations) { destination in
                    Button(action: destination.action) {
                        ShannonDrawerDestinationRow(
                            title: destination.title,
                            detail: nil,
                            symbol: destination.symbol,
                            badge: destination.badge,
                            attention: destination.attention,
                            palette: palette
                        )
                    }
                    .buttonStyle(.plain)
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel(destination.accessibilityLabel)
                    .accessibilityAddTraits(.isButton)
                }
            }
        } else {
            Section {
                HStack(spacing: ShannonSpacing.small) {
                    ForEach(destinations) { destination in
                        Button(action: destination.action) {
                            ShannonThreadListDestinationTile(destination: destination, palette: palette)
                        }
                        .buttonStyle(ShannonChipPressStyle(reduceMotion: reduceMotion))
                        .accessibilityElement(children: .ignore)
                        .accessibilityLabel(destination.accessibilityLabel)
                        .accessibilityAddTraits(.isButton)
                    }
                }
                .listRowInsets(EdgeInsets())
                .listRowBackground(Color.clear)
                .listRowSeparator(.hidden)
            }
        }
    }

    func threadRow(
        _ thread: ChatThreadDTO,
        now: Date,
        calendar: Calendar,
        palette: ShannonPalette
    ) -> some View {
        let isCurrent = thread.threadId == selectedThreadId
        return Button {
            Task {
                await model.selectThread(thread.threadId)
                openTalk()
            }
        } label: {
            ShannonThreadListRow(
                title: thread.title,
                timeLabel: ShannonThreadDateGrouping.relativeLabel(
                    for: ShannonThreadDateGrouping.date(from: thread.updatedAt),
                    now: now,
                    calendar: calendar
                ),
                detail: detailText(for: thread),
                isCurrent: isCurrent,
                isInitiative: model.initiativeThreadIDs.contains(thread.threadId),
                palette: palette
            )
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(isCurrent ? .isSelected : [])
        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
            if canArchive {
                Button {
                    Task { await model.archiveThread(thread.threadId) }
                } label: {
                    Label("アーカイブ", systemImage: "archivebox")
                }
                .tint(palette.danger)
            }
            Button {
                editingThread = thread
            } label: {
                Label("タイトルを編集", systemImage: "pencil")
            }
            .tint(palette.action)
        }
        .contextMenu { threadActions(for: thread) }
    }

    var canArchive: Bool { model.threads.count > 1 }

    /// Keeps the conversation search field at the top of the sheet on iPhone.
    static var searchPlacement: SearchFieldPlacement {
#if os(iOS)
        .navigationBarDrawer(displayMode: .always)
#else
        .automatic
#endif
    }

    /// Search context, then the last locally known message, then the message count.
    func detailText(for thread: ChatThreadDTO) -> String {
        if let context = ShannonThreadSearch.matchContext(for: thread, query: searchText) {
            return context
        }
        let last = lastKnownMessage(for: thread.threadId)
        if let preview = ShannonThreadDateGrouping.preview(
            lastMessageText: last?.text,
            lastMessageDate: last?.sentAt,
            threadUpdatedAt: ShannonThreadDateGrouping.date(from: thread.updatedAt)
        ) {
            return preview
        }
        return "\(thread.messageCount)件"
    }

    /// Reads only the on-device display cache; never triggers a network load.
    func lastKnownMessage(for threadId: String) -> (text: String, sentAt: Date)? {
        if threadId == model.selectedThreadId, let message = model.messages.last {
            return (message.text, message.sentAt)
        }
        if let cached = model.cachedHistories[threadId]?.last {
            return (cached.text, cached.sentAt)
        }
        return nil
    }

    @ViewBuilder
    func threadActions(for thread: ChatThreadDTO) -> some View {
        Button {
            editingThread = thread
        } label: {
            Label("タイトルを編集", systemImage: "pencil")
        }

        Button(role: .destructive) {
            Task { await model.archiveThread(thread.threadId) }
        } label: {
            Label("アーカイブ", systemImage: "archivebox")
        }
        .disabled(!canArchive)
    }
}

struct ShannonThreadTitleEditor: View {
    let initialTitle: String
    let save: (String) async -> Bool
    let cancel: () -> Void

    @Environment(\.colorScheme) var colorScheme
    @FocusState var isTitleFieldFocused: Bool
    @State var title: String
    @State var isSaving = false

    init(
        initialTitle: String,
        save: @escaping (String) async -> Bool,
        cancel: @escaping () -> Void
    ) {
        self.initialTitle = initialTitle
        self.save = save
        self.cancel = cancel
        _title = State(initialValue: initialTitle)
    }

    var body: some View {
        let palette = ShannonPalette.resolve(colorScheme)
        NavigationStack {
            VStack(alignment: .leading, spacing: ShannonSpacing.medium) {
                Text("トーク一覧に表示する名前を入力してください。")
                    .font(.body)
                    .foregroundStyle(palette.textSecondary)

                TextField("タイトル", text: $title, axis: .vertical)
                    .lineLimit(1...3)
                    .focused($isTitleFieldFocused)
                    .padding(ShannonSpacing.medium)
                    .background(palette.elevatedSurface, in: RoundedRectangle(cornerRadius: ShannonShape.medium))
                    .accessibilityLabel("トークのタイトル")

                Text("\(title.count)/80文字")
                    .font(.caption)
                    .foregroundStyle(title.count > 80 ? palette.danger : palette.textSecondary)

                Spacer()
            }
            .padding(ShannonSpacing.large)
            .navigationTitle("タイトルを編集")
#if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
#endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("キャンセル", action: cancel)
                        .disabled(isSaving)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(isSaving ? "保存中…" : "保存") {
                        Task {
                            isSaving = true
                            let didSave = await save(title)
                            isSaving = false
                            if didSave { cancel() }
                        }
                    }
                    .disabled(!isValidTitle || isSaving)
                }
            }
        }
        .presentationDetents([.medium])
        .task { isTitleFieldFocused = true }
    }

    var isValidTitle: Bool {
        let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
        return !trimmed.isEmpty && trimmed.count <= 80
    }
}


extension View {
    @ViewBuilder
    func shannonKeyboardDismissMode() -> some View {
#if os(iOS)
        scrollDismissesKeyboard(.interactively)
#else
        self
#endif
    }
}