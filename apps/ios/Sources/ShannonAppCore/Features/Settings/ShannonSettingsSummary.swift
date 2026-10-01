import Foundation

/// Short current-value labels for the trailing side of the iPhone settings
/// rows. Pure so the labels stay testable without a hosted List.
enum ShannonSettingsSummary {
    /// Placeholder the voice session model holds before any call reports its voice.
    static let sessionVoicePlaceholder = "Shannon"

    static func appearanceLabel(_ mode: ShannonAppearanceMode) -> String {
        switch mode {
        case .system: "システム"
        case .light: "ライト"
        case .dark: "ダーク"
        }
    }

    static func appIconLabel(_ choice: ShannonAppIconChoice) -> String {
        choice.levelName
    }

    static func avatarLabel(_ style: ShannonChatAvatarStyle) -> String {
        switch style {
        case .expression: "表情"
        case .secondAppIcon: ShannonChatAvatarStyle.secondIconChoice.levelName
        }
    }

    static func providerLabel(_ provider: ShannonSpeechProvider) -> String {
        switch provider {
        case .gemini: "Gemini"
        case .eleven: "ElevenLabs"
        }
    }

    /// The voice the next call will use. Gemini's voice is configured on the
    /// server, so its name is known only after a call with the same provider
    /// reports it; ElevenLabs always speaks with the Shannon clone.
    static func voiceLabel(
        provider: ShannonSpeechProvider,
        lastSessionProvider: ShannonSpeechProvider,
        lastSessionVoice: String
    ) -> String {
        switch provider {
        case .eleven:
            return "Shannonクローン"
        case .gemini:
            let voice = lastSessionVoice.trimmingCharacters(in: .whitespacesAndNewlines)
            guard lastSessionProvider == .gemini, !voice.isEmpty, voice != sessionVoicePlaceholder else {
                return "サーバー設定の声"
            }
            return voice
        }
    }

    static func profileSubtitle(voice: String, provider: ShannonSpeechProvider) -> String {
        "声：\(voice)・\(providerLabel(provider))"
    }

    static func connectionLabel(_ status: ShannonConnectionStatus) -> String {
        switch status {
        case .disconnected: "未接続"
        case .connecting: "確認中…"
        case .connected: "接続中"
        case .failed: "エラー"
        }
    }
}
