import SwiftUI

/// How 「ようす」 hangs on the conversation root and its thread list. Kept here so those
/// files carry only the stored state and one line each.

extension ShannonYousuModel {
    /// The models for one conversation, reading through the same client and scope.
    static func make(for conversation: ShannonConversationModel) -> ShannonYousuModel {
#if DEBUG
        if conversation.isDesignPreview, let variant = ShannonYousuFixtureClient.launchVariant {
            return ShannonYousuModel(scopeKey: conversation.scopeKey, client: ShannonYousuFixtureClient(stale: variant == "opsStale"))
        }
#endif
        return ShannonYousuModel(scopeKey: conversation.scopeKey, client: conversation.client as? any ShannonYousuServing)
    }
}

extension ShannonConversationView {
    /// Opens the thread list on 「ようす」 for a `shannon://yousu` link that arrived.
    func openPendingYousuLink() {
#if DEBUG
        if model.isDesignPreview, !didApplyYousuPreview, let variant = ShannonYousuFixtureClient.launchVariant {
            didApplyYousuPreview = true
            // After the preview's first load has settled the workspace on Talk.
            Task { @MainActor in
                for _ in 0..<4 {
                    try? await Task.sleep(for: .milliseconds(1_500))
                    guard !showsThreadList else { continue }
                    if variant != "tile" { yousuRequest = .init(segment: variant == "now" ? .now : .ops) }
                    showsThreadList = true
                }
            }
            return
        }
#endif
        guard let request = ShannonYousuLink.takePending() else { return }
        composerIsFocused = false
        yousuRequest = request
        showsThreadList = true
    }
}

extension ShannonThreadListSheet {
    /// The fourth tile. Its mark appears only while something in 運用 deserves a look.
    var yousuDestination: ShannonThreadListDestination {
        ShannonThreadListDestination(
            title: "ようす", symbol: "waveform.path.ecg", badge: nil, attention: yousu.needsAttention,
            action: { showsYousu = true }
        )
    }

    /// Work tasks that wait for a permission, as 「シャノンのいま」 lists them.
    var yousuApprovals: [ShannonNowWaitingItem] {
        model.agentTasks.filter { $0.pendingApproval != nil && !$0.isArchived }.map { task in
            ShannonNowWaitingItem(id: task.id.uuidString, kind: .approval, title: task.title, detail: "作業が、あなたの許可を待っています")
        }
    }

    var yousuPage: some View {
        ShannonYousuView(
            model: yousu,
            requested: yousuSegment,
            fallbackMood: model.state?.presence?.mood,
            approvals: yousuApprovals,
            openApproval: { item in
                guard let id = UUID(uuidString: item.id) else { return }
                openAgentTask(id)
            },
            autonomy: autonomy
        )
    }

    /// A link asked for 「ようす」: push it, on the segment it named.
    func applyYousuRequest() {
        guard let request = yousuRequest else { return }
        yousuSegment = request.segment
        showsYousu = true
        yousuRequest = nil
    }
}
