import XCTest
@testable import ShannonAppCore

final class ShannonGeminiLiveStatusPresentationTests: XCTestCase {
    func testFailureSubtitleDescribesReconnectInsteadOfSpeakingGuidance() {
        let presentation = ShannonGeminiLiveStatusPresentation(
            phase: .failed,
            failureRecovery: .reconnect
        )

        XCTAssertEqual(presentation.title, "接続できませんでした")
        XCTAssertEqual(presentation.subtitle, "通信を確認して、もう一度つないでください。")
        XCTAssertFalse(presentation.subtitle.contains("自然に話しかけてください"))
    }

    func testFailureSubtitleReflectsRecoveryAction() {
        XCTAssertEqual(
            ShannonGeminiLiveStatusPresentation(
                phase: .failed,
                failureRecovery: .openSettings
            ).subtitle,
            "設定でマイクを許可してから、もう一度お試しください。"
        )
        XCTAssertEqual(
            ShannonGeminiLiveStatusPresentation(
                phase: .failed,
                failureRecovery: .updateRequired
            ).subtitle,
            "最新版へ更新してから、もう一度開いてください。"
        )
    }

    func testActivePhaseSubtitlesRemainSpecific() {
        XCTAssertEqual(
            ShannonGeminiLiveStatusPresentation(phase: .listening).subtitle,
            "自然に話しかけてください。途中で遮っても大丈夫です。"
        )
        XCTAssertEqual(
            ShannonGeminiLiveStatusPresentation(phase: .thinking).subtitle,
            "返答を準備しています。そのままお待ちください。"
        )
        XCTAssertEqual(
            ShannonGeminiLiveStatusPresentation(phase: .speaking).subtitle,
            "途中で話しかけると、返答を止めて聞き直します。"
        )
    }
}
