import Foundation

/// Her body in the Live2D form: the character or her eyes alone (設定 › すがた › 体, owner decision 2026-10-05).
/// The page is started in the chosen body (`ShannonLive2DStagePolicy.pageURL`); these follow a later choice.
extension ShannonLive2DStage {

    /// A body the page has not shown yet is loaded first; until the page says `body`, the other one stays.
    public func setBody(_ value: ShannonLive2DBody) {
        desiredBody = value
        guard status == .ready, body != value else { return }
        noteActivity()
        send(.setBody(value))
    }

    /// The page's own calm (`setIdle`) reaches only the character: the eyes blink and sway as part of their motion,
    /// so with her eyes alone an idle figure is paused to rest as a page without that calm would be.
    var pageCalms: Bool { calmsInPage && body.hasCharacterRig }

    /// The page switched its body. What the app decides is said again for the new one, and a choice made
    /// while the switch was under way is followed.
    func bodyChanged(to body: ShannonLive2DBody) {
        self.body = body
        // The character's mouth is closed whichever way the switch went; her eyes have none.
        lastMouthLevel = 0
        if body.hasCharacterRig { send(.setMouthLevel(0)) }
        applyHost()
        applyCalm()
        noteActivity()
        if body != desiredBody { send(.setBody(desiredBody)) }
    }
}
