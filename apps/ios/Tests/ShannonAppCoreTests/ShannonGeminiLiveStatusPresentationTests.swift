import XCTest
@testable import ShannonAppCore

final class ShannonGeminiLiveStatusPresentationTests: XCTestCase {
    static func onMac(_ mac: String, else phone: String) -> String {
#if os(macOS)
        mac
#else
        phone
#endif
    }

    private let allPhases: [ShannonGeminiLivePhase] = [
        .idle, .requestingPermission, .connecting, .listening, .thinking, .speaking, .reconnecting, .failed,
    ]

    func testFailureDetailDescribesReconnectInsteadOfSpeakingGuidance() {
        let presentation = ShannonGeminiLiveStatusPresentation(
            phase: .failed,
            failureRecovery: .reconnect
        )

        XCTAssertEqual(presentation.title, "接続できませんでした")
        XCTAssertEqual(presentation.detail, "通信を確認して、もう一度つないでください。")
        XCTAssertEqual(presentation.detailTone, .danger)
        XCTAssertFalse(presentation.detail?.contains("自然に話しかけてください") ?? false)
    }

    func testFailureDetailReflectsRecoveryAction() {
        XCTAssertEqual(
            ShannonGeminiLiveStatusPresentation(phase: .failed, failureRecovery: .openSettings).detail,
            Self.onMac("システム設定でマイクを許可してから、もう一度お試しください。", else: "設定でマイクを許可してから、もう一度お試しください。")
        )
        XCTAssertEqual(
            ShannonGeminiLiveStatusPresentation(phase: .failed, failureRecovery: .updateRequired).detail,
            "最新版へ更新してから、もう一度開いてください。"
        )
    }

    func testFailureErrorMessageIsTheSingleStatusDetail() {
        let presentation = ShannonGeminiLiveStatusPresentation(
            phase: .failed,
            failureRecovery: .reconnect,
            errorMessage: "音声会話へ接続できませんでした。通信を確認して、もう一度お試しください。"
        )
        XCTAssertEqual(presentation.title, "接続できませんでした")
        XCTAssertEqual(presentation.detail, "音声会話へ接続できませんでした。通信を確認して、もう一度お試しください。")
        XCTAssertEqual(presentation.inputIndicator, .none)
    }

    func testNonFatalErrorIsShownAsAttentionDetailWithoutReplacingPhase() {
        let presentation = ShannonGeminiLiveStatusPresentation(
            phase: .listening,
            errorMessage: "選んだマイクは現在接続されていません。",
            hasConversation: true
        )
        XCTAssertEqual(presentation.title, "聞いています")
        XCTAssertEqual(presentation.detail, "選んだマイクは現在接続されていません。")
        XCTAssertEqual(presentation.detailTone, .attention)
    }

    func testReassuranceOnlyBeforeTheConversationStarts() {
        XCTAssertEqual(
            ShannonGeminiLiveStatusPresentation(phase: .listening).detail,
            "自然に話しかけてください。途中で遮っても大丈夫です。"
        )
        XCTAssertNil(ShannonGeminiLiveStatusPresentation(phase: .listening, hasConversation: true).detail)
        XCTAssertNil(ShannonGeminiLiveStatusPresentation(phase: .thinking, hasConversation: true).detail)
        XCTAssertNil(ShannonGeminiLiveStatusPresentation(phase: .speaking, hasConversation: true).detail)
    }

    func testReconnectingKeepsItsTextInTheStatusLine() {
        let presentation = ShannonGeminiLiveStatusPresentation(phase: .reconnecting, hasConversation: true)
        XCTAssertEqual(presentation.title, "会話をつなぎ直しています")
        XCTAssertEqual(presentation.detail, "会話内容を保ったまま、接続を回復しています。")
    }

    func testStatusLineNeverContradictsItselfWithInputCheckingText() {
        for phase in allPhases {
            for muted in [false, true] {
                let presentation = ShannonGeminiLiveStatusPresentation(phase: phase, isMuted: muted)
                let text = presentation.title + (presentation.detail ?? "")
                XCTAssertFalse(text.contains("入力を確認中"), "\(phase) muted=\(muted)")
            }
        }
    }

    func testPrimaryStatusNeverExposesProviderOrModel() {
        for phase in allPhases {
            for recovery in [nil, ShannonGeminiLiveFailureRecovery.reconnect, .openSettings, .updateRequired] {
                let presentation = ShannonGeminiLiveStatusPresentation(phase: phase, failureRecovery: recovery)
                let text = presentation.title + (presentation.detail ?? "")
                XCTAssertFalse(text.contains("Gemini"), "\(phase)")
                XCTAssertFalse(text.contains("gemini-"), "\(phase)")
            }
        }
    }

    func testDiagnosticsHintKeepsProviderAndModelReachable() {
        let hint = ShannonGeminiLiveStatusPresentation.diagnosticsHint(
            provider: "Gemini", model: "gemini-3.5-transcribe-live", voice: "Shannon"
        )
        XCTAssertTrue(hint.contains("gemini-3.5-transcribe-live"))
        XCTAssertTrue(hint.contains("Gemini"))
    }

    func testInputLevelGlyphOnlyWhileListeningAndMutedGlyphWhileMuted() {
        XCTAssertEqual(ShannonGeminiLiveStatusPresentation(phase: .listening).inputIndicator, .level)
        XCTAssertEqual(ShannonGeminiLiveStatusPresentation(phase: .speaking).inputIndicator, .none)
        XCTAssertEqual(ShannonGeminiLiveStatusPresentation(phase: .connecting).inputIndicator, .none)
        XCTAssertEqual(ShannonGeminiLiveStatusPresentation(phase: .failed).inputIndicator, .none)
        XCTAssertEqual(ShannonGeminiLiveStatusPresentation(phase: .listening, isMuted: true).inputIndicator, .muted)
        XCTAssertEqual(ShannonGeminiLiveStatusPresentation(phase: .speaking, isMuted: true).inputIndicator, .muted)
    }

    func testMutedListeningSaysSoInTheStatusLine() {
        let presentation = ShannonGeminiLiveStatusPresentation(phase: .listening, isMuted: true, hasConversation: true)
        XCTAssertEqual(presentation.title, "ミュート中")
        // The Mac is clicked; its control is named マイク.
        XCTAssertEqual(presentation.detail, Self.onMac("話すときは「マイク」をクリックしてください。", else: "話すときはマイクをタップしてください。"))
        XCTAssertEqual(
            ShannonGeminiLiveStatusPresentation(phase: .speaking, isMuted: true).title,
            "シャノンが話しています"
        )
    }

    func testMicrophoneControlChangesLabelAndSymbolNotOnlyColor() {
        let on = ShannonGeminiLiveMicrophoneControl(isMuted: false)
        let muted = ShannonGeminiLiveMicrophoneControl(isMuted: true)
        XCTAssertEqual(on.title, "マイク")
        XCTAssertEqual(muted.title, "ミュート中")
        XCTAssertEqual(on.systemImage, "mic.fill")
        XCTAssertEqual(muted.systemImage, "mic.slash.fill")
        XCTAssertNotEqual(on.accessibilityValue, muted.accessibilityValue)
        XCTAssertTrue(muted.accessibilityHint.contains("ミュートを解除"))
    }

    func testSubtitlesShowOnlyTheLatestLineOfEachSpeaker() {
        let subtitles = ShannonGeminiLiveSubtitles(
            speakerName: "あなた",
            userTranscript: "最初の依頼\n\n今日の予定を整理して ",
            shannonTranscript: "もちろん。まず優先したいことから確認しよう。"
        )
        XCTAssertEqual(subtitles.user, "あなた：今日の予定を整理して")
        XCTAssertEqual(subtitles.shannon, "もちろん。まず優先したいことから確認しよう。")
        XCTAssertFalse(subtitles.isEmpty)

        let empty = ShannonGeminiLiveSubtitles(speakerName: "あなた", userTranscript: " \n", shannonTranscript: "")
        XCTAssertNil(empty.user)
        XCTAssertNil(empty.shannon)
        XCTAssertTrue(empty.isEmpty)
    }

    func testCallDurationFormatting() {
        XCTAssertEqual(ShannonVoiceCallDuration.text(seconds: 0), "0:00")
        XCTAssertEqual(ShannonVoiceCallDuration.text(seconds: 83), "1:23")
        XCTAssertEqual(ShannonVoiceCallDuration.text(seconds: 3_725), "1:02:05")
        XCTAssertEqual(ShannonVoiceCallDuration.text(seconds: -4), "0:00")
        XCTAssertEqual(ShannonVoiceCallDuration.accessibilityText(seconds: 0), "通話時間 0秒")
        XCTAssertEqual(ShannonVoiceCallDuration.accessibilityText(seconds: 83), "通話時間 1分23秒")
        XCTAssertEqual(ShannonVoiceCallDuration.accessibilityText(seconds: 3_600), "通話時間 1時間")
    }
}

@MainActor
final class ShannonGeminiLiveMuteTests: XCTestCase {
    func testMuteTogglesAndClearsLevelThenResetsWhenTheCallEnds() {
        let model = ShannonGeminiLiveSessionModel()
        XCTAssertFalse(model.isMicrophoneMuted)
        model.toggleMicrophoneMute()
        XCTAssertTrue(model.isMicrophoneMuted)
        XCTAssertEqual(model.audioLevel, 0)
        model.toggleMicrophoneMute()
        XCTAssertFalse(model.isMicrophoneMuted)
        model.toggleMicrophoneMute()
        model.stop()
        XCTAssertFalse(model.isMicrophoneMuted)
        XCTAssertNil(model.callStartedAt)
    }

    func testPhaseLabelDoesNotNameTheProvider() {
        XCTAssertFalse(ShannonGeminiLivePhase.connecting.japaneseLabel.contains("Gemini"))
    }
}
