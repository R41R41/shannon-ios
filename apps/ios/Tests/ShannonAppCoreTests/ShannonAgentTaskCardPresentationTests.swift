import XCTest
@testable import ShannonAppCore

final class ShannonAgentTaskCardPresentationTests: XCTestCase {
    func testOnlyProposalKeepsDecisionCard() {
        let presentation = ShannonAgentTaskCardPresentation(task: ShannonAgentTaskFixtures.proposed())
        XCTAssertEqual(presentation.style, .proposal)
        XCTAssertEqual(presentation.statusText, "提案")
    }

    func testRunningWorkIsOneLineWithPlanProgress() {
        let presentation = ShannonAgentTaskCardPresentation(task: ShannonAgentTaskFixtures.running())
        XCTAssertEqual(presentation.style, .active)
        XCTAssertEqual(presentation.statusText, "作業中 2/4")
        XCTAssertEqual(presentation.tone, .action)
    }

    func testRunningWithoutPlanOmitsCount() {
        var task = ShannonAgentTaskFixtures.running()
        task.plan = []
        XCTAssertEqual(ShannonAgentTaskCardPresentation(task: task).statusText, "作業中")
    }

    func testApprovalUsesAttentionWordingNotColorAlone() {
        let presentation = ShannonAgentTaskCardPresentation(task: ShannonAgentTaskFixtures.waitingApproval())
        XCTAssertEqual(presentation.style, .active)
        XCTAssertEqual(presentation.statusText, "許可待ち")
        XCTAssertEqual(presentation.tone, .attention)
        XCTAssertEqual(presentation.symbolName, "hand.raised.fill")
    }

    func testFinishedWorkIsQuiet() {
        let completed = ShannonAgentTaskCardPresentation(task: ShannonAgentTaskFixtures.completed())
        XCTAssertEqual(completed.style, .quiet)
        XCTAssertEqual(completed.statusText, "完了")
        XCTAssertEqual(completed.tone, .success)

        var failedTask = ShannonAgentTaskFixtures.completed()
        failedTask.status = .failed
        let failed = ShannonAgentTaskCardPresentation(task: failedTask)
        XCTAssertEqual(failed.style, .quiet)
        XCTAssertEqual(failed.statusText, "失敗")
        XCTAssertEqual(failed.tone, .danger)

        var cancelledTask = ShannonAgentTaskFixtures.completed()
        cancelledTask.status = .cancelled
        XCTAssertEqual(ShannonAgentTaskCardPresentation(task: cancelledTask).tone, .secondary)
    }
}

final class ShannonVoiceAmbientMotionTests: XCTestCase {
    func testFailedAndIdleCallsKeepTheBackgroundStill() {
        XCTAssertEqual(ShannonVoiceAmbientMotion.intensity(for: .failed), 0)
        XCTAssertEqual(ShannonVoiceAmbientMotion.intensity(for: .idle), 0)
        let still = ShannonVoiceAmbientMotion.drift(time: 1234, intensity: 0)
        XCTAssertEqual(still.x, 0.5)
        XCTAssertEqual(still.y, 0.5)
        XCTAssertEqual(still.edge, 0)
    }

    func testSpeakingIsOnlySlightlyLivelierAndTheMeshNeverFolds() {
        XCTAssertGreaterThan(ShannonVoiceAmbientMotion.intensity(for: .speaking),
                             ShannonVoiceAmbientMotion.intensity(for: .listening))
        for step in 0..<400 {
            let drift = ShannonVoiceAmbientMotion.drift(time: Double(step) * 0.37, intensity: 5)
            XCTAssertTrue((0.3...0.7).contains(drift.x))
            XCTAssertTrue((0.3...0.7).contains(drift.y))
            XCTAssertLessThan(abs(drift.edge), 0.1)
        }
    }
}
