import SwiftUI
#if canImport(UIKit)
import UIKit
import UserNotifications
#elseif canImport(AppKit)
import AppKit
#endif
extension ShannonConversationView {
    func handleSelectedPageChange() {
        composerIsFocused = false
        voiceModel.cancel()
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

    func openThreadList() {
        composerIsFocused = false
        showsThreadList = true
    }

    func createThreadFromHeader() {
        composerIsFocused = false
        settleWorkspace(on: .talk)
        Task { await model.createThread(title: nil) }
    }

    func openTalkFromThreadList() {
        settleWorkspace(on: .talk)
        closeThreadList()
        Task { await model.acknowledgeVisibleInitiatives() }
    }

    func openMemoryFromThreadList() {
        settleWorkspace(on: .memory)
        closeThreadList()
    }

    func openWorkFromThreadList() {
        settleWorkspace(on: .work)
        closeThreadList()
        Task { await model.synchronizeAgentTasks() }
    }

    func openSettingsFromThreadList() {
        closeThreadList()
        openSettings()
    }

    func openAgentTaskFromThreadList(_ id: UUID) {
        closeThreadList()
        openAgentTask(id)
    }

    func openSettings() {
        composerIsFocused = false
        showsSettings = true
        ShannonHaptics.page()
    }

    func closeThreadList() {
        showsThreadList = false
    }

    func syncAppIconBadge(with count: Int) {
#if canImport(UIKit)
        let clamped = min(max(0, count), 99)
        Task { try? await UNUserNotificationCenter.current().setBadgeCount(clamped) }
#endif
    }

}
