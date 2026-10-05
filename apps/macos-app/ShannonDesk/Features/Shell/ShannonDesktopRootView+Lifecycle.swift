import AppKit
import ShannonAppCore
import SwiftUI

/// What the window loads at start, polls while connected, and keeps restorable as it changes.
extension ShannonDesktopRootView {
    func observingWindowState<Content: View>(_ content: Content) -> some View {
        content
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
                }
            }
            .onReceive(NotificationCenter.default.publisher(for: .shannonYousuLinkOpened)) { _ in
                openPendingYousuLink()
            }
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
