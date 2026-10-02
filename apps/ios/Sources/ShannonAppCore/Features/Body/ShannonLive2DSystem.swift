import Foundation
#if canImport(UIKit)
import UIKit
#elseif canImport(AppKit)
import AppKit
#endif

/// What the system tells the Live2D stage: Reduce Motion, Low Power Mode, whether the app is in
/// front, and a memory warning. Observed once, for the life of the app (the stage is a singleton).
@MainActor
enum ShannonLive2DSystem {
    enum Change: Sendable {
        case reduceMotion(Bool)
        case lowPower(Bool)
        case active(Bool)
        case memoryWarning
    }

    static var current: (reduceMotion: Bool, lowPower: Bool, appActive: Bool) {
        let lowPower = ProcessInfo.processInfo.isLowPowerModeEnabled
#if canImport(UIKit)
        return (UIAccessibility.isReduceMotionEnabled, lowPower, UIApplication.shared.applicationState == .active)
#elseif canImport(AppKit)
        return (NSWorkspace.shared.accessibilityDisplayShouldReduceMotion, lowPower, !NSApplication.shared.isHidden)
#else
        return (false, lowPower, true)
#endif
    }

    static func observe(_ handler: @escaping @MainActor @Sendable (Change) -> Void) {
        let center = NotificationCenter.default
        func watch(_ name: Notification.Name, in center: NotificationCenter = center, _ change: @escaping @MainActor @Sendable () -> Change) {
            center.addObserver(forName: name, object: nil, queue: .main) { _ in
                Task { @MainActor in handler(change()) }
            }
        }
        watch(.NSProcessInfoPowerStateDidChange) { .lowPower(ProcessInfo.processInfo.isLowPowerModeEnabled) }
#if canImport(UIKit)
        watch(UIAccessibility.reduceMotionStatusDidChangeNotification) { .reduceMotion(UIAccessibility.isReduceMotionEnabled) }
        watch(UIApplication.willResignActiveNotification) { .active(false) }
        watch(UIApplication.didBecomeActiveNotification) { .active(true) }
        watch(UIApplication.didReceiveMemoryWarningNotification) { .memoryWarning }
#elseif canImport(AppKit)
        watch(NSWorkspace.accessibilityDisplayOptionsDidChangeNotification, in: NSWorkspace.shared.notificationCenter) {
            .reduceMotion(NSWorkspace.shared.accessibilityDisplayShouldReduceMotion)
        }
        watch(NSApplication.didHideNotification) { .active(false) }
        watch(NSApplication.didUnhideNotification) { .active(true) }
#endif
    }
}
