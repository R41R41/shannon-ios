import SwiftUI
#if canImport(UIKit)
import UIKit
#elseif canImport(AppKit)
import AppKit
#endif
extension ShannonConversationView {
    var workspaceNavigationTitle: String {
        guard selectedPage == .talk else { return selectedPage.title }
        return model.threads.first(where: { $0.threadId == model.selectedThreadId })?.title ?? "トーク"
    }

    @ToolbarContentBuilder
    var workspaceToolbar: some ToolbarContent {
        ToolbarItem(placement: .navigation) {
            Button(action: openThreadList) {
                Image(systemName: "sidebar.left")
            }
            .accessibilityLabel("トークと画面を開く")
            .accessibilityValue(ShannonEntryMarks.accessibilityValue(unread: model.totalBadgeCount, waiting: shannonWaitingCount))
            .overlay(alignment: .topTrailing) {
                if model.totalBadgeCount > 0 || shannonWaitingCount > 0 {
                    Circle()
                        .fill(ShannonPalette.resolve(resolvedColorScheme).danger)
                        .frame(width: 8, height: 8)
                        .accessibilityHidden(true)
                }
            }
        }

        if selectedPage == .talk {
            ToolbarItemGroup(placement: .primaryAction) {
                Button(action: toggleDisplayMode) {
                    Image(systemName: displayMode.switchActionSymbolName)
                }
                .accessibilityLabel("\(displayMode.switchActionTitle)表示へ切り替える")

                Button { bodyModel.showsScreen = true } label: {
                    Image(systemName: "figure.stand")
                }
                .accessibilityLabel(ShannonBodyCopy.screenTitle)
                .accessibilityHint(ShannonBodyCopy.openBodyHint)
                .accessibilityIdentifier("open-body")

                Button(action: createThreadFromHeader) {
                    Image(systemName: "square.and.pencil")
                }
                .accessibilityLabel("新しいトーク")
            }
        }
    }

    /// Her stories that wait for a reaction, and her proposals and budget request that wait for a decision.
    var shannonWaitingCount: Int { yousu.now.waitingItems.count }

    func workspaceContent(_ palette: ShannonPalette) -> some View {
        Group {
            switch selectedPage {
            case .talk:
                talkPage(palette)
            case .work:
            ShannonAgentTaskOverviewView(model: model, openTask: openAgentTask)
            case .shannon:
                shannonHub
            }
        }
    }

    func talkPage(_ palette: ShannonPalette) -> some View {
        ZStack {
            Group {
                switch displayMode {
                case .scroll:
                    messageList(palette)
                case .dialogue:
                    dialogueStage(palette)
                }
            }

        }
        .safeAreaInset(edge: .top, spacing: 0) {
            if let task = model.latestAgentTaskNotice {
                ShannonAgentTaskCapsule(
                    task: task,
                    actionError: model.agentTaskActionError(task.id),
                    open: { openAgentTask(task.id) },
                    approveOnce: { Task { await model.resolveAgentApproval(task.id, accepted: true) } }
                )
                .padding(.bottom, ShannonSpacing.extraSmall)
                .transition(.move(edge: .top).combined(with: .opacity))
            }
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            VStack(spacing: ShannonSpacing.small) {
                if let statusMessage = model.statusMessage {
                    ShannonSnackbar(
                        message: statusMessage,
                        symbolName: "info.circle",
                        showsRetry: false,
                        retry: {},
                        dismiss: model.dismissStatus
                    )
                    .padding(.horizontal, ShannonSpacing.large)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
                }
                if let errorMessage = model.errorMessage {
                    ShannonSnackbar(
                        message: errorMessage,
                        showsRetry: model.hasFailedMessage,
                        retry: { Task { await model.retryLastFailed() } },
                        dismiss: model.dismissError
                    )
                    .padding(.horizontal, ShannonSpacing.large)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
                }
                if voiceModel.phase != .idle {
                    ShannonVoiceStatusBar(
                        model: voiceModel,
                        primaryAction: performTranscriptionPrimaryAction,
                        cancel: voiceModel.cancel
                    )
                    .padding(.horizontal, ShannonSpacing.medium)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
                }
#if os(iOS)
                if showsPromptSuggestions {
                    ShannonPromptSuggestionList(suggestions: promptSuggestions, palette: palette) { suggestion in
                        model.draft = suggestion.text
                        composerIsFocused = true
                    }
                    .transition(.opacity)
                }
#endif
                composer(palette)
            }
            .background(.bar)
        }
        .background(palette.canvas)
        .animation(reduceMotion ? nil : .easeOut(duration: 0.22), value: model.errorMessage)
        .animation(reduceMotion ? nil : .easeOut(duration: 0.22), value: model.latestAgentTaskNotice?.id)
        .animation(reduceMotion ? nil : .easeOut(duration: 0.22), value: model.latestAgentTaskNotice?.attention?.key)
    }

    /// Empty scroll-mode conversation with nothing typed yet.
    var showsPromptSuggestions: Bool {
        displayMode == .scroll
            && !model.isLoadingHistory
            && model.messages.isEmpty
            && model.unattachedSelectedThreadOrganizeSessions.isEmpty
            && model.draft.isEmpty
    }

    var promptSuggestions: [ShannonPromptSuggestions.Suggestion] {
        ShannonPromptSuggestions.make(
            dailyMindTopic: memoryModel.dashboard?.dailyMind?.topic,
            activeTaskTitles: model.agentTasks
                .filter { $0.status.isActive && !$0.isArchived }
                .sorted { $0.updatedAt > $1.updatedAt }
                .map(\.title),
            interests: model.state?.interests ?? []
        )
    }
}
