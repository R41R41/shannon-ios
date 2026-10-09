import Foundation

/// A single persisted choice atomically selects figure, reply/task icons, and the next call's voice.
/// Legacy individual preferences remain intact until the owner chooses a preset.
public enum ShannonPersonaPreset: String, CaseIterable, Identifiable, Sendable {
    case bot, girl
    public static let storageKey = "shannon.persona.preset.v1"
    public var id: String { rawValue }
    public var title: String { self == .bot ? "ボット" : "ガール" }
    public var form: ShannonForm { self == .bot ? .waterlight : .live2d }
    public var live2DBody: ShannonLive2DBody { .human }
    public var speechProvider: ShannonSpeechProvider { self == .bot ? .gemini : .eleven }
    public var avatarStyle: ShannonChatAvatarStyle { self == .bot ? .secondAppIcon : .expression }
    public var explanation: String {
        self == .bot ? "水の光の目・目のアイコン・Geminiの声" : "水色髪の人の姿・表情アイコン・ElevenLabsの声"
    }
    public static func current(defaults: UserDefaults = .standard) -> Self? {
        if let stored = defaults.string(forKey: storageKey) { return Self(rawValue: stored) }
        // A fresh installation starts as the bot. Existing independent choices are not rewritten.
        let legacyKeys = [ShannonForm.storageKey, ShannonLive2DBody.storageKey, ShannonSpeechProvider.storageKey, ShannonChatAvatarStyle.storageKey]
        return legacyKeys.allSatisfy { defaults.object(forKey: $0) == nil } ? .bot : nil
    }
    public func select(defaults: UserDefaults = .standard) { defaults.set(rawValue, forKey: Self.storageKey) }
    /// Materialize the complete active preset before changing one individual preference.
    /// The canonical key remains in force throughout the synchronous writes, then switches once.
    public static func selectIndividual(key: String, value: String, defaults: UserDefaults = .standard) {
        if let selected = current(defaults: defaults) {
            defaults.set(selected.form.rawValue, forKey: ShannonForm.storageKey)
            defaults.set(selected.live2DBody.rawValue, forKey: ShannonLive2DBody.storageKey)
            defaults.set(selected.speechProvider.rawValue, forKey: ShannonSpeechProvider.storageKey)
            defaults.set(selected.avatarStyle.rawValue, forKey: ShannonChatAvatarStyle.storageKey)
        }
        defaults.set(value, forKey: key)
        defaults.set("", forKey: storageKey)
    }
    public static func form(legacy: String, preset: String) -> ShannonForm {
        Self(rawValue: preset)?.form ?? ShannonForm(rawValue: legacy) ?? .waterlight
    }
    public static func body(legacy: String, preset: String) -> ShannonLive2DBody {
        Self(rawValue: preset)?.live2DBody ?? ShannonLive2DBody(rawValue: legacy) ?? .human
    }
    public static func provider(legacy: String, preset: String) -> ShannonSpeechProvider {
        Self(rawValue: preset)?.speechProvider ?? ShannonSpeechProvider(rawValue: legacy) ?? .gemini
    }
    /// AppStorage's fallback uses the same non-destructive migration as synchronous readers.
    public static var initialRawValue: String { current()?.rawValue ?? "" }
}
