import Foundation
import Observation

@MainActor
@Observable
public final class ShannonTestFlightDeliveryModel {
    public private(set) var dashboard: ShannonTestFlightDeliveryDashboardDTO?
    public private(set) var isLoading = false
    public private(set) var errorMessage: String?

    private let scopeKey: String
    private let client: any ShannonAPIClientProtocol

    public init(
        scopeKey: String = "local-owner",
        client: any ShannonAPIClientProtocol = ShannonAPIClient()
    ) {
        self.scopeKey = scopeKey
        self.client = client
    }

    public func reload() async {
        guard !isLoading else { return }
        isLoading = true
        errorMessage = nil
        defer { isLoading = false }
        do {
            dashboard = try await client.loadTestFlightDelivery(scopeKey: scopeKey)
        } catch {
            errorMessage = "配信状況を読み込めませんでした。接続を確認して、もう一度お試しください。"
        }
    }

    public func dismissError() {
        errorMessage = nil
    }
}

public extension Notification.Name {
    static let shannonTestFlightDeliveryNotificationOpened = Notification.Name(
        "ShannonTestFlightDeliveryNotificationOpened"
    )
}
