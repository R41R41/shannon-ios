import AppKit
import ShannonAppCore
import SwiftUI

extension ShannonDesktopRootView {
    var figureIsInFront: Bool {
        destination == .talk && showsInspector && auxiliaryPanel == .figure
            && !showsConnection && !showsWorldSubscriptions && !showsAppIconSettings
            && !showsStateDetails && !showsAddAgentProject
    }
}

/// What the window loads at start, polls while connected, and keeps restorable as it changes.
extension ShannonDesktopRootView {
    func observingWindowState<Content: View>(_ content: Content) -> some View {
        restoringWindowState(content)
            .task {
                restoreWindowChromeIfAvailable()
                if connection.isConnected && !conversation.isDesignPreview {
                    await connection.verifyConnection()
                }
                await conversation.loadConversationIfNeeded()
                await restoreSelectedThreadIfAvailable()
                if !conversation.isDesignPreview {
                    await conversation.synchronizeAgentTasks()
                    await conversation.refreshAgentWorkspace(projectHint: selectedAgentProject)
                    await conversation.refreshAgentProjectProvisioning()
                    await conversation.refreshInitiatives()
                    await ShannonDesktopNotifier.shared.start()
                    ShannonDesktopNotifier.shared.update(desktopNotices)
                    openNotificationTarget()
                }
                restoreSelectedTaskIfAvailable()
            }
            .task(id: connection.isConnected) {
                guard connection.isConnected, !conversation.isDesignPreview else { return }
                while !Task.isCancelled {
                    try? await Task.sleep(for: .seconds(60))
                    guard !Task.isCancelled else { return }
                    await conversation.refreshInitiatives()
                    await conversation.refreshCaptures()
                    // A permission asked for, or a result, reaches the notifications within a minute (A13).
                    await conversation.synchronizeAgentTasks()
                }
            }
            // Running work is read more often, so its approval or result is not a minute late.
            .task(id: conversation.agentTaskPollingKey) {
                guard connection.isConnected, !conversation.isDesignPreview,
                      !conversation.agentTaskPollingKey.isEmpty else { return }
                while !Task.isCancelled {
                    do { try await Task.sleep(for: .seconds(10)) } catch { return }
                    await conversation.synchronizeAgentTasks()
                }
            }
            .onChange(of: desktopNoticeKeys) {
                // Only after the first full read, so a first launch remembers what is there without showing it.
                guard ShannonDesktopNotifier.shared.isWatching, connection.isConnected else { return }
                ShannonDesktopNotifier.shared.update(desktopNotices)
            }
            .onReceive(NotificationCenter.default.publisher(for: .shannonDesktopNotificationOpened)) { _ in
                openNotificationTarget()
            }
            .onReceive(NotificationCenter.default.publisher(for: .shannonYousuLinkOpened)) { _ in
                openPendingYousuLink()
            }
    }

    /// Keeps what a window restores current as the selection changes.
    func restoringWindowState<Content: View>(_ content: Content) -> some View {
        content
            // Her figure is what the owner sees: Talk with the 「すがた」 panel open and no sheet over the window.
            .onChange(of: figureIsInFront, initial: true) { bodyModel.setFigureIsInFront(figureIsInFront) }
            .onChange(of: conversation.agentTasks.map(\.id)) {
                restoreSelectedTaskIfAvailable()
            }
            .onChange(of: selectedTaskID) {
                steeringText = ""
                if let selectedTaskID {
                    restoredTaskID = selectedTaskID.uuidString
                    lastRestoredTaskID = selectedTaskID.uuidString
                }
            }
            .onChange(of: conversation.selectedThreadId) {
                restoredThreadID = conversation.selectedThreadId
                lastRestoredThreadID = conversation.selectedThreadId ?? ""
                activeConversationOutlineEntryID = nil
            }
            .onChange(of: showsInspector) {
                restoredInspectorRawValue = showsInspector ? "visible" : "hidden"
                lastShowsInspector = showsInspector
            }
            .onChange(of: auxiliaryPanel) {
                restoredAuxiliaryPanelRawValue = auxiliaryPanel.rawValue
                lastAuxiliaryPanelRawValue = auxiliaryPanel.rawValue
            }
            .onChange(of: selectedAgentProject) {
                selectedDevelopmentFilePath = nil
                developmentWorkspaceResource = .idle
                guard !conversation.isDesignPreview else { return }
                Task { await conversation.refreshAgentWorkspace(projectHint: selectedAgentProject) }
            }
            .onChange(of: agentHostPreferenceRawValue) {
                normalizeDevelopmentSelection()
            }
            .onChange(of: conversation.agentWorkspace) {
                normalizeDevelopmentSelection()
            }
            .onChange(of: selectedDevelopmentTool) {
                developmentWorkspaceResource = .idle
            }
    }
}
