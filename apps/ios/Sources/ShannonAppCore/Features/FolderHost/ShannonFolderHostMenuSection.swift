#if os(macOS)
import AppKit

/// Her folder's part of the app's one menu bar item (A18, owner decision 2026-10-06): while a folder is chosen the app
/// stays in the menu bar and keeps hosting, with or without a window. Its state, the pause, and the folder itself.
@MainActor
final class ShannonFolderHostMenuSection: ShannonDesktopMenuBarSection {
    private weak var model: ShannonFolderHostModel?

    init(model: ShannonFolderHostModel) {
        self.model = model
    }

    var wantsMenuBarItem: Bool { model?.isChosen ?? false }
    var menuBarButton: ShannonDesktopMenuBarButton? { nil }
    /// After her desktop body's part.
    var menuBarOrder: Int { 2 }

    func menuBarItems() -> [NSMenuItem] {
        guard let model, model.isChosen else { return [] }
        let paused = model.state == .paused
        return [
            ShannonDesktopMenuItem.caption(paused ? ShannonGeneratedStrings.folderHostMenuPaused : ShannonGeneratedStrings.folderHostMenuRunning),
            ShannonDesktopMenuItem(paused ? ShannonGeneratedStrings.folderHostResume : ShannonGeneratedStrings.folderHostPause, symbol: paused ? "play" : "pause") { [weak model] in
                model.map { $0.setPaused(!$0.isPaused) }
            },
            ShannonDesktopMenuItem(ShannonGeneratedStrings.folderHostOpen, symbol: "folder") { [weak model] in model?.openFolder() },
        ]
    }
}
#endif
