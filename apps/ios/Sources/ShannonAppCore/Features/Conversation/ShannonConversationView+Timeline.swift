import SwiftUI
#if canImport(UIKit)
import UIKit
#elseif canImport(AppKit)
import AppKit
#endif
extension ShannonConversationView {
    func messageList(_ palette: ShannonPalette) -> some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(spacing: ShannonSpacing.medium) {
                    if model.isLoadingHistory {
                        ProgressView("これまでの会話を思い出している…")
                            .tint(palette.action)
                            .foregroundStyle(palette.textSecondary)
                            .padding(.top, 72)
                    } else if model.messages.isEmpty && model.unattachedSelectedThreadOrganizeSessions.isEmpty {
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
                                sendToAether: { Task { await model.sendToAether(message) } },
                                reactionMenu: ShannonReactionMenuItems(message: message, model: model.reactions, threadID: model.selectedThreadId)
                            )
                                .id(message.id)
                            ShannonMessageExtras(message: message, conversation: model)
                            if let target = message.feedback { ShannonFeedbackView(target: target, model: model.feedback) }
                            if ShannonTurnCaptureList.hasContent(message) {
                                ShannonTurnCaptureList(message: message, conversation: model, memory: memoryModel)
                            }
                            if let task = model.agentTask(sourceMessageID: message.id) {
                                ShannonAgentTaskCardView(
                                    task: task,
                                    cancel: { Task { await model.cancelAgentTask(task.id) } },
                                    open: { openAgentTask(task.id) }
                                )
                                .id("agent-task-\(task.id.uuidString)")
                            }
                            if let session = model.organizeSession(sourceMessageID: message.id) {
                                ShannonConversationOrganizeCard(model: model, session: session)
                                .id("organize-session-\(session.id)")
                            }
                        }
                    }

                    ForEach(model.unattachedSelectedThreadOrganizeSessions) { session in
                        ShannonConversationOrganizeCard(model: model, session: session)
                            .id("organize-session-\(session.id)")
                    }

                    ForEach(model.unattachedSelectedThreadAgentTasks) { task in
                        ShannonAgentTaskCardView(
                            task: task,
                            cancel: { Task { await model.cancelAgentTask(task.id) } },
                            open: { openAgentTask(task.id) }
                        )
                        .id("restored-agent-task-\(task.id.uuidString)")
                    }

                    // A song she chose, while it plays (docs/device-actions-contract.md).
                    ShannonNowPlayingCard()

                    if model.isSending {
                        ShannonTypingIndicator(expression: model.currentExpression, isSearchingMemory: model.isSearchingMemory)
                            .id("shannon-is-typing")
                    }

                    Color.clear.frame(height: 1).id("conversation-bottom")
                }
                .padding(.horizontal, ShannonSpacing.large)
                .padding(.top, ShannonSpacing.medium)
                .padding(.bottom, ShannonSpacing.large)
                .shannonReactionPicker(model.reactions)
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
    }
}
