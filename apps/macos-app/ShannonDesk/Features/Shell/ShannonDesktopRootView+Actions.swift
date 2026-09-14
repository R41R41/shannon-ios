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
        if showsInspector, auxiliaryPanel == panel {
            showsInspector = false
        } else {
            showAuxiliaryPanel(panel)
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
            proxy.scrollTo(requestedMessageJumpID, anchor: .center)
            withAnimation(.easeOut(duration: 0.24)) {
                proxy.scrollTo(requestedConversationAnchorID, anchor: .top)
            }
            self.requestedConversationAnchorID = nil
            self.requestedMessageJumpID = nil
            return
        }
        if let requestedMessageJumpID,
           conversation.messages.contains(where: { $0.id == requestedMessageJumpID }) {
            withAnimation(.easeOut(duration: 0.24)) {
                proxy.scrollTo(requestedMessageJumpID, anchor: .center)
            }
            self.requestedMessageJumpID = nil
        } else if requestedMessageJumpID == nil, let id = conversation.messages.last?.id {
            withAnimation(.easeOut(duration: 0.2)) {
                proxy.scrollTo(id, anchor: .bottom)
            }
        }
    }

    func selectDestination(_ destination: DesktopDestination) {
        restoredDestinationRawValue = destination.rawValue
        lastDestinationRawValue = destination.rawValue
    }

    func requestAppleRelease(_ target: ShannonAppleReleaseTarget) {
        selectedTaskID = conversation.proposeAppleRelease(target)
        selectDestination(.development)
    }

    func focusThreadSearch() {
        selectDestination(.talk)
        focusedControl = .threadSearch
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
        showsInspector = ShannonDesktopWindowRestoration.inspectorVisible(
            sceneRawValue: restoredInspectorRawValue,
            lastValue: lastShowsInspector
        )
        if restoredInspectorRawValue == nil {
            restoredInspectorRawValue = showsInspector ? "visible" : "hidden"
        }
        auxiliaryPanel = ShannonDesktopWindowRestoration.auxiliaryPanel(
            sceneRawValue: restoredAuxiliaryPanelRawValue,
            lastRawValue: lastAuxiliaryPanelRawValue
        )
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
