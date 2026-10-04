import SwiftUI

/// What a link moves out of the way so that its place is what the owner sees. Pure, so it can be tested.
/// The rules are few on purpose:
/// - A link closes only the thread list and a work task. Anything else that is up makes it wait until it is
///   gone: a call screen wherever it is shown, any other cover of `ShannonDialogueCovers` (a sheet from her
///   words, a picker, the camera explanation), and for ようす, Settings itself, whatever is open inside it
///   (a page, a confirmation): a link never closes Settings.
/// - ようす (「シャノン › ようす」) is a page of the workspace: it opens once the thread list and a work task are closed.
/// - 運用 is in Settings: with Settings open it is pushed inside it; otherwise Settings comes up, after what
///   was closed has finished leaving.
struct ShannonLinkRoute: Equatable {
    var waits = false
    var closesThreadList = false
    var closesWorkTask = false
    /// The place opens on the next try, once what was closed has finished leaving.
    var opensAfterClosing = false

    static func make(_ request: ShannonYousuLink.Request, covers: ShannonDialogueCovers, callScreenElsewhere: Bool) -> Self {
        var others = covers
        others.threadList = false
        others.settings = false
        others.workTask = false
        guard !others.isAny, !callScreenElsewhere else { return Self(waits: true) }
        switch request {
        case .yousu:
            guard !covers.settings else { return Self(waits: true) }
            return Self(closesThreadList: covers.threadList, closesWorkTask: covers.workTask)
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

    var linkRetryKey: ShannonLinkRetryKey {
        ShannonLinkRetryKey(pending: deferredLink, covers: dialogueCovers, callScreenElsewhere: callScreenElsewhere)
    }

    /// Opens the place of a link, or lets it wait (`ShannonLinkRoute`).
    func openLink(_ request: ShannonYousuLink.Request, since: Date = Date()) {
        let link = ShannonDeferredLink(request: request, since: since)
        guard !link.isStale(at: Date()) else {
            deferredLink = nil
            return
        }
        let route = ShannonLinkRoute.make(request, covers: dialogueCovers, callScreenElsewhere: callScreenElsewhere)
        if route.waits {
            deferredLink = link
            return
        }
        composerIsFocused = false
        if route.closesThreadList { showsThreadList = false }
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
            settingsShowsOps = true
            guard !showsSettings else { return }
            showsSettings = true
            checkSettingsCameUp()
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

    /// One try: if Settings, asked for by this link, has not come up (something unseen was over the workspace),
    /// it is not left asked for, so the 設定 button keeps working, and the link is dropped. The request's own
    /// token is cleared when Settings appears or closes, so this never touches a Settings he opened himself.
    private func checkSettingsCameUp() {
        let token = UUID()
        settingsLinkRequest = token
        Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(1_500))
            guard settingsLinkRequest == token else { return }
            settingsLinkRequest = nil
            showsSettings = false
        }
    }
}
