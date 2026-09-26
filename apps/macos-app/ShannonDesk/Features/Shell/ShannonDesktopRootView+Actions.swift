import AppKit
import ShannonAppCore
import SwiftUI
import UniformTypeIdentifiers

extension ShannonDesktopRootView {
    func selectTask(_ task: ShannonAgentTask) {
        selectedTaskID = task.id
        showAuxiliaryPanel(.task)
    }

    func prepareTaskInspectorSelection() {
        selectedTaskID = selectedTaskID
            ?? conversation.latestActiveAgentTask?.id
            ?? conversation.agentTasks.first?.id
    }

    func showAuxiliaryPanel(_ panel: DesktopAuxiliaryPanel) {
        auxiliaryPanel = panel
        showsInspector = true
    }

    func toggleAuxiliaryPanel(_ panel: DesktopAuxiliaryPanel) {
        let visibleEntry = activeConversationOutlineEntryID.flatMap { id in
            conversationOutline.first { $0.id == id }
        }
        if showsInspector, auxiliaryPanel == panel {
            showsInspector = false
        } else {
            showAuxiliaryPanel(panel)
        }
        guard destination == .talk, let visibleEntry else { return }
        Task { @MainActor in
            await Task.yield()
            requestedMessageJumpID = visibleEntry.messageID
            requestedConversationAnchorID = visibleEntry.id
            messageJumpRevision &+= 1
        }
    }

    func requestConversationOutlineJump(_ entry: ShannonDesktopConversationOutlineEntry) {
        requestedMessageJumpID = entry.messageID
        requestedConversationAnchorID = entry.id
        activeConversationOutlineEntryID = entry.id
        messageJumpRevision &+= 1
    }

    func openTaskConversation(_ task: ShannonAgentTask) {
        let context = ShannonDesktopConversationContext(task: task)
        Task {
            await conversation.selectThread(context.threadID)
            selectDestination(.talk)
            requestedMessageJumpID = context.sourceMessageID
            messageJumpRevision &+= 1
        }
    }

    func openSidebarThread(_ thread: ChatThreadDTO) async {
        let query = searchText
        await conversation.selectThread(thread.threadId)
        selectDestination(.talk)
        guard let target = ShannonDesktopConversationOutline.searchTargetMessageID(
            in: conversation.messages,
            query: query
        ) else { return }
        requestedMessageJumpID = target
        messageJumpRevision &+= 1
    }

    func scrollConversation(using proxy: ScrollViewProxy) {
        if let requestedConversationAnchorID,
           let requestedMessageJumpID,
           conversation.messages.contains(where: { $0.id == requestedMessageJumpID }) {
            activeConversationOutlineEntryID = requestedConversationAnchorID
            withAnimation(reduceMotion ? nil : .easeOut(duration: 0.24)) {
                proxy.scrollTo(requestedMessageJumpID, anchor: .center)
            }
            self.requestedConversationAnchorID = nil
            self.requestedMessageJumpID = nil
            return
        }
        if let requestedMessageJumpID,
           conversation.messages.contains(where: { $0.id == requestedMessageJumpID }) {
            withAnimation(reduceMotion ? nil : .easeOut(duration: 0.24)) {
                proxy.scrollTo(requestedMessageJumpID, anchor: .center)
            }
            self.requestedMessageJumpID = nil
        } else if requestedMessageJumpID == nil, let id = conversation.messages.last?.id {
            withAnimation(reduceMotion ? nil : .easeOut(duration: 0.2)) {
                proxy.scrollTo(id, anchor: .bottom)
            }
        }
    }

    func selectDestination(_ destination: DesktopDestination) {
        if destination == .work || destination == .development || destination == .release {
            auxiliaryPanel = .task
        }
        restoredDestinationRawValue = destination.rawValue
        lastDestinationRawValue = destination.rawValue
    }

    func requestAppleRelease(_ target: ShannonAppleReleaseTarget) {
        selectedTaskID = conversation.proposeAppleRelease(target)
        selectDestination(.development)
    }

    func focusThreadSearch() {
        selectDestination(.talk)
        isThreadSearchFocused = true
    }

    func openFirstSearchResult() {
        guard let threadID = ShannonDesktopThreadSearch.firstResultID(
            in: conversation.threads,
            query: searchText
        ) else { return }
        Task {
            await conversation.selectThread(threadID)
            selectDestination(.talk)
        }
    }

    func restoreSelectedThreadIfAvailable() async {
        let candidate = ShannonDesktopWindowRestoration.identifier(
            sceneValue: restoredThreadID,
            lastValue: lastRestoredThreadID
        )
        guard let candidate,
              candidate != conversation.selectedThreadId,
              conversation.threads.contains(where: { $0.threadId == candidate }) else { return }
        await conversation.selectThread(candidate)
    }

    func restoreSelectedTaskIfAvailable() {
        let resolvedID = ShannonDesktopTaskRestoration.resolve(
            rawValue: ShannonDesktopWindowRestoration.identifier(
                sceneValue: restoredTaskID,
                lastValue: lastRestoredTaskID
            ),
            tasks: conversation.agentTasks
        )
        if selectedTaskID != resolvedID {
            selectedTaskID = resolvedID
        }
    }

    func restoreWindowChromeIfAvailable() {
#if DEBUG
        if conversation.isDesignPreview {
            if ProcessInfo.processInfo.arguments.contains("-ShannonPreviewRelease") {
                restoredDestinationRawValue = DesktopDestination.release.rawValue
            } else if ProcessInfo.processInfo.arguments.contains("-ShannonPreviewDevelopment") {
                restoredDestinationRawValue = DesktopDestination.development.rawValue
            }
        }
#endif
        if restoredDestinationRawValue == nil {
            restoredDestinationRawValue = destination.rawValue
        }
        let restoredChrome = ShannonDesktopWindowRestoration.windowChrome(
            sceneInspectorRawValue: restoredInspectorRawValue,
            sceneAuxiliaryPanelRawValue: restoredAuxiliaryPanelRawValue,
            lastInspectorVisible: lastShowsInspector,
            lastAuxiliaryPanelRawValue: lastAuxiliaryPanelRawValue
        )
        var restorationTransaction = Transaction(animation: nil)
        restorationTransaction.disablesAnimations = true
        withTransaction(restorationTransaction) {
            showsInspector = restoredChrome.showsInspector
            auxiliaryPanel = restoredChrome.auxiliaryPanel
        }
        if restoredInspectorRawValue == nil {
            restoredInspectorRawValue = showsInspector ? "visible" : "hidden"
        }
        if restoredAuxiliaryPanelRawValue == nil {
            restoredAuxiliaryPanelRawValue = auxiliaryPanel.rawValue
        }
    }

    func saveThreadRename() {
        guard let thread = renameThread else { return }
        let value = renameText
        renameThread = nil
        Task { _ = await conversation.renameThread(thread.threadId, title: value) }
    }
}
