import Foundation
#if os(iOS)
import UIKit
#endif

/// What the stage keeps between two screens that show her (owner request 2026-10-14: ボット → ガール took the
/// Live2D page's whole load every time). Loading the page is a second or two of work on the phone: the 26 MB
/// `assets.js` is parsed, the model and three large textures are decoded and uploaded (measured with the same
/// WebKit on an A18 Pro: about 1.1–1.9 s warm, about 0.5 s of it the 4096 × 4096 texture alone). The page used to be
/// let go 90 s after the last screen showing her went away, so switching back from the Waterlight form, reading the
/// conversation for a while, or coming back from another tab paid all of it again.
///
/// On the iPhone a loaded page is now kept, paused, in a parking place behind the app's window
/// (`ShannonLive2DParkingView`): with the Live2D form chosen until memory runs short, with the Waterlight form for
/// `ShannonLive2DStagePolicy.keepInOtherFormSeconds`. When the owner chooses the Live2D form, or Talk appears with
/// it chosen, the page is loaded there ahead of the screen (`follow(form:launching:)`). The Mac is unchanged.
struct ShannonLive2DKeep {
    var warmTask: Task<Void, Never>?
#if os(iOS)
    /// Held by the window it was put in.
    weak var parking: ShannonLive2DParkingView?
#endif
}

extension ShannonLive2DStage {
    /// Whether this platform keeps a page nobody sees in a parking place (the iPhone).
    static var parks: Bool {
#if os(iOS)
        true
#else
        false
#endif
    }

    /// Talk's root follows the owner's form here: when it appears (`launching`) and whenever the form changes.
    /// With the Live2D form chosen the page is loaded ahead of the screen that will show her; with either form the time
    /// a page nobody sees is kept is set again. Nothing is fetched: the page is bundled and makes no request.
    func follow(form: ShannonForm, launching: Bool) {
        guard Self.parks, Self.isAvailable else { return }
        observeSystem()
        scheduleRelease()
        keep.warmTask?.cancel()
        keep.warmTask = nil
        let reason: ShannonLive2DStagePolicy.Warming = launching ? .launch : .chosen
        guard ShannonLive2DStagePolicy.warmsAhead(form: form, status: status, hasHosts: hasHosts, reason: reason, lowPower: lowPower) else { return }
        let delay = launching ? ShannonLive2DStagePolicy.launchWarmDelaySeconds : 0
        keep.warmTask = Task { [weak self] in
            // Also on the owner's choice the warming waits for the next turn: a screen that shows her at once loads it itself.
            try? await Task.sleep(for: .seconds(delay))
            guard !Task.isCancelled, let self, self.status == .unloaded, !self.hasHosts, self.appActive,
                  ShannonForm.current() == .live2d, self.hasParkingPlace else { return }
            NSLog("[ShannonBody] loading the Live2D page ahead of a screen (%@)", launching ? "launch" : "chosen")
            self.load()
            self.mount() // no screen yet: it waits in the parking place
            self.scheduleRelease()
        }
    }

    /// Lets a page nobody sees go after the time the form allows (`ShannonLive2DStagePolicy.keepSeconds`); a screen
    /// that shows her again before then cancels it (`attach`). A memory warning lets it go at once (`memoryWarning`).
    func scheduleRelease() {
        releaseTask?.cancel()
        releaseTask = nil
        guard !hasHosts, status != .unloaded,
              let seconds = ShannonLive2DStagePolicy.keepSeconds(formIsLive2D: ShannonForm.current() == .live2d, parks: Self.parks)
        else { return }
        releaseTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(seconds))
            guard !Task.isCancelled, let self, !self.hasHosts else { return }
            NSLog("[ShannonBody] letting the Live2D page go after %.0f s unseen", seconds)
            self.release()
        }
    }

    /// No screen shows her: on the iPhone the page waits paused in the parking place, elsewhere it leaves the screen.
    func park() {
        guard let webView else { return }
#if os(iOS)
        if let place = parkingPlace() {
            guard webView.superview !== place else { return }
            webView.removeFromSuperview()
            webView.frame = place.bounds
            webView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
            place.addSubview(webView)
            return
        }
#endif
        webView.removeFromSuperview()
    }

    private var hasParkingPlace: Bool {
#if os(iOS)
        parkingPlace() != nil
#else
        false
#endif
    }

#if os(iOS)
    /// The parking place in the app's front window, made once per window.
    private func parkingPlace() -> ShannonLive2DParkingView? {
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        let scene = scenes.first { $0.activationState == .foregroundActive } ?? scenes.first
        guard let window = scene?.windows.first(where: \.isKeyWindow) ?? scene?.windows.first else { return nil }
        if let parking = keep.parking, parking.window === window { return parking }
        keep.parking?.removeFromSuperview()
        let parking = ShannonLive2DParkingView(frame: window.bounds)
        window.insertSubview(parking, at: 0)
        keep.parking = parking
        return parking
    }
#endif
}

#if os(iOS)
/// Where the page waits while no screen shows her: behind every other view of the app's window, invisible, and out
/// of reach of touches and VoiceOver. In a window the page's process stays awake enough to finish loading ahead of a
/// screen and is not suspended between two screens; it draws nothing there (`setPaused(true)`).
final class ShannonLive2DParkingView: UIView {
    override init(frame: CGRect) {
        super.init(frame: frame)
        alpha = 0
        backgroundColor = .clear
        isOpaque = false
        isUserInteractionEnabled = false
        isAccessibilityElement = false
        accessibilityElementsHidden = true
        autoresizingMask = [.flexibleWidth, .flexibleHeight]
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? { nil }
}
#endif
