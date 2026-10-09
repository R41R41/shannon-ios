import AppKit
import ShannonAppCore
import SwiftUI
import UniformTypeIdentifiers

extension ShannonDesktopRootView {
    @ViewBuilder
    var detail: some View {
        switch destination {
        case .talk:
            talkView
        case .work:
            workOverview
                .desktopWorkPagePicker(selection: workPageSelection)
        case .shannon:
            shannonHub
        case .development:
            developmentView
                .desktopWorkPagePicker(selection: workPageSelection)
        case .release:
            ShannonTestFlightDeliveryView(
                model: release,
                showsDismissButton: false,
                requestRelease: requestAppleRelease
            )
            .navigationTitle(ShannonGeneratedStrings.navDelivery)
            .desktopWorkPagePicker(selection: workPageSelection)
        case .settings:
            settingsView
        }
    }

    /// A call in 「友人も一緒」 is on: the owner's Talk and its traces are not on screen (coordinator decision
    /// 2026-10-06). The call bar and the composer stay.
    var hidesOwnerTalk: Bool { voiceCall.session.hidesOwnerScreens }

    var talkView: some View {
        ViewThatFits(in: .horizontal) {
            if now.showsActivity {
                HStack(spacing: 0) {
                    talkConversation.frame(minWidth: 420)
                    Divider()
                    ShannonNowPanel(model: now).frame(width: 300)
                }
            }
            VStack(spacing: 0) {
                ShannonNowCompact(model: now).padding(.horizontal, ShannonDesktopSpacing.medium)
                talkConversation
            }
        }
    }

    var talkConversation: some View {
        VStack(spacing: 0) {
            talkHeader
            ShannonActionThreadsCapsule(model: actionThreads)
            if !hidesOwnerTalk, let task = conversation.latestActiveAgentTask {
                DesktopWorkStrip(task: task) {
                    selectedTaskID = task.id
                    showAuxiliaryPanel(.task)
                }
            }
            Divider()
            if !hidesOwnerTalk { talkTaskNotice }

            ZStack(alignment: .bottom) {
                // Covered, not only hidden behind: the list is not drawn, so nothing scrolls to new turns either.
                talkTimeline
                    .shannonGuestCover(hidesOwnerTalk, style: .replace)
                conversationBottomOverlay
            }
        }
        .background(Color(nsColor: .textBackgroundColor))
    }

    @ViewBuilder
    var talkTimeline: some View {
        if conversation.messages.isEmpty && conversation.unattachedSelectedThreadOrganizeSessions.isEmpty && !conversation.isLoadingHistory {
            emptyTalk
        } else {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 20) {
                        ForEach(conversation.messages) { message in
                            let canRetry = message.deliveryState == .failed
                                && message.id == conversation.messages.last(where: {
                                    $0.role == .user && $0.deliveryState == .failed
                                })?.id
                            DesktopMessageView(
                                message: message,
                                retry: canRetry ? {
                                    Task { await conversation.retryLastFailed() }
                                } : nil
                            )
                                .id(message.id)
                            if let target = message.feedback { ShannonFeedbackView(target: target, model: conversation.feedback) }
                            if ShannonTurnCaptureList.hasContent(message) {
                                ShannonTurnCaptureList(message: message, conversation: conversation, memory: memory)
                            }
                            if let session = conversation.organizeSession(sourceMessageID: message.id) {
                                ShannonConversationOrganizeCard(model: conversation, session: session)
                                .id("organize-session-\(session.id)")
                            }
                        }
                        ForEach(conversation.unattachedSelectedThreadOrganizeSessions) { session in
                            ShannonConversationOrganizeCard(model: conversation, session: session)
                                .id("organize-session-\(session.id)")
                        }
                        if conversation.isSending {
                            HStack(spacing: ShannonDesktopSpacing.small) {
                                ShannonAvatarView(expression: .thinking, size: 26)
                                ProgressView().controlSize(.small)
                                Text(conversation.isSearchingMemory ? "記憶を探しています…" : "考えている…").foregroundStyle(.secondary)
                            }
                        }
                    }
                    .frame(maxWidth: 820, alignment: .leading)
                    .padding(.horizontal, 34)
                    .padding(.top, 28)
                    .padding(.bottom, 150)
                    .frame(maxWidth: .infinity)
                }
                .coordinateSpace(name: DesktopConversationOutlineAnchorModifier.coordinateSpaceName)
                .onPreferenceChange(DesktopConversationOutlinePositionPreferenceKey.self) { positions in
                    activeConversationOutlineEntryID = ShannonDesktopConversationOutline.activeEntryID(
                        entries: conversationOutline,
                        verticalPositions: positions,
                        activationLine: 92
                    )
                }
                .onChange(of: conversation.messages.count) {
                    scrollConversation(using: proxy)
                }
                .task(id: messageJumpRevision) {
                    await Task.yield()
                    scrollConversation(using: proxy)
                }
            }
        }
    }

    var conversationBottomOverlay: some View {
        VStack(spacing: ShannonDesktopSpacing.small) {
            if let error = conversation.errorMessage {
                HStack(spacing: ShannonDesktopSpacing.small) {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .foregroundStyle(Color.shannonAttention)
                    Text(error).font(.shannonDesktop(.callout))
                    Spacer()
                    Button("閉じる") { conversation.dismissError() }
                        .buttonStyle(.borderless)
                }
                .padding(.horizontal, ShannonDesktopSpacing.large)
                .padding(.vertical, ShannonDesktopSpacing.small)
                .background(.regularMaterial, in: RoundedRectangle(cornerRadius: ShannonDesktopRadius.medium, style: .continuous))
            }

            // The voice conversation sits over the composer while it is on (A16).
            ShannonDesktopVoiceCallBar(call: voiceCall, conversation: conversation) { taskID in
                selectedTaskID = taskID
                showAuxiliaryPanel(.task)
            }

            DesktopComposer(model: conversation, voiceCall: voiceCall, startCall: startVoiceCall)
                .background {
                    RoundedRectangle(cornerRadius: 22, style: .continuous)
                        .fill(.ultraThinMaterial)
                        .overlay {
                            RoundedRectangle(cornerRadius: 22, style: .continuous)
                                .fill(Color(nsColor: .controlBackgroundColor).opacity(0.62))
                        }
                }
                .overlay {
                    RoundedRectangle(cornerRadius: 22, style: .continuous)
                        .stroke(Color.primary.opacity(0.09), lineWidth: 0.75)
                }
                .shadow(color: .black.opacity(0.14), radius: 18, y: 7)
        }
        .frame(maxWidth: 820)
        .padding(.horizontal, 28)
        .padding(.bottom, 18)
        .padding(.top, 34)
        .frame(maxWidth: .infinity)
        .background(alignment: .bottom) {
            LinearGradient(
                colors: [
                    Color(nsColor: .textBackgroundColor).opacity(0),
                    Color(nsColor: .textBackgroundColor).opacity(0.84),
                    Color(nsColor: .textBackgroundColor),
                ],
                startPoint: .top,
                endPoint: .bottom
            )
            .allowsHitTesting(false)
        }
    }

    /// 音声会話を開始: a call on the Talk in front, with her figure beside the conversation (「姿は会話の横」).
    func startVoiceCall() {
        voiceCall.start(threadID: conversation.selectedThreadId)
        showAuxiliaryPanel(.figure)
    }

    var talkHeader: some View {
        HStack(spacing: ShannonDesktopSpacing.medium) {
            VStack(alignment: .leading, spacing: 2) {
                Text(hidesOwnerTalk ? ShannonGeneratedStrings.navTalk : conversation.selectedThread?.title ?? "新しいトーク")
                    .font(.shannonDesktop(.headline))
                    .lineLimit(1)
                Text("会話と作業はiPhoneと同じシャノンへ続きます")
                    .font(.shannonDesktop(.caption))
                    .foregroundStyle(.secondary)
            }
            Spacer()
            HStack(spacing: 6) {
                Circle()
                    .fill(Color.shannonIntelligenceColor)
                    .frame(width: 7, height: 7)
                Text(conversation.currentFace.japaneseName)
                    .font(.shannonDesktop(.callout))
                    .foregroundStyle(.secondary)
            }
            Button {
                toggleAuxiliaryPanel(.outline)
            } label: {
                Image(systemName: "list.bullet.indent")
                    .symbolVariant(showsInspector && auxiliaryPanel == .outline ? .fill : .none)
            }
            .buttonStyle(.borderless)
            .disabled(conversationOutline.isEmpty && conversation.selectedThread?.summary == nil)
            .help("会話の目次")
            Button {
                prepareTaskInspectorSelection()
                toggleAuxiliaryPanel(.task)
            } label: {
                Image(systemName: "sidebar.trailing")
                    .symbolVariant(showsInspector && auxiliaryPanel == .task ? .fill : .none)
            }
            .buttonStyle(.borderless)
            .help("現在地を表示")
            Button {
                toggleAuxiliaryPanel(.figure)
            } label: {
                Image(systemName: DesktopAuxiliaryPanel.figure.symbolName)
                    .symbolVariant(showsInspector && auxiliaryPanel == .figure ? .fill : .none)
            }
            .buttonStyle(.borderless)
            .help("すがたを表示")
            .accessibilityLabel("すがたを表示")
        }
        .padding(.horizontal, 18)
        .frame(height: 58)
        .background(Color(nsColor: .textBackgroundColor))
    }
}
