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
        guard selectedPage == .shannon else {
            // Leaving 「シャノン」 closes what was pushed there, so that it opens on its card next time.
            hubShowsYousu = false
            return
        }
        Task { await memoryModel.reload() }
    }

    /// Leaving the app ends dictation, never a voice conversation: that goes on in the background
    /// and ends by itself after `ShannonVoiceBackgroundSilence.limit` of silence.
    func handleScenePhaseChange() {
        if scenePhase != .active {
            voiceModel.cancel()
        } else {
            // Another device, or the worker, may have recorded captures while this one was away.
            Task { await model.refreshCaptures() }
            // A reply whose stream iOS cut while the app was away was finished by the server: show it from the Talk.
            Task { await model.resumeInterruptedReplies() }
        }
#if os(iOS)
        switch scenePhase {
        case .background:
            // The camera is a foreground feature; a photo already taken stays for when he returns.
            voiceWorkspace.showsCamera = false
            geminiLiveVoiceModel.sceneDidEnterBackground()
        case .active:
            geminiLiveVoiceModel.sceneDidBecomeActive()
        default:
            break
        }
#endif
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

    func openShannonFromThreadList() {
        settleWorkspace(on: .shannon)
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
