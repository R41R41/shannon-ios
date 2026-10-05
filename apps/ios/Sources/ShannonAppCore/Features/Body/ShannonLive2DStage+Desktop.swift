import Foundation

/// What her desktop body on the Mac (A17) adds to the one stage: it shows the figure above every other place
/// (`ShannonLive2DHostPriority.desktop`), the page's touches go to the desktop body's own coordinator while it does
/// (it reports them as her full body), and while her window is small she may show her eyes alone (`body.small-eyes`)
/// without the owner's choice in 設定 › すがた › 体 being changed. Held here because the stage is one for the app.
@MainActor
final class ShannonLive2DDesktopLink {
    static let shared = ShannonLive2DDesktopLink()

    /// The desktop body's touch coordinator, for the page's touches while her desktop window shows the figure.
    var touch: (@MainActor (ShannonLive2DMessage) -> Void)?
    /// Her eyes alone while the desktop window is small; nil follows the owner's choice.
    var bodyOverride: ShannonLive2DBody?
}

extension ShannonLive2DStage {
    /// The body the page is asked for: the owner's choice, unless her desktop window is small.
    var wantedBody: ShannonLive2DBody { ShannonLive2DDesktopLink.shared.bodyOverride ?? .current() }

    /// Her desktop window's own body: `.eyes` while it is small and the owner wants her eyes alone then, nil otherwise.
    func setDesktopBodyOverride(_ body: ShannonLive2DBody?) {
        guard ShannonLive2DDesktopLink.shared.bodyOverride != body else { return }
        ShannonLive2DDesktopLink.shared.bodyOverride = body
        setBody(wantedBody)
    }

    /// The desktop body's coordinator receives the page's touches while her desktop window shows the figure.
    func setDesktopTouchHandler(_ handler: (@MainActor (ShannonLive2DMessage) -> Void)?) {
        ShannonLive2DDesktopLink.shared.touch = handler
    }

    /// Whether her desktop window is the place that shows the figure now.
    public var desktopShowsFigure: Bool { frontIsDesktop }
}
