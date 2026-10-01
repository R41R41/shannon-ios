import Testing
@testable import ShannonAppCore

struct ShannonSettingsSummaryTests {
    @Test
    func appearanceIconAndAvatarShowShortCurrentValues() {
        #expect(ShannonAppearanceMode.allCases.map(ShannonSettingsSummary.appearanceLabel) == ["システム", "ライト", "ダーク"])
        #expect(ShannonSettingsSummary.appIconLabel(.level06) == "L06")
        #expect(ShannonSettingsSummary.appIconLabel(.level02) == "L02")
        #expect(ShannonSettingsSummary.avatarLabel(.expression) == "表情")
        #expect(ShannonSettingsSummary.avatarLabel(.secondAppIcon) == "L06")
    }

    @Test
    func providerLabelsAreShortNames() {
        #expect(ShannonSettingsSummary.providerLabel(.gemini) == "Gemini")
        #expect(ShannonSettingsSummary.providerLabel(.eleven) == "ElevenLabs")
    }

    @Test(arguments: [
        (ShannonSpeechProvider.gemini, ShannonSpeechProvider.gemini, "Leda", "Leda"),
        (.gemini, .gemini, " Aoede ", "Aoede"),
        // Before any call the session still holds its placeholder.
        (.gemini, .gemini, ShannonSettingsSummary.sessionVoicePlaceholder, "サーバー設定の声"),
        (.gemini, .gemini, "", "サーバー設定の声"),
        // A voice reported by an ElevenLabs call is not shown as the Gemini voice.
        (.gemini, .eleven, "eleven-voice-id", "サーバー設定の声"),
        (.eleven, .gemini, "Leda", "Shannonクローン"),
        (.eleven, .eleven, "eleven-voice-id", "Shannonクローン"),
    ])
    func voiceLabelReflectsTheProviderTheNextCallWillUse(
        provider: ShannonSpeechProvider,
        lastProvider: ShannonSpeechProvider,
        lastVoice: String,
        expected: String
    ) {
        #expect(ShannonSettingsSummary.voiceLabel(
            provider: provider,
            lastSessionProvider: lastProvider,
            lastSessionVoice: lastVoice
        ) == expected)
    }

    @Test
    func profileSubtitleCombinesVoiceAndProvider() {
        #expect(ShannonSettingsSummary.profileSubtitle(voice: "Leda", provider: .gemini) == "声：Leda・Gemini")
        #expect(ShannonSettingsSummary.profileSubtitle(voice: "Shannonクローン", provider: .eleven)
            == "声：Shannonクローン・ElevenLabs")
    }

    @Test
    func connectionLabelIsShortAndHidesTheDeviceName() {
        #expect(ShannonSettingsSummary.connectionLabel(.connected(deviceName: "合成iPhone")) == "接続中")
        #expect(ShannonSettingsSummary.connectionLabel(.connecting) == "確認中…")
        #expect(ShannonSettingsSummary.connectionLabel(.disconnected) == "未接続")
        #expect(ShannonSettingsSummary.connectionLabel(.failed(message: "合成エラー")) == "エラー")
    }
}
