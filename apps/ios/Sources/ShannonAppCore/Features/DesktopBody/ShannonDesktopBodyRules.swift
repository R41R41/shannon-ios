import Foundation

/// What her desktop body does with a message she started on her own (`docs/body-contract.md`, "A message she starts on
/// her own" and "What the body did with her message"). Pure, so every branch is tested.
public enum ShannonDesktopBodyReachOut {
    public enum Plan: Equatable, Sendable {
        /// The bubble and her voice; reported `shown_spoken` once her voice was heard, otherwise `shown`.
        case speak
        /// The bubble only, reported `shown`.
        case showSilently
        /// Not shown, reported with this outcome (`muted`, `hidden`, `away`).
        case notShown(String)
        /// Long past (the Mac was off): neither shown nor reported, as her wait for it ended long ago.
        case skip
    }

    /// Older than this when the body first sees it (the Mac was asleep): the bubble only.
    public static let oldAfter: TimeInterval = 5 * 60
    /// Older than this: not shown at all.
    public static let staleAfter: TimeInterval = 60 * 60

    /// `soundTaken`: a voice call on the Mac or another of his apps, dictation, or another line of hers is speaking.
    /// Other people present change nothing here: the server already worded the message for them.
    public static func plan(speaks: Bool, windowShown: Bool, ownerAway: Bool, createdAt: Date?, now: Date, soundTaken: Bool) -> Plan {
        if let createdAt, now.timeIntervalSince(createdAt) > staleAfter { return .skip }
        if !speaks { return .notShown("muted") }
        if !windowShown { return .notShown("hidden") }
        // Not into an empty room: she is told he was away, and decides what to do next herself.
        if ownerAway { return .notShown("away") }
        if let createdAt, now.timeIntervalSince(createdAt) > oldAfter { return .showSilently }
        return soundTaken ? .showSilently : .speak
    }

    /// The outcome of a message that was shown, by whether any of her voice was heard.
    public static func outcome(heard: Bool) -> String { heard ? "shown_spoken" : "shown" }
}

/// Whether her body may take its one frame of the room (`docs/body-contract.md`, "Looking at the room"), and the code
/// it answers with when not. The camera is never opened for a refusal.
public enum ShannonDesktopBodyLookRules {
    /// The body's own limit, counted on looks actually taken.
    public static let perHour = 6

    public static func refusal(
        cameraAllowed: Bool, windowShown: Bool, othersPresent: Bool, hasCamera: Bool,
        permission: ShannonMediaPermission, takenInLastHour: Int
    ) -> String? {
        if !cameraAllowed { return "camera_off" }
        if !windowShown { return "window_hidden" }
        // Only with the owner alone: 「友人も一緒」 and the minutes after it, as for a touch.
        if othersPresent { return "others_present" }
        if !hasCamera { return "no_camera" }
        // The system is never asked from a look: the owner allowed the camera when he switched it on.
        if permission != .granted { return "denied" }
        if takenInLastHour >= perHour { return "rate_limited" }
        return nil
    }

    /// The camera flag the body registers: switched on by the owner and not refused by the system.
    public static func registersCamera(cameraAllowed: Bool, permission: ShannonMediaPermission, hasCamera: Bool) -> Bool {
        cameraAllowed && hasCamera && permission == .granted
    }
}

/// The camera's state at her feet (Syzygy ADR-0002: 「状態は窓の足もとのしるしで常に分かる」).
public enum ShannonDesktopBodyCameraState {
    public static func make(cameraAllowed: Bool, permission: ShannonMediaPermission, hasCamera: Bool, othersPresent: Bool, isCapturing: Bool)
        -> ShannonAppLookVisibleState {
        ShannonAppLookVisibleState.make(
            enabled: cameraAllowed, hasCamera: hasCamera, permission: permission == .undetermined ? .denied : permission,
            othersPresent: othersPresent, isCapturing: isCapturing)
    }
}

/// How long one of her lines stays in the bubble: long enough to read, never for ever.
public enum ShannonDesktopBodyBubble {
    public static func seconds(for text: String) -> Double {
        min(20, max(6, Double(text.count) / 6))
    }
}
