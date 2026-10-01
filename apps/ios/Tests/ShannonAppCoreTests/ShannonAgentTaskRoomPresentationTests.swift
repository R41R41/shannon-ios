import XCTest
@testable import ShannonAppCore

final class ShannonAgentTaskRoomPresentationTests: XCTestCase {
    private func task(
        status: ShannonAgentTaskStatus,
        plan: [ShannonAgentPlanStatus] = [],
        approval: Bool = false
    ) -> ShannonAgentTask {
        ShannonAgentTask(
            conversationThreadID: "t",
            title: "画面を直す",
            goal: "g",
            status: status,
            summary: "",
            plan: plan.enumerated().map { index, status in
                ShannonAgentPlanItem(id: "s\(index)", title: "工程\(index)", status: status)
            },
            pendingApproval: approval
                ? ShannonAgentApproval(externalRequestID: "r", kind: .network, title: "外部へ接続", reason: "取得のため")
                : nil
        )
    }

    func testSubtitleCombinesStateAndPlanProgress() {
        let value = task(
            status: .waitingApproval,
            plan: [.completed, .completed, .completed, .completed, .completed, .running, .pending, .pending],
            approval: true
        )
        XCTAssertEqual(ShannonAgentTaskRoomPresentation.subtitle(for: value), "許可待ち・5/8工程")
        XCTAssertEqual(ShannonAgentTaskRoomPresentation.planProgress(for: value), "5/8 完了")
    }

    func testSubtitleWithoutPlanShowsStateOnly() {
        XCTAssertEqual(ShannonAgentTaskRoomPresentation.subtitle(for: task(status: .running)), "作業中")
        XCTAssertEqual(ShannonAgentTaskRoomPresentation.subtitle(for: task(status: .completed)), "完了")
    }

    func testPendingApprovalReadsAsWaitingEvenBeforeStatusCatchesUp() {
        let value = task(status: .running, plan: [.completed, .running], approval: true)
        XCTAssertEqual(ShannonAgentTaskRoomPresentation.subtitle(for: value), "許可待ち・1/2工程")
    }

    func testFoldsLeadingCompletedStepsIntoOneRow() {
        let value = task(status: .running, plan: [.completed, .completed, .completed, .running, .pending])
        let entries = ShannonAgentPlanTimeline.entries(for: value)

        let collapsed = ShannonAgentPlanTimeline.rows(for: entries, showsCompleted: false)
        XCTAssertEqual(collapsed.map(\.id), [
            ShannonAgentPlanTimeline.Row.completedGroupID, "s3", "s4",
        ])
        XCTAssertEqual(collapsed.first, .completedGroup(count: 3, isExpanded: false, isLast: false))
        XCTAssertEqual(ShannonAgentPlanTimeline.completedGroupTitle(count: 3), "3工程を完了")

        let expanded = ShannonAgentPlanTimeline.rows(for: entries, showsCompleted: true)
        XCTAssertEqual(expanded.map(\.id), [
            ShannonAgentPlanTimeline.Row.completedGroupID, "s0", "s1", "s2", "s3", "s4",
        ])
        XCTAssertEqual(expanded.first, .completedGroup(count: 3, isExpanded: true, isLast: false))
    }

    func testKeepsSingleCompletedStepAndOutOfOrderStepsInPlace() {
        let single = ShannonAgentPlanTimeline.entries(for: task(status: .running, plan: [.completed, .running, .pending]))
        XCTAssertEqual(
            ShannonAgentPlanTimeline.rows(for: single, showsCompleted: false).map(\.id),
            ["s0", "s1", "s2"]
        )

        let outOfOrder = ShannonAgentPlanTimeline.entries(
            for: task(status: .running, plan: [.completed, .completed, .running, .completed, .pending])
        )
        XCTAssertEqual(
            ShannonAgentPlanTimeline.rows(for: outOfOrder, showsCompleted: false).map(\.id),
            [ShannonAgentPlanTimeline.Row.completedGroupID, "s2", "s3", "s4"]
        )
    }

    func testFullyCompletedPlanCollapsesToFinalGroupRow() {
        let entries = ShannonAgentPlanTimeline.entries(for: task(status: .completed, plan: [.completed, .completed]))
        XCTAssertEqual(
            ShannonAgentPlanTimeline.rows(for: entries, showsCompleted: false),
            [.completedGroup(count: 2, isExpanded: false, isLast: true)]
        )
        let expanded = ShannonAgentPlanTimeline.rows(for: entries, showsCompleted: true)
        XCTAssertEqual(expanded.first, .completedGroup(count: 2, isExpanded: true, isLast: false))
        XCTAssertEqual(expanded.count, 3)
    }
}
