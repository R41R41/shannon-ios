import AppKit
import ShannonAppCore
import SwiftUI
import UniformTypeIdentifiers

extension ShannonDesktopRootView {
    var sidebar: some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                ShannonAvatarView(expression: conversation.currentExpression, size: 28)
                Text("シャノン")
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

            List(selection: sidebarSelection) {
                Section("ワークスペース") {
                    sidebarDestinationRow(
                        title: "会話",
                        symbol: "bubble.left.and.bubble.right",
                        badge: conversation.unreadInitiativeCount,
                        destination: .talk
                    )
                    sidebarDestinationRow(
                        title: "作業全体",
                        symbol: "point.3.connected.trianglepath.dotted",
                        badge: conversation.unreadAgentTaskCount,
                        destination: .work
                    )
                    sidebarDestinationRow(
                        title: "頭の中",
                        symbol: "brain.head.profile",
                        badge: 0,
                        destination: .memory
                    )
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

                Section("ツール") {
                    sidebarDestinationRow(
                        title: "開発",
                        symbol: "chevron.left.forwardslash.chevron.right",
                        badge: workProjection.active.count,
                        destination: .development
                    )
                    sidebarDestinationRow(
                        title: "Release Center",
                        symbol: "shippingbox",
                        badge: 0,
                        destination: .release
                    )
                    sidebarDestinationRow(
                        title: "設定",
                        symbol: "gearshape",
                        badge: 0,
                        destination: .settings
                    )
                }
            }
            .listStyle(.sidebar)
            .searchable(text: $searchText, placement: .sidebar, prompt: "トークを検索")
            .desktopSearchFocused($isThreadSearchFocused)
            .onSubmit(of: .search, openFirstSearchResult)

            Divider()
            VStack(spacing: 2) {
                Button {
                    showsConnection = true
                } label: {
                    HStack(spacing: 9) {
                        Image(systemName: connection.isConnected ? "checkmark.circle.fill" : "link.badge.plus")
                            .foregroundStyle(connection.isConnected ? Color.shannonSuccess : Color.secondary)
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

    func sidebarDestinationRow(
        title: String,
        symbol: String,
        badge: Int,
        destination: DesktopDestination
    ) -> some View {
        Label {
            HStack {
                Text(title)
                Spacer()
                if badge > 0 {
                    Text("\(badge)")
                        .font(.caption.monospacedDigit())
                        .foregroundStyle(.secondary)
                }
            }
        } icon: {
            Image(systemName: symbol)
        }
        .tag(DesktopSidebarSelection.destination(destination))
        .accessibilityValue(badge > 0 ? "未確認\(badge)件" : "")
    }

    func threadRow(_ thread: ChatThreadDTO, showsInitiativeSignal: Bool) -> some View {
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
            }
        }
        .tag(DesktopSidebarSelection.thread(thread.threadId))
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
