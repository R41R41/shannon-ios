import SwiftUI
#if canImport(UIKit)
import UIKit
#elseif canImport(AppKit)
import AppKit
#endif
extension ShannonConversationView {
    func handleSelectedPageChange() {
        composerIsFocused = false
        voiceModel.cancel()
        realtimeVoiceModel.stop()
        showsLiveVoice = false
        guard selectedPage == .memory else { return }
        Task { await memoryModel.reload() }
    }

    func resetComposerTools() {
        composerAttachments = []
        composerUsesWebSearch = false
        composerAttachmentError = nil
    }

    func settleWorkspace(on page: ShannonWorkspacePage) {
        let changed = page != selectedPage
        composerIsFocused = false
        withAnimation(reduceMotion ? nil : .snappy(duration: 0.34, extraBounce: 0.04)) {
            selectedPage = page
        }
        if changed { ShannonHaptics.page() }
    }

    func openThreadDrawer() {
        composerIsFocused = false
        showsThreadList = true
    }

    func createThreadFromHeader() {
        composerIsFocused = false
        settleWorkspace(on: .talk)
        Task { await model.createThread(title: nil) }
    }

    func openTalkFromDrawer() {
        settleWorkspace(on: .talk)
        closeThreadDrawer()
        Task { await model.acknowledgeVisibleInitiatives() }
    }

    func openMemoryFromDrawer() {
        settleWorkspace(on: .memory)
        closeThreadDrawer()
    }

    func openWorkFromDrawer() {
        settleWorkspace(on: .work)
        closeThreadDrawer()
        Task { await model.synchronizeAgentTasks() }
    }

    func openSettingsFromDrawer() {
        closeThreadDrawer()
        openSettings()
    }

    func openAgentTaskFromDrawer(_ id: UUID) {
        closeThreadDrawer()
        openAgentTask(id)
    }

    func openSettings() {
        composerIsFocused = false
        showsSettings = true
        ShannonHaptics.page()
    }

    func closeThreadDrawer() {
        showsThreadList = false
    }

    func syncAppIconBadge(with count: Int) {
#if canImport(UIKit)
        let clamped = min(max(0, count), 99)
        UIApplication.shared.applicationIconBadgeNumber = clamped
#endif
    }

    func refreshAppIconAtNextDeadline() async {
        guard let refreshAt = appIconModel.nextRefreshAt else { return }
        let delay = max(0, refreshAt.timeIntervalSinceNow)
        try? await Task.sleep(for: .seconds(delay))
        guard !Task.isCancelled else { return }
        await appIconModel.updateAutomatically(for: model.currentExpression)
    }

}
