import UserNotifications

/// How Shannon's own notifications (her initiatives, work titles and results) are shown while the app is in front.
/// During 「友人も一緒」 the owner's words must not appear over the call (coordinator review 2026-10-06): no banner and
/// no sound, only the list and the badge, where he finds them later. Banners shown before the switch stay as they were.
public enum ShannonGuestCallNotifications {
    public static func foregroundPresentation(hidesOwnerScreens: Bool) -> UNNotificationPresentationOptions {
        hidesOwnerScreens ? [.list, .badge] : [.banner, .list, .sound, .badge]
    }
}

#if os(iOS)
extension ShannonVoiceCallHost {
    /// The iPhone's call is in 「友人も一緒」 now (the app delegate asks before showing a notification in front).
    public var hidesOwnerScreens: Bool { voiceModel.hidesOwnerScreens }
}
#endif
