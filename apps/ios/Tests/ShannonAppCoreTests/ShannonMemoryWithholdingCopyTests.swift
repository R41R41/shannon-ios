import XCTest
@testable import ShannonAppCore

final class ShannonMemoryWithholdingCopyTests: XCTestCase {
    func testForgettingSaysWhatStopsBeingUsedAndThatRestoreBringsItBack() {
        for copy in [ShannonMemoryWithholdingCopy.forget, ShannonMemoryWithholdingCopy.reject, ShannonMemoryWithholdingCopy.captureUndo] {
            XCTAssertTrue(copy.contains("この内容に触れたシャノンの返答や要約"))
            XCTAssertTrue(copy.contains("ほかの返答や要約はそのまま使います"))
            XCTAssertTrue(copy.contains("復元すると元に戻ります"))
            // The earlier wording described every earlier reply being dropped; that is no longer what happens.
            XCTAssertFalse(copy.contains("これより前のシャノンの返答"))
        }
        XCTAssertTrue(ShannonMemoryWithholdingCopy.reject.contains("覚え直すこともありません"))
        XCTAssertTrue(ShannonMemoryWithholdingCopy.restore.contains("また会話に使います"))
        XCTAssertTrue(ShannonMemoryWithholdingCopy.hiddenList.contains("消す操作ではありません"))
        XCTAssertTrue(ShannonMemoryWithholdingCopy.correct.contains(ShannonMemoryWithholdingCopy.correctionEffect))
    }

    func testCopyIsPoliteAndNotSpokenAsShannon() {
        let all = [ShannonMemoryWithholdingCopy.forget, ShannonMemoryWithholdingCopy.reject, ShannonMemoryWithholdingCopy.captureUndo,
                   ShannonMemoryWithholdingCopy.correct, ShannonMemoryWithholdingCopy.restore, ShannonMemoryWithholdingCopy.hiddenList]
        for copy in all {
            XCTAssertTrue(copy.hasSuffix("ます。") || copy.hasSuffix("ません。"), copy)
            XCTAssertFalse(copy.contains("ボク"))
            XCTAssertFalse(copy.contains("ライ氏"))
        }
    }
}
