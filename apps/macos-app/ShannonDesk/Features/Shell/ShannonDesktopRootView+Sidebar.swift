import AppKit
import ShannonAppCore
import SwiftUI
import UniformTypeIdentifiers

extension ShannonDesktopRootView {
    var sidebar: some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                ShannonAvatarView(expression: conversation.currentExpression, size: 28)
                Text("Shannon")
                    .font(.headline)
                Spacer()
                Button {
                    Task {
                        await conversation.createThread(title: nil)
                        selectDestination(.talk)
                    }
                } label: {
                    Image(systemName: "square.and.pencil")
                }
                .buttonStyle(.borderless)
                .help("新しいトーク")
            }
            .padding(.horizontal, 12)
            .padding(.top, 10)
            .padding(.bottom, 8)

            HStack(spacing: 8) {
                Image(systemName: "magnifyingglass")
                    .foregroundStyle(.secondary)
                TextField("トークを検索", text: $searchText)
                    .textFieldStyle(.plain)
                    .focused($focusedControl, equals: .threadSearch)
                    .onSubmit { openFirstSearchResult() }
                    .onExitCommand {
                        if searchText.isEmpty {
                            focusedControl = nil
                        } else {
                            searchText = ""
                        }
                    }
                if !searchText.isEmpty {
                    Button {
                        searchText = ""
                        focusedControl = .threadSearch
                    } label: {
                        Image(systemName: "xmark.circle.fill")
                            .foregroundStyle(.tertiary)
                    }
                    .buttonStyle(.plain)
                    .help("検索を消去")
                }
            }
            .padding(.horizontal, 12)
            .frame(height: 34)
            .overlay(alignment: .bottom) { Divider() }
            .padding(.bottom, 8)

            List {
                Section {
                    DesktopSidebarButton(
                        title: "会話",
                        symbol: "bubble.left.and.bubble.right",
                        badge: conversation.unreadInitiativeCount,
                        selected: destination == .talk
                    ) { selectDestination(.talk) }
                    DesktopSidebarButton(
                        title: "作業全体",
                        symbol: "point.3.connected.trianglepath.dotted",
                        badge: conversation.unreadAgentTaskCount,
                        selected: destination == .work
                    ) { selectDestination(.work) }
                    DesktopSidebarButton(
                        title: "頭の中",
                        symbol: "brain.head.profile",
                        badge: 0,
                        selected: destination == .memory
                    ) { selectDestination(.memory) }
                }

                if !threadProjection.initiative.isEmpty {
                    Section {
                        ForEach(threadProjection.initiative, id: \.threadId) { thread in
                            threadRow(thread, showsInitiativeSignal: true)
                        }
                    } header: {
                        Label("シャノンから", systemImage: "sparkles")
                            .foregroundStyle(Color.accentColor)
                    }
                }

                Section(threadProjection.isSearching ? "検索結果" : "トーク") {
                    ForEach(threadProjection.conversations, id: \.threadId) { thread in
                        threadRow(thread, showsInitiativeSignal: false)
                    }
                    if threadProjection.allVisible.isEmpty {
                        Text("一致するトークはありません")
                            .font(.callout)
                            .foregroundStyle(.secondary)
                            .padding(.vertical, 8)
                    }
                }
            }
            .listStyle(.sidebar)

            Divider()
            VStack(spacing: 2) {
                DesktopSidebarButton(
                    title: "設定",
                    symbol: "gearshape",
                    badge: 0,
                    selected: destination == .settings
                ) { selectDestination(.settings) }

                Button {
                    showsConnection = true
                } label: {
                    HStack(spacing: 9) {
                        Image(systemName: connection.isConnected ? "checkmark.circle.fill" : "link.badge.plus")
                            .foregroundStyle(connection.isConnected ? Color.green : Color.secondary)
                        Text(connection.statusLabel)
                            .lineLimit(1)
                        Spacer()
                    }
                    .padding(.horizontal, 10)
                    .frame(height: 36)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
            .padding(8)
        }
        .background(Color(nsColor: .windowBackgroundColor))
    }

    func threadRow(_ thread: ChatThreadDTO, showsInitiativeSignal: Bool) -> some View {
        Button {
            Task { await openSidebarThread(thread) }
        } label: {
            HStack(alignment: .top, spacing: 8) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(thread.title)
                        .lineLimit(1)
                    if let context = ShannonDesktopThreadSearch.matchContext(for: thread, query: searchText) {
                        Text(context)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(2)
                    }
                }
                Spacer(minLength: 4)
                if showsInitiativeSignal {
                    Image(systemName: "sparkles")
                        .font(.caption2)
                        .foregroundStyle(Color.accentColor)
                        .accessibilityLabel("シャノンからの新しい話")
                } else if thread.threadId == conversation.selectedThreadId {
                    Circle()
                        .fill(Color.accentColor)
                        .frame(width: 5, height: 5)
                        .accessibilityHidden(true)
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .contextMenu {
            Button("タイトルを変更") {
                renameThread = thread
                renameText = thread.title
            }
            Button("アーカイブ", role: .destructive) {
                Task { await conversation.archiveThread(thread.threadId) }
            }
            .disabled(conversation.threads.count <= 1)
        }
    }
}
