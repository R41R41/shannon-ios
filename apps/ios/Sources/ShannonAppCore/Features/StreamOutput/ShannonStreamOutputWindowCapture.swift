#if os(macOS)
import AppKit

/// While 配信用の出力（OBS） is on, the app's windows are left out of screen capture (owner decision 2026-10-06, A18 S5;
/// the Windows app did the same for its management window): Talk, 作業, 設定, the call and every sheet show the owner's
/// conversations and work, and a display or window capture in OBS would broadcast them. `NSWindow.sharingType = .none`
/// keeps a window out of screenshots and older capture methods; the owner still sees it. It is best effort only: since
/// macOS 15, ScreenCaptureKit (OBS's display capture) may ignore it, so 設定 › すがた asks the owner to capture the
/// browser source alone and to close Talk, 作業 and 設定 while live (`desktop.stream.whileOn`).
///
/// Her desktop body's window is left as it is. It shows her figure and her words in the bubble, which are already
/// worded for others while the stream output is on (her lines for him alone are not shown, the camera is not used), and
/// an owner who captures her window instead of the page should still see her. A window opened while it is on is covered
/// when it comes on screen; when it is turned off, only the windows this changed are given back their earlier setting.
@MainActor
final class ShannonStreamOutputWindowCapture {
    static let shared = ShannonStreamOutputWindowCapture()

    private(set) var isHiding = false
    private var changed: [ObjectIdentifier: (window: WeakWindow, previous: NSWindow.SharingType)] = [:]
    private var observers: [NSObjectProtocol] = []
    /// The app's windows; tests give their own.
    var windows: @MainActor () -> [NSWindow] = { NSApplication.shared.windows }

    private struct WeakWindow {
        weak var window: NSWindow?
    }

    /// Her desktop body stays capturable; every other window of the app is hidden.
    nonisolated static func hides(isDesktopBody: Bool) -> Bool { !isDesktopBody }

    static func hides(_ window: NSWindow) -> Bool {
        hides(isDesktopBody: window is ShannonDesktopBodyPanel)
    }

    func apply(hiding: Bool) {
        guard hiding != isHiding else { return }
        isHiding = hiding
        if hiding {
            windows().forEach(cover)
            let center = NotificationCenter.default
            // A window coming on screen changes its occlusion; one made key or main is surely there.
            for name in [NSWindow.didChangeOcclusionStateNotification, NSWindow.didBecomeKeyNotification, NSWindow.didBecomeMainNotification] {
                observers.append(center.addObserver(forName: name, object: nil, queue: .main) { [weak self] note in
                    let window = note.object as? NSWindow
                    MainActor.assumeIsolated { if let window { self?.cover(window) } }
                })
            }
        } else {
            observers.forEach(NotificationCenter.default.removeObserver)
            observers = []
            for entry in changed.values {
                entry.window.window?.sharingType = entry.previous
            }
            changed = [:]
        }
    }

    /// Leaves one window out of capture while hiding (her desktop body excepted).
    func cover(_ window: NSWindow) {
        guard isHiding, Self.hides(window), window.sharingType != .none else { return }
        changed[ObjectIdentifier(window)] = (WeakWindow(window: window), window.sharingType)
        window.sharingType = .none
    }
}
#endif
