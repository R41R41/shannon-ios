import Foundation

public enum ShannonRemoteVoicePitchPolicy {
    public static let enabledDefaultsKey = "shannon.voice.remotePitch.enabled"
    public static let enabledHeaderValue = "enabled"
    public static let disabledHeaderValue = "disabled"
    public static func isEnabled(defaults: UserDefaults = .standard) -> Bool {
        guard defaults.object(forKey: enabledDefaultsKey) != nil else { return true }
        return defaults.bool(forKey: enabledDefaultsKey)
    }

    public static func headerValue(defaults: UserDefaults = .standard) -> String {
        isEnabled(defaults: defaults) ? enabledHeaderValue : disabledHeaderValue
    }

}
