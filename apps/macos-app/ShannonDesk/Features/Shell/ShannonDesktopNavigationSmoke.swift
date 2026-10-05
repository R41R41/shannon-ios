#if DEBUG
import Foundation
import ShannonAppCore

/// `-ShannonDesignPreview -ShannonPreviewNavigationSmoke`: the design preview walks, by itself, through
/// the places where the main thread once hung under an accessibility client (2026-10-05, review of A10–A15):
/// シャノン with the 「すがた」 panel asked for, then 設定 (its 外観 too), 作業 and Talk, over and over.
/// `scripts/smoke-macos-navigation.sh` runs it with an accessibility client reading the window and fails
/// when a step stops being reached or the process stays busy. Nothing of it exists in a release build.
extension ShannonDesktopRootView {
    func runNavigationSmokeIfAsked() async {
        guard conversation.isDesignPreview,
              ProcessInfo.processInfo.arguments.contains("-ShannonPreviewNavigationSmoke") else { return }
        let steps: [(DesktopDestination, String?)] = [
            (.shannon, nil), (.settings, DesktopSettingsPage.appearance.rawValue), (.shannon, nil),
            (.work, nil), (.settings, DesktopSettingsPage.ops.rawValue), (.talk, nil),
        ]
        try? await Task.sleep(for: .seconds(3))
        for round in 0..<8 {
            for (destination, settingsPage) in steps {
                guard !Task.isCancelled else { return }
                // Ask for her panel everywhere, as a window that had it open beside Talk does.
                auxiliaryPanel = .figure
                showsInspector = true
                if let settingsPage { settingsPageRawValue = settingsPage }
                selectDestination(destination)
                print("navigation-smoke: \(round) \(destination.rawValue)")
                fflush(stdout)
                try? await Task.sleep(for: .milliseconds(700))
            }
        }
        print("navigation-smoke: done")
        fflush(stdout)
    }
}
#endif
