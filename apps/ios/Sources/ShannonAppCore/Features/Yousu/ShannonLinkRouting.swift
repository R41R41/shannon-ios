import SwiftUI

/// What a link moves out of the way so that its place is what the owner sees. Pure, so it can be tested.
/// - A call screen, wherever it is shown, is never covered or closed: the link waits until it is minimised
///   or the call ends. So does anything else up that a link cannot close itself (a sheet from her words,
///   a picker, the camera explanation, a page inside Settings): every cover of `ShannonDialogueCovers`
///   other than the thread list, Settings and a work task makes it wait.
/// - ようす (「シャノン › ようす」) is a page of the workspace: the thread list, Settings and a work task close.
/// - 運用 is in Settings: the thread list and a work task close, and Settings comes up once they have gone.
struct ShannonLinkRoute: Equatable {
    var waits = false
    var closesThreadList = false
    var closesSettings = false
    var closesWorkTask = false
    /// The place opens on the next try, once what was closed has finished leaving.
    var opensAfterClosing = false

    static func make(
        _ request: ShannonYousuLink.Request, covers: ShannonDialogueCovers, callScreenElsewhere: Bool, settingsDetail: Bool
    ) -> Self {
        var others = covers
        others.threadList = false
        others.settings = false
        others.workTask = false
        guard !others.isAny, !callScreenElsewhere, !(covers.settings && settingsDetail) else { return Self(waits: true) }
        switch request {
        case .yousu:
            return Self(closesThreadList: covers.threadList, closesSettings: covers.settings, closesWorkTask: covers.workTask)
        case .ops:
            return Self(
                closesThreadList: covers.threadList, closesWorkTask: covers.workTask,
                opensAfterClosing: !covers.settings && (covers.threadList || covers.workTask)
            )
        }
    }
}

/// A link that waits. It is dropped once it is a few minutes old: by then it is not what he asked for now.
struct ShannonDeferredLink: Equatable, Sendable {
    let request: ShannonYousuLink.Request
    let since: Date

    static let lifetime: TimeInterval = 180

    func isStale(at now: Date) -> Bool { now.timeIntervalSince(since) > Self.lifetime }
}

/// What a waiting link watches: it tries again whenever any of this changes.
struct ShannonLinkRetryKey: Equatable {
    var pending: ShannonDeferredLink?
    var covers: ShannonDialogueCovers
    var callScreenElsewhere: Bool
    var settingsDetail: Bool
}

extension ShannonConversationView {
    /// A call screen shown from inside Settings, the thread list or a work task (each has its own).
    var callScreenElsewhere: Bool {
#if os(iOS)
        voiceWorkspace.callScreenIsUp
#else
        false
#endif
    }

    /// A sheet of Settings' own is over it.
    var settingsDetailIsUp: Bool {
        showsStateDetails || showsConnectionDetails || showsConnectedDevices || showsAppIconSettings
            || showsAppearanceSettings || showsTestFlightDelivery || showsVoiceDiagnostics || showsWorldSubscriptions
    }

    var linkRetryKey: ShannonLinkRetryKey {
        ShannonLinkRetryKey(
            pending: deferredLink, covers: dialogueCovers, callScreenElsewhere: callScreenElsewhere, settingsDetail: settingsDetailIsUp
        )
    }

    /// Opens the place of a link, or lets it wait (`ShannonLinkRoute`).
    func openLink(_ request: ShannonYousuLink.Request, since: Date = Date()) {
        let link = ShannonDeferredLink(request: request, since: since)
        guard !link.isStale(at: Date()) else {
            deferredLink = nil
            return
        }
        let route = ShannonLinkRoute.make(
            request, covers: dialogueCovers, callScreenElsewhere: callScreenElsewhere, settingsDetail: settingsDetailIsUp
        )
        if route.waits {
            deferredLink = link
            return
        }
        composerIsFocused = false
        if route.closesThreadList { showsThreadList = false }
        if route.closesSettings { showsSettings = false }
        if route.closesWorkTask { selectedAgentTaskID = nil }
        // A cover cannot come up while another is leaving: the place opens on the next try.
        if route.opensAfterClosing {
            deferredLink = link
            return
        }
        deferredLink = nil
        switch request {
        case .yousu:
            settleWorkspace(on: .shannon)
            hubShowsYousu = true
        case .ops:
            let wasOpen = showsSettings
            showsSettings = true
            settingsShowsOps = true
            if !wasOpen { confirmSettingsCameUp(link) }
        }
    }

    /// Tries a waiting link again once what is on screen has settled. Cancelled (and started anew) by any change.
    func retryDeferredLink() async {
        guard deferredLink != nil else { return }
        do { try await Task.sleep(for: .milliseconds(600)) } catch { return }
        guard let link = deferredLink else { return }
        deferredLink = nil
        openLink(link.request, since: link.since)
    }

    /// Settings was asked for but did not come up (something came over the workspace meanwhile): it is not
    /// left asked for, so the 設定 button keeps working and her figure is not held covered; the link waits again.
    private func confirmSettingsCameUp(_ link: ShannonDeferredLink) {
        Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(1_500))
            guard showsSettings, !settingsIsOnScreen else { return }
            showsSettings = false
            deferredLink = link
        }
    }
}
