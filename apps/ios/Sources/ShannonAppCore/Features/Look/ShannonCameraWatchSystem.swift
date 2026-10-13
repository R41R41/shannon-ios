import Foundation
#if canImport(UIKit)
import UIKit
#elseif canImport(AppKit)
import AppKit
#endif

/// The system's side of the watching conditions (Syzygy ADR-0011 §4.4), read at one moment.
public struct ShannonCameraWatchSystemFacts: Equatable, Sendable {
    public var appInFront: Bool
    public var unlocked: Bool
    public var lowPowerMode: Bool
    public var thermalHeavy: Bool

    public init(appInFront: Bool, unlocked: Bool, lowPowerMode: Bool, thermalHeavy: Bool) {
        self.appInFront = appInFront
        self.unlocked = unlocked
        self.lowPowerMode = lowPowerMode
        self.thermalHeavy = thermalHeavy
    }
}

/// Follows what closes the camera at once: the app leaving the front, the lock, a hidden or minimised window, Low Power
/// Mode, the thermal state and the owner's switch. `changed` is called on every such change; `reopened` when the app comes
/// back after being put away (iPhone: from the background; Mac: unhidden or a window restored from the Dock).
@MainActor
final class ShannonCameraWatchSystemMonitor {
    var changed: (@MainActor () -> Void)?
    var reopened: (@MainActor () -> Void)?
    private var observers: [(NotificationCenter, NSObjectProtocol)] = []
#if os(macOS)
    private let macState = ShannonDesktopBodyMacState()
#endif

    var facts: ShannonCameraWatchSystemFacts {
        let process = ProcessInfo.processInfo
        let heavy = process.thermalState == .serious || process.thermalState == .critical
#if os(iOS)
        let application = UIApplication.shared
        return ShannonCameraWatchSystemFacts(
            appInFront: application.applicationState == .active, unlocked: application.isProtectedDataAvailable,
            lowPowerMode: process.isLowPowerModeEnabled, thermalHeavy: heavy)
#elseif os(macOS)
        return ShannonCameraWatchSystemFacts(
            appInFront: Self.windowOnScreen(), unlocked: !macState.isLocked, lowPowerMode: process.isLowPowerModeEnabled, thermalHeavy: heavy)
#else
        return ShannonCameraWatchSystemFacts(appInFront: false, unlocked: false, lowPowerMode: false, thermalHeavy: heavy)
#endif
    }

#if os(macOS)
    /// One of Shannon's windows is on screen: the app is not hidden, and a window that can be main is visible, not
    /// minimised and not fully covered. Her desktop body's panel does not count (it cannot become main).
    static func windowOnScreen() -> Bool {
        let app = NSApplication.shared
        guard !app.isHidden else { return false }
        return app.windows.contains { $0.canBecomeMain && $0.isVisible && !$0.isMiniaturized && $0.occlusionState.contains(.visible) }
    }
#endif

    func start() {
        guard observers.isEmpty else { return }
        let center = NotificationCenter.default
        watch(center, ProcessInfo.thermalStateDidChangeNotification)
        watch(center, .NSProcessInfoPowerStateDidChange)
        watch(center, UserDefaults.didChangeNotification)
#if os(iOS)
        watch(center, UIApplication.didBecomeActiveNotification)
        watch(center, UIApplication.willResignActiveNotification)
        watch(center, UIApplication.didEnterBackgroundNotification)
        watch(center, UIApplication.protectedDataWillBecomeUnavailableNotification)
        watch(center, UIApplication.protectedDataDidBecomeAvailableNotification)
        watch(center, UIApplication.willEnterForegroundNotification, reopens: true)
#elseif os(macOS)
        for name in [NSApplication.didBecomeActiveNotification, NSApplication.didResignActiveNotification,
                     NSWindow.didMiniaturizeNotification, NSWindow.willCloseNotification, NSWindow.didChangeOcclusionStateNotification] {
            watch(center, name)
        }
        watch(center, NSApplication.didHideNotification)
        watch(center, NSApplication.didUnhideNotification, reopens: true)
        watch(center, NSWindow.didDeminiaturizeNotification, reopens: true)
        macState.changed = { [weak self] in self?.changed?() }
        macState.start()
#endif
    }

    func stop() {
        for (center, observer) in observers { center.removeObserver(observer) }
        observers = []
#if os(macOS)
        macState.stop()
        macState.changed = nil
#endif
    }

    private func watch(_ center: NotificationCenter, _ name: Notification.Name, reopens: Bool = false) {
        let observer = center.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
            // A closing window is still listed while it closes, and a state can lag its notice: read on the next turn.
            Task { @MainActor [weak self] in
                guard let self else { return }
                if reopens { self.reopened?() }
                self.changed?()
            }
        }
        observers.append((center, observer))
    }
}

extension ShannonCameraWatchEnvironment {
    /// The device as it is: the system monitor, the owner's switch, the system's camera answer and the watching camera.
    @MainActor public static var live: ShannonCameraWatchEnvironment {
        let monitor = ShannonCameraWatchSystemMonitor()
        return ShannonCameraWatchEnvironment(
            system: { monitor.facts },
            settingOn: { ShannonCameraWatchPreference.isEnabled() },
            // Only an answer the owner already gave: watching never asks for the camera.
            permission: { ShannonMediaPermission.currentVideoCapture() },
            camera: ShannonCameraWatchSession(),
            startMonitoring: { changed, reopened in
                monitor.changed = changed
                monitor.reopened = reopened
                monitor.start()
            },
            stopMonitoring: {
                monitor.stop()
                monitor.changed = nil
                monitor.reopened = nil
            }
        )
    }
}
