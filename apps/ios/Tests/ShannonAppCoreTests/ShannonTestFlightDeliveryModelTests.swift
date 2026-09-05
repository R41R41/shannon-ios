import XCTest
@testable import ShannonAppCore

@MainActor
final class ShannonTestFlightDeliveryModelTests: XCTestCase {
    func testLoadsCurrentStatusAndHistory() async {
        let expected = ShannonTestFlightDeliveryDashboardDTO(
            condition: .healthy,
            latestBuildVersion: "17",
            lastCheckedAt: "2026-09-05T04:00:00.000Z",
            activeFailureCode: nil,
            history: [ShannonTestFlightDeliveryHistoryItemDTO(
                id: "run-1",
                status: .distributed,
                buildVersion: "17",
                checkedAt: "2026-09-05T04:00:00.000Z",
                failureCode: nil,
                notificationStatus: .notNeeded
            )]
        )
        let model = ShannonTestFlightDeliveryModel(client: TestFlightDeliveryClient(result: .success(expected)))

        await model.reload()

        XCTAssertEqual(model.dashboard, expected)
        XCTAssertNil(model.errorMessage)
        XCTAssertFalse(model.isLoading)
    }

    func testKeepsTheFailureHumanReadable() async {
        let model = ShannonTestFlightDeliveryModel(
            client: TestFlightDeliveryClient(result: .failure(TestFlightDeliveryTestError.failed))
        )

        await model.reload()

        XCTAssertNil(model.dashboard)
        XCTAssertEqual(
            model.errorMessage,
            "配信状況を読み込めませんでした。接続を確認して、もう一度お試しください。"
        )
    }
}

private struct TestFlightDeliveryClient: ShannonAPIClientProtocol {
    let result: Result<ShannonTestFlightDeliveryDashboardDTO, TestFlightDeliveryTestError>

    func send(message: String, scopeKey: String, threadId: String?) async throws -> ChatResponseDTO {
        throw TestFlightDeliveryTestError.failed
    }

    func loadTestFlightDelivery(scopeKey: String) async throws -> ShannonTestFlightDeliveryDashboardDTO {
        try result.get()
    }
}

private enum TestFlightDeliveryTestError: Error { case failed }
