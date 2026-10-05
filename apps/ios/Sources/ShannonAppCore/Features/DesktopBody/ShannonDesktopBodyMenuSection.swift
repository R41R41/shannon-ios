#if os(macOS)
import AppKit

/// The app's own part of its one menu bar item (information-architecture.md 8 #27; roadmap A17): her desktop body
/// shown or hidden, always on top, her size, the four entries, and 終了. It wants the item for as long as the app runs;
/// the voice call's part (A16) is the first section while a call is on and no window is on screen.
@MainActor
final class ShannonDesktopBodyMenuSection: ShannonDesktopMenuBarSection {
    private weak var body: ShannonDesktopBody?
    private weak var menuBar: ShannonDesktopMenuBar?

    init(body: ShannonDesktopBody, menuBar: ShannonDesktopMenuBar) {
        self.body = body
        self.menuBar = menuBar
    }

    var wantsMenuBarItem: Bool { body != nil }
    /// The item's plain mark; the call shows its own while it is in the menu bar.
    var menuBarButton: ShannonDesktopMenuBarButton? { nil }
    var menuBarOrder: Int { 1 }

    func menuBarItems() -> [NSMenuItem] {
        guard let body else { return [] }
        let shown = ShannonDesktopMenuItem(
            body.isShown ? ShannonGeneratedStrings.desktopBodyHide : ShannonGeneratedStrings.desktopBodyShow, symbol: "figure.stand"
        ) { [weak body] in body.map { $0.setShown(!$0.isShown) } }
        let onTop = ShannonDesktopMenuItem(ShannonGeneratedStrings.desktopBodyAlwaysOnTop, state: body.alwaysOnTop ? .on : .off) { [weak body] in
            body.map { $0.setAlwaysOnTop(!$0.alwaysOnTop) }
        }
        let size = NSMenuItem(title: ShannonGeneratedStrings.desktopBodySizeNow(percent: String(Int((body.scale * 100).rounded()))), action: nil, keyEquivalent: "")
        let sizes = NSMenu()
        for preset in ShannonDesktopBodyGeometry.presets {
            sizes.addItem(ShannonDesktopMenuItem(
                ShannonDesktopBodySizeCopy.title(preset), state: ShannonDesktopBodyGeometry.nearestPreset(body.scale) == preset ? .on : .off
            ) { [weak body] in body?.setScale(preset) })
        }
        sizes.addItem(.separator())
        sizes.addItem(ShannonDesktopMenuItem.caption(ShannonGeneratedStrings.desktopBodySizeHint))
        size.submenu = sizes
        var items: [NSMenuItem] = [shown, onTop, size, .separator()]
        for entry in ShannonDesktopEntry.allCases {
            items.append(ShannonDesktopMenuItem(entry.title) { [weak body] in body?.open(entry) })
        }
        items.append(.separator())
        items.append(ShannonDesktopMenuItem(ShannonGeneratedStrings.desktopBodyQuit) { NSApplication.shared.terminate(nil) })
        return items
    }

    func refresh() { menuBar?.refresh() }
}

/// 「100%（ふつう）」 and the other sizes.
enum ShannonDesktopBodySizeCopy {
    static func title(_ scale: Double) -> String {
        scale == 1 ? ShannonGeneratedStrings.desktopBodySizeNormal : "\(Int((scale * 100).rounded()))%"
    }
}
#endif
