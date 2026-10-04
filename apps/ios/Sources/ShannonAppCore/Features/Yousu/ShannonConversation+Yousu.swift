import SwiftUI

/// How 「シャノン」 and its ようす hang on the conversation root and its thread list. Kept here
/// so those files carry only the stored state and one line each.

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
    /// Work tasks that wait for a permission, as 「シャノンのいま」 lists them.
    var yousuApprovals: [ShannonNowWaitingItem] {
        model.agentTasks.filter { $0.pendingApproval != nil && !$0.isArchived }.map { task in
            ShannonNowWaitingItem(id: task.id.uuidString, kind: .approval, title: task.title, detail: "作業が、あなたの許可を待っています")
        }
    }

    /// The 「シャノン」 page of the workspace.
    var shannonHub: some View {
        ShannonHubView(
            yousu: yousu,
            memory: memoryModel,
            fallbackMood: model.state?.presence?.mood,
            approvals: yousuApprovals,
            openApproval: { item in
                guard let id = UUID(uuidString: item.id) else { return }
                openAgentTask(id)
            },
            showsYousu: $hubShowsYousu,
            yousuSegment: hubYousuSegment
        )
    }

    /// Opens 「シャノン › ようす」 for a `shannon://yousu` link that arrived.
    func openPendingYousuLink() {
#if DEBUG
        if model.isDesignPreview, !didApplyYousuPreview, let variant = ShannonYousuFixtureClient.launchVariant {
            didApplyYousuPreview = true
            // After the preview's first load has settled the workspace on Talk.
            Task { @MainActor in
                try? await Task.sleep(for: .milliseconds(1_500))
                switch variant {
                case "tile": showsThreadList = true
                case "hub": settleWorkspace(on: .shannon)
                default: openYousu(segment: variant == "now" ? .now : .ops)
                }
            }
            return
        }
#endif
        guard let request = ShannonYousuLink.takePending() else { return }
        openYousu(segment: request.segment)
    }

    func openYousu(segment: ShannonYousuSegment?) {
        composerIsFocused = false
        showsThreadList = false
        hubYousuSegment = segment
        settleWorkspace(on: .shannon)
        hubShowsYousu = true
    }
}

extension ShannonThreadListSheet {
    /// 「設定」.
    var settingsDestination: ShannonThreadListDestination {
        ShannonThreadListDestination(title: ShannonGeneratedStrings.navSettings, symbol: "gearshape", badge: nil, action: openSettings)
    }
}
