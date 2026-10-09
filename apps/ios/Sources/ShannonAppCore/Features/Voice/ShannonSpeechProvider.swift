import Foundation

public enum ShannonSpeechProvider: String, CaseIterable, Codable, Sendable, Identifiable {
    case gemini
    case eleven

    public static let storageKey = "shannon.voice.speech-provider"
    public static func current(defaults: UserDefaults = .standard) -> Self {
        ShannonPersonaPreset.current(defaults: defaults)?.speechProvider
            ?? defaults.string(forKey: storageKey).flatMap(Self.init(rawValue:)) ?? .gemini
    }
    public var id: String { rawValue }
    public var japaneseName: String {
        switch self {
        case .gemini: "Gemini"
        case .eleven: "ElevenLabs v4 Turbo"
        }
    }
}
