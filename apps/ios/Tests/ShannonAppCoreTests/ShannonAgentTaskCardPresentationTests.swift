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
        XCTAssertEqual(presentation.statusText, "許可が必要")
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
        XCTAssertEqual(failed.statusText, "問題あり")
        XCTAssertEqual(failed.tone, .danger)

        var cancelledTask = ShannonAgentTaskFixtures.completed()
        cancelledTask.status = .cancelled
        XCTAssertEqual(ShannonAgentTaskCardPresentation(task: cancelledTask).tone, .secondary)
    }
}
