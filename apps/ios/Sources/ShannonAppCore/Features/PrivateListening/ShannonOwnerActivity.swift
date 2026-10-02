import Foundation
#if os(macOS)
import CoreGraphics
#elseif canImport(UIKit)
import UIKit
#endif

/// When the owner last used this device, as far as the app can see. Only a timestamp leaves the app;
/// the server uses it to choose which device speaks when more than one is privately listening.
public enum ShannonOwnerActivity {
    @MainActor
    public static func lastInput(now: Date = Date()) -> Date? {
#if os(macOS)
        // Seconds since any keyboard or pointer input on this Mac, in any app.
        let anyInput = CGEventType(rawValue: ~0) ?? .mouseMoved
        let seconds = CGEventSource.secondsSinceLastEventType(.combinedSessionState, eventType: anyInput)
        return seconds.isFinite && seconds >= 0 ? now.addingTimeInterval(-seconds) : nil
#elseif canImport(UIKit)
        // An iPhone app sees only its own use: in front means in use now.
        return UIApplication.shared.applicationState == .active ? now : nil
#else
        return nil
#endif
    }
}
