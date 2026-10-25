#if os(macOS)
import AppKit

/// The app's own part of its one menu bar item (information-architecture.md 8 #27; roadmap A17): her desktop body
/// shown or hidden, always on top, her size, the stream output (A18 S5), the four entries, and 終了. It wants the item for as long as the app runs;
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
        // 配信用の出力（OBS） and its address, as in the Windows tray (A18 S5).
        let output = body.streamOutput
        let stream = ShannonDesktopMenuItem(ShannonGeneratedStrings.desktopStreamTitle, state: output.isOn ? .on : .off) { [weak output] in
            output.map { $0.setOn(!$0.isOn) }
        }
        // 「声」 and 「耳」 (voice.speak-listen-pills, 2026-10-26): the same switches and words as the pills.
        let speaks = ShannonVoiceEar.speaks(), listens = ShannonVoiceEar.listens()
        let voiceOut = ShannonDesktopMenuItem(
            speaks ? ShannonGeneratedStrings.voiceOutOn : ShannonGeneratedStrings.voiceOutOff, state: speaks ? .on : .off
        ) { [weak self] in
            UserDefaults.standard.set(!ShannonVoiceEar.speaks(), forKey: ShannonVoiceEar.speaksKey)
            self?.refresh()
        }
        let ear = ShannonDesktopMenuItem(
            listens ? ShannonGeneratedStrings.voiceEarOn : ShannonGeneratedStrings.voiceEarOff, state: listens ? .on : .off
        ) { [weak self] in
            UserDefaults.standard.set(!ShannonVoiceEar.listens(), forKey: ShannonVoiceEar.listensKey)
            self?.refresh()
        }
        var items: [NSMenuItem] = [shown, onTop, size, stream, voiceOut, ear]
        // Only while the page is out (the menu enables every item that has an action, so it is left out otherwise).
        if output.state == .live {
            items.append(ShannonDesktopMenuItem(ShannonGeneratedStrings.desktopStreamCopyURL) { [weak output] in output?.copyPageURL() })
        }
        items.append(.separator())
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
