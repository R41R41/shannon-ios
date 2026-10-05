import AppKit
import ShannonAppCore
import SwiftUI

/// The empty Talk and the notice of work over Talk, as on the iPhone (roadmap A14).
extension ShannonDesktopRootView {
    /// An empty conversation offers up to three things to talk about; choosing one fills the composer, never sends.
    var emptyTalk: some View {
        VStack(spacing: ShannonDesktopSpacing.large) {
            Spacer(minLength: ShannonDesktopSpacing.large)
            ContentUnavailableView {
                Label("シャノンに話しかける", systemImage: "bubble.left")
            } description: {
                Text("相談、調査、文章、コード、そして実際の作業まで、ここから始められます。")
            }
            ShannonPromptSuggestionList(suggestions: talkPromptSuggestions, colorScheme: colorScheme) { suggestion in
                conversation.draft = suggestion.text
            }
            .frame(maxWidth: 560)
            Spacer(minLength: 160)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    var talkPromptSuggestions: [ShannonPromptSuggestions.Suggestion] {
        ShannonPromptSuggestions.make(
            dailyMindTopic: memory.dashboard?.dailyMind?.topic,
            activeTaskTitles: conversation.agentTasks
                .filter { $0.status.isActive && !$0.isArchived }
                .sorted { $0.updatedAt > $1.updatedAt }
                .map(\.title),
            interests: conversation.state?.interests ?? []
        )
    }

    /// One notice for work that needs the owner or finished: a permission first, then work that
    /// needs him, then a result. It opens the task's 現在地; a one-off approval whose target is
    /// fully shown can be given in place.
    @ViewBuilder
    var talkTaskNotice: some View {
        if let task = conversation.latestAgentTaskNotice {
            ShannonAgentTaskCapsule(
                task: task,
                actionError: conversation.agentTaskActionError(task.id),
                open: {
                    selectedTaskID = task.id
                    showAuxiliaryPanel(.task)
                },
                approveOnce: { [requestID = task.pendingApproval?.externalRequestID] in
                    Task { await conversation.resolveAgentApproval(task.id, accepted: true, requestID: requestID) }
                }
            )
            .frame(maxWidth: 820)
            .padding(.vertical, ShannonDesktopSpacing.small)
            .frame(maxWidth: .infinity)
        }
    }
}
