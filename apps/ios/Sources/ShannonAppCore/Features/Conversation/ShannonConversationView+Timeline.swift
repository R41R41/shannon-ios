import SwiftUI
#if canImport(UIKit)
import UIKit
#elseif canImport(AppKit)
import AppKit
#endif
extension ShannonConversationView {
    func messageList(_ palette: M3Palette) -> some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(spacing: M3Spacing.medium) {
                    if model.isLoadingHistory {
                        ProgressView("これまでの会話を思い出している…")
                            .tint(palette.primary)
                            .foregroundStyle(palette.onSurfaceVariant)
                            .padding(.top, 72)
                    } else if model.messages.isEmpty {
                        ShannonEmptyConversation()
                    }

                    ForEach(ShannonConversationTimeline.items(from: model.messages)) { item in
                        switch item {
                        case .day(let day):
                            ShannonConversationDayDivider(day: day)
                        case .message(let message):
                            if message.id == latestShannonMessageID,
                               let reference = model.latestContextReference {
                                ShannonContextReferenceCard(memory: reference)
                            }
                            ShannonMessageRow(
                                message: message,
                                isSendingToAether: model.aetherProposalMessageIDs.contains(message.id),
                                wasSentToAether: model.aetherSubmittedMessageIDs.contains(message.id),
                                sendToAether: { Task { await model.sendToAether(message) } }
                            )
                                .id(message.id)
                            if let task = model.agentTask(sourceMessageID: message.id) {
                                ShannonAgentTaskCardView(
                                    task: task,
                                    start: { Task { await model.startAgentTask(task.id) } },
                                    cancel: { Task { await model.cancelAgentTask(task.id) } },
                                    open: { openAgentTask(task.id) }
                                )
                                .id("agent-task-\(task.id.uuidString)")
                            }
                            if let session = model.organizeSession(sourceMessageID: message.id) {
                                ShannonOrganizeSessionCard(
                                    session: session,
                                    isWorking: model.pendingOrganizeSessionIDs.contains(session.id),
                                    error: model.organizeActionErrors[session.id],
                                    taskCandidatesByItemID: model.voyagerTaskCandidatesByItemID,
                                    projects: model.voyagerProjects,
                                    pendingCatalogItemIDs: model.pendingVoyagerCatalogItemIDs,
                                    catalogErrorsByItemID: model.voyagerCatalogErrorsByItemID,
                                    decide: { itemID, decision, title, details, operation, target, projectIds in
                                        Task {
                                            await model.decideOrganizeItem(
                                                sessionID: session.id, itemID: itemID,
                                                decision: decision, title: title, details: details,
                                                operation: operation, target: target, projectIds: projectIds
                                            )
                                        }
                                    },
                                    searchTasks: { itemID, query in
                                        Task { await model.searchVoyagerTasks(itemID: itemID, query: query) }
                                    },
                                    loadProjects: { itemID in
                                        Task { await model.loadVoyagerProjects(itemID: itemID) }
                                    },
                                    apply: { Task { await model.applyOrganizeSession(session.id) } }
                                )
                                .id("organize-session-\(session.id)")
                            }
                        }
                    }

                    ForEach(model.unattachedSelectedThreadAgentTasks) { task in
                        ShannonAgentTaskCardView(
                            task: task,
                            start: { Task { await model.startAgentTask(task.id) } },
                            cancel: { Task { await model.cancelAgentTask(task.id) } },
                            open: { openAgentTask(task.id) }
                        )
                        .id("restored-agent-task-\(task.id.uuidString)")
                    }

                    if model.isSending {
                        ShannonTypingIndicator(expression: model.currentExpression)
                            .id("shannon-is-typing")
                    }

                    Color.clear.frame(height: 1).id("conversation-bottom")
                }
                .padding(.horizontal, M3Spacing.large)
                .padding(.top, ShannonWorkspaceChrome.contentTopInset)
                .padding(.bottom, ShannonWorkspaceChrome.contentBottomInset)
            }
            .scrollIndicators(.hidden)
            .shannonKeyboardDismissMode()
            .background(Color.clear)
            .contentShape(Rectangle())
            .simultaneousGesture(TapGesture().onEnded { composerIsFocused = false })
            .onChange(of: model.messages.count) {
                scrollToBottom(proxy)
            }
            .onChange(of: model.isSending) {
                scrollToBottom(proxy)
            }
#if DEBUG
            .task {
                guard ProcessInfo.processInfo.arguments.contains("-ShannonPreviewTopEdge"),
                      model.messages.count > 1
                else { return }
                try? await Task.sleep(for: .milliseconds(450))
                proxy.scrollTo(model.messages[1].id, anchor: .top)
            }
#endif
        }
        .ignoresSafeArea(.container, edges: [.top, .bottom])
    }
}
