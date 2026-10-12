import Foundation
import SwiftUI

extension ShannonConversationModel {
    /// Adds the report cards the server wrote into the open Talk since it was read (rich chat). Additive only: in-flight and
    /// local messages are never replaced, and nothing is read while others may see the screen.
    public func refreshReportCards() async {
        guard let thread = selectedThreadId, !isDesignPreview, !reactions.othersPresent else { return }
        let revision = historyLoadRevision
        guard let response = try? await client.loadConversation(scopeKey: scopeKey, threadId: thread),
              selectedThreadId == thread, response.threadId == thread, historyLoadRevision == revision,
              !reactions.othersPresent else { return }
        let knownServerIDs = Set(messages.compactMap(\.serverID))
        let knownIDs = Set(messages.map(\.id))
        let fresh = response.messages.compactMap(Self.conversationMessage).filter { message in
            message.reportCard != nil && !knownIDs.contains(message.id) && !(message.serverID.map(knownServerIDs.contains) ?? false)
        }
        guard !fresh.isEmpty else { return }
        var merged = messages
        for message in fresh {
            let index = merged.firstIndex { $0.sentAt > message.sentAt } ?? merged.endIndex
            merged.insert(message, at: index)
        }
        messages = merged
        cacheCurrentHistory()
        persistDisplayCache()
    }
}

/// Reads the open Talk again when finished work he asked for has a new report in 「いま」, so its report card appears without
/// a reload. The server writes the card a few seconds after the report (once its short spoken form exists, at most ~25 s).
public struct ShannonReportCardRefresh: ViewModifier {
    let activity: ShannonConversationActivityModel
    let conversation: ShannonConversationModel

    public init(activity: ShannonConversationActivityModel, conversation: ShannonConversationModel) {
        self.activity = activity
        self.conversation = conversation
    }

    public func body(content: Content) -> some View {
        content.task(id: signature) {
            guard !signature.isEmpty else { return }
            for delay in [6, 30] {
                do { try await Task.sleep(for: .seconds(delay)) } catch { return }
                await conversation.refreshReportCards()
            }
        }
    }

    private var signature: String {
        activity.tasks
            .filter { $0.origin == "owner_request" && $0.sourceThreadId == conversation.selectedThreadId && ["completed", "failed"].contains($0.phase) }
            .compactMap { task in task.report.map { "\(task.id):\($0.id):\($0.spoken == nil ? 0 : 1)" } }
            .joined(separator: "|")
    }
}
