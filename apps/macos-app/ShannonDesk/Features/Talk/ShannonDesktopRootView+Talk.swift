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
        case .memory:
            ShannonMemoryView(model: memory, showsDismissButton: false)
        case .development:
            developmentView
        case .release:
            ShannonTestFlightDeliveryView(
                model: release,
                showsDismissButton: false,
                requestRelease: requestAppleRelease
            )
        case .settings:
            settingsView
        }
    }

    var talkView: some View {
        VStack(spacing: 0) {
            talkHeader
            if let task = conversation.latestActiveAgentTask {
                DesktopWorkStrip(task: task) {
                    selectedTaskID = task.id
                    showAuxiliaryPanel(.task)
                }
            }
            Divider()

            ZStack(alignment: .bottom) {
                talkTimeline
                conversationBottomOverlay
            }
        }
        .background(Color(nsColor: .textBackgroundColor))
    }

    @ViewBuilder
    var talkTimeline: some View {
        if conversation.messages.isEmpty && !conversation.isLoadingHistory {
            ContentUnavailableView {
                Label("シャノンに話しかける", systemImage: "bubble.left")
            } description: {
                Text("相談、調査、文章、コード、そして実際の作業まで、ここから始められます。")
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
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
                            if let session = conversation.organizeSession(sourceMessageID: message.id) {
                                ShannonOrganizeSessionCard(
                                    session: session,
                                    isWorking: conversation.pendingOrganizeSessionIDs.contains(session.id),
                                    error: conversation.organizeActionErrors[session.id],
                                    taskCandidatesByItemID: conversation.voyagerTaskCandidatesByItemID,
                                    projects: conversation.voyagerProjects,
                                    pendingCatalogItemIDs: conversation.pendingVoyagerCatalogItemIDs,
                                    catalogErrorsByItemID: conversation.voyagerCatalogErrorsByItemID,
                                    decide: { itemID, decision, title, details, operation, target, projectIds in
                                        Task {
                                            await conversation.decideOrganizeItem(
                                                sessionID: session.id, itemID: itemID,
                                                decision: decision, title: title, details: details,
                                                operation: operation, target: target, projectIds: projectIds
                                            )
                                        }
                                    },
                                    searchTasks: { itemID, query in
                                        Task { await conversation.searchVoyagerTasks(itemID: itemID, query: query) }
                                    },
                                    loadProjects: { itemID in
                                        Task { await conversation.loadVoyagerProjects(itemID: itemID) }
                                    },
                                    apply: { Task { await conversation.applyOrganizeSession(session.id) } }
                                )
                                .id("organize-session-\(session.id)")
                            }
                        }
                        if conversation.isSending {
                            HStack(spacing: 8) {
                                ShannonAvatarView(expression: .thinking, size: 26)
                                ProgressView().controlSize(.small)
                                Text("考えています").foregroundStyle(.secondary)
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
        VStack(spacing: 8) {
            if let error = conversation.errorMessage {
                HStack(spacing: 8) {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .foregroundStyle(Color.shannonAttention)
                    Text(error).font(.callout)
                    Spacer()
                    Button("閉じる") { conversation.dismissError() }
                        .buttonStyle(.borderless)
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 8)
                .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            }

            DesktopComposer(model: conversation)
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

    var talkHeader: some View {
        HStack(spacing: 10) {
            VStack(alignment: .leading, spacing: 2) {
                Text(conversation.selectedThread?.title ?? "新しいトーク")
                    .font(.headline)
                    .lineLimit(1)
                Text("会話と作業はiPhoneと同じシャノンへ続きます")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            HStack(spacing: 6) {
                Circle()
                    .fill(Color.accentColor)
                    .frame(width: 7, height: 7)
                Text(DesktopExpressionLabel.label(for: conversation.currentExpression))
                    .font(.callout)
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
        }
        .padding(.horizontal, 18)
        .frame(height: 58)
        .background(Color(nsColor: .textBackgroundColor))
    }
}
