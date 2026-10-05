import AppKit
import ShannonAppCore
import SwiftUI

extension ShannonDesktopRootView {
    var figureIsInFront: Bool {
        destination == .talk && showsInspector && auxiliaryPanel == .figure && !figureCovers.isAny
    }

    var figureCovers: DesktopFigureCovers {
        DesktopFigureCovers(
            connection: showsConnection, worldSubscriptions: showsWorldSubscriptions, appIcon: showsAppIconSettings,
            stateDetails: showsStateDetails, addProject: showsAddAgentProject,
            taskStopConfirmation: taskStopConfirmation != nil, rename: renameThread != nil,
            fromViews: bodyModel.isCoveredByAView
        )
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
                    if !voiceCall.session.hidesOwnerScreens {
                        ShannonDesktopNotifier.shared.update(desktopNotices, readSucceeded: noticesReadSucceeded)
                    }
                    openNotificationTarget()
                }
                restoreSelectedTaskIfAvailable()
#if DEBUG
                await runNavigationSmokeIfAsked()
#endif
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
            // Keyed on the connection too, so disconnecting stops the loop at once.
            .task(id: "\(connection.isConnected)|\(conversation.agentTaskPollingKey)") {
                guard connection.isConnected, !conversation.isDesignPreview,
                      !conversation.agentTaskPollingKey.isEmpty else { return }
                while !Task.isCancelled {
                    do { try await Task.sleep(for: .seconds(10)) } catch { return }
                    await conversation.synchronizeAgentTasks()
                }
            }
            .onChange(of: desktopNoticeKeys) {
                // 「友人も一緒」: what she or the work says is held until the period ends (and posted then).
                guard connection.isConnected, !conversation.isDesignPreview, !voiceCall.session.hidesOwnerScreens else { return }
                ShannonDesktopNotifier.shared.update(desktopNotices, readSucceeded: noticesReadSucceeded)
            }
            // The first successful read after a failed one may be what takes the baseline.
            .onChange(of: noticesReadSucceeded) {
                guard noticesReadSucceeded, !conversation.isDesignPreview, !voiceCall.session.hidesOwnerScreens else { return }
                ShannonDesktopNotifier.shared.update(desktopNotices, readSucceeded: true)
            }
            .onChange(of: voiceCall.session.hidesOwnerScreens) {
                guard !voiceCall.session.hidesOwnerScreens, connection.isConnected, !conversation.isDesignPreview else { return }
                ShannonDesktopNotifier.shared.update(desktopNotices, readSucceeded: noticesReadSucceeded)
            }
            .onReceive(NotificationCenter.default.publisher(for: .shannonDesktopNotificationOpened)) { _ in
                openNotificationTarget()
            }
            .onReceive(NotificationCenter.default.publisher(for: .shannonYousuLinkOpened)) { _ in
                openPendingYousuLink()
            }
            // トークに戻る from the call in the menu bar (A16, option B).
            // Only in the window the call brought back (with none named, every window).
            .onReceive(NotificationCenter.default.publisher(for: .shannonDesktopReturnToTalk)) { note in
                if let target = note.object as? NSWindow, let mine = hostWindow.window, target !== mine { return }
                selectDestination(.talk)
            }
            .background(DesktopWindowReader(box: hostWindow) { window in voiceCall.window(window, hosts: windowID) })
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

/// The window a root view is in, so that a request meant for one window is answered there only.
final class DesktopWindowBox {
    weak var window: NSWindow?
}

struct DesktopWindowReader: NSViewRepresentable {
    let box: DesktopWindowBox
    /// Told the window whenever it is found or changes.
    var found: (NSWindow?) -> Void = { _ in }

    func makeNSView(context: Context) -> NSView {
        let view = NSView()
        DispatchQueue.main.async { [weak view] in
            box.window = view?.window
            found(view?.window)
        }
        return view
    }

    func updateNSView(_ nsView: NSView, context: Context) {
        guard box.window !== nsView.window else { return }
        box.window = nsView.window
        found(nsView.window)
    }
}
