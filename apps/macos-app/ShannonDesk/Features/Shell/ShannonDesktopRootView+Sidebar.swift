import AppKit
import ShannonAppCore
import SwiftUI
import UniformTypeIdentifiers

/// The sidebar of the four pillars (docs/product/information-architecture.md, roadmap A10):
/// トーク／作業／シャノン at the top, the talks below them with search, and 設定 as the last row.
extension ShannonDesktopRootView {
    var sidebar: some View {
        VStack(spacing: 0) {
            HStack(spacing: ShannonDesktopSpacing.small) {
                ShannonAvatarView(face: conversation.currentFace, size: 28)
                Text(ShannonGeneratedStrings.appName)
                    .font(.shannonDesktop(.headline))
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
                // During 「友人も一緒」 a new Talk is not made (his hidden draft and attachments would go).
                .disabled(voiceCall.session.hidesOwnerScreens)
            }
            .padding(.horizontal, ShannonDesktopSpacing.medium)
            .padding(.top, ShannonDesktopSpacing.medium)
            .padding(.bottom, ShannonDesktopSpacing.small)

            List(selection: sidebarSelection) {
                Section {
                    sidebarDestinationRow(
                        title: ShannonGeneratedStrings.navTalk,
                        symbol: "bubble.left.and.bubble.right",
                        badge: conversation.unreadInitiativeCount,
                        badgeLabel: "未確認\(conversation.unreadInitiativeCount)件",
                        destination: .talk
                    )
                    sidebarDestinationRow(
                        title: ShannonGeneratedStrings.navWork,
                        symbol: "point.3.connected.trianglepath.dotted",
                        badge: conversation.unreadAgentTaskCount,
                        badgeLabel: "未確認\(conversation.unreadAgentTaskCount)件",
                        destination: .work
                    )
                    sidebarDestinationRow(
                        title: ShannonGeneratedStrings.navShannon,
                        symbol: "person.crop.circle",
                        badge: shannonWaitingCount,
                        badgeLabel: ShannonGeneratedStrings.entryWaiting(count: String(shannonWaitingCount)),
                        destination: .shannon
                    )
                }

                if voiceCall.session.hidesOwnerScreens {
                    // 「友人も一緒」: the list of talks (titles, her messages, search matches) is not shown.
                    Section(ShannonGeneratedStrings.navTalk) {
                        Text(ShannonGeneratedStrings.voiceGuestHidesTalk)
                            .font(.shannonDesktop(.callout))
                            .foregroundStyle(.secondary)
                            .padding(.vertical, ShannonDesktopSpacing.small)
                            .accessibilityIdentifier("sidebar-talks-hidden")
                    }
                } else {
                if !threadProjection.initiative.isEmpty {
                    Section {
                        ForEach(threadProjection.initiative, id: \.threadId) { thread in
                            threadRow(thread, showsInitiativeSignal: true)
                        }
                    } header: {
                        Label("シャノンから", systemImage: "sparkles")
                            .foregroundStyle(Color.shannonIntelligenceColor)
                    }
                }

                Section(threadProjection.isSearching ? "検索結果" : ShannonGeneratedStrings.navTalk) {
                    ForEach(threadProjection.conversations, id: \.threadId) { thread in
                        threadRow(thread, showsInitiativeSignal: false)
                    }
                    if threadProjection.allVisible.isEmpty {
                        Text("一致するトークはありません")
                            .font(.shannonDesktop(.callout))
                            .foregroundStyle(.secondary)
                            .padding(.vertical, ShannonDesktopSpacing.small)
                    }
                }
                }
            }
            .listStyle(.sidebar)
            .searchable(text: $searchText, placement: .sidebar, prompt: "トークを検索")
            .desktopSearchFocused($isThreadSearchFocused)
            .onSubmit(of: .search, openFirstSearchResult)

            Divider()
            sidebarFooter
        }
        .background(Color(nsColor: .windowBackgroundColor))
    }

    /// What waits for the owner in 「シャノン」, the same count as the iPhone's tile.
    var shannonWaitingCount: Int {
        yousu.now.waiting(approvals: conversation.waitingApprovals).count
    }

    /// The bottom of the sidebar: the 設定 row, then the lines that must always be visible:
    /// the 運用 mark's reason (roadmap A12), a voice conversation that is on (A16), the camera's state and,
    /// while not connected, the connection.
    var sidebarFooter: some View {
        let opsReason = yousu.ops.attentionReason()
        return VStack(alignment: .leading, spacing: 2) {
            DesktopSidebarButton(
                title: ShannonGeneratedStrings.navSettings,
                symbol: "gearshape",
                badge: 0,
                selected: destination == .settings,
                attention: opsReason,
                action: { selectDestination(.settings) }
            )
            if let opsReason {
                sidebarFooterLine(
                    ShannonGeneratedStrings.entryOpsReason(reason: opsReason),
                    hint: ShannonGeneratedStrings.adminOpsHint
                ) {
                    DesktopOpsMark()
                } action: {
                    openSettings(.ops)
                }
            }
            // A call is visible on every page beside the camera's state (owner decision 2026-10-06, option B):
            // 「音声会話・〈いまの段階〉」, its time, mute and 終了; the row shows Talk.
            ShannonDesktopVoiceCallRow(call: voiceCall) { selectDestination(.talk) }
            // 「声」 and 「耳」 on every page, the same pills as at the Windows body's feet and over the iPhone's composer
            // (voice.speak-listen-pills, 2026-10-26).
            ShannonVoiceEarPills()
                .padding(.horizontal, ShannonDesktopSpacing.medium)
                .padding(.vertical, 2)
            // The camera's state is always visible (A14): 切／見てよい／いま見ています. It opens 設定 › カメラ.
            ShannonAppLookStateReader(conversation: conversation) { state in
                sidebarFooterLine(state.line, hint: "設定のカメラを開きます") {
                    Image(systemName: state.symbol).foregroundStyle(Color.secondary)
                } action: {
                    openSettings(.camera)
                }
                .accessibilityIdentifier("sidebar-app-look-state")
            }
            if !connection.isConnected {
                sidebarFooterLine(connection.statusLabel, hint: "接続を開きます") {
                    Image(systemName: "link.badge.plus").foregroundStyle(Color.secondary)
                } action: {
                    showsConnection = true
                }
            }
        }
        .padding(ShannonDesktopSpacing.small)
        // The mark stays current while the window is open: 運用 is read every three minutes.
        .task(id: connection.isConnected) {
            guard connection.isConnected, !conversation.isDesignPreview else { return }
            await yousu.now.reload()
            while !Task.isCancelled {
                await yousu.ops.refresh()
                do { try await Task.sleep(for: .seconds(180)) } catch { return }
            }
        }
    }

    func sidebarFooterLine<Icon: View>(
        _ text: String,
        hint: String,
        @ViewBuilder icon: () -> Icon,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            HStack(spacing: ShannonDesktopSpacing.small) {
                icon()
                Text(text)
                    .lineLimit(2)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 0)
            }
            .font(.shannonDesktop(.callout))
            .padding(.horizontal, ShannonDesktopSpacing.medium)
            .frame(minHeight: ShannonDesktopMetrics.rowHeight)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(text)
        .accessibilityHint(hint)
        .accessibilityAddTraits(.isButton)
    }

    func sidebarDestinationRow(
        title: String,
        symbol: String,
        badge: Int,
        badgeLabel: String,
        destination: DesktopDestination
    ) -> some View {
        Label {
            HStack {
                Text(title)
                Spacer()
                if badge > 0 {
                    Text("\(badge)")
                        .font(.shannonDesktop(.caption).monospacedDigit())
                        .foregroundStyle(.secondary)
                }
            }
        } icon: {
            Image(systemName: symbol)
        }
        .tag(DesktopSidebarSelection.destination(destination))
        .accessibilityValue(badge > 0 ? badgeLabel : "")
    }

    func threadRow(_ thread: ChatThreadDTO, showsInitiativeSignal: Bool) -> some View {
        HStack(alignment: .top, spacing: ShannonDesktopSpacing.small) {
            VStack(alignment: .leading, spacing: 2) {
                Text(thread.title)
                    .lineLimit(1)
                if let context = ShannonDesktopThreadSearch.matchContext(for: thread, query: searchText) {
                    Text(context)
                        .font(.shannonDesktop(.caption))
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }
            }
            Spacer(minLength: 4)
            if showsInitiativeSignal {
                Image(systemName: "sparkles")
                    .font(.shannonDesktop(.caption2))
                    .foregroundStyle(Color.shannonIntelligenceColor)
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
