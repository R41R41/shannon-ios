import Foundation
import Observation

@MainActor
@Observable
public final class ShannonTestFlightDeliveryModel {
    public private(set) var dashboard: ShannonTestFlightDeliveryDashboardDTO?
    public private(set) var isLoading = false
    public private(set) var errorMessage: String?

    private let scopeKey: String
    private let client: any ShannonDeliveryServing

    public init(
        scopeKey: String = "local-owner",
        client: any ShannonDeliveryServing = ShannonAPIClient()
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

    public func confirm(_ gate: ShannonReleaseGateKeyDTO) async {
        guard gate == .install || gate == .smoke,
              let buildVersion = dashboard?.release?.buildVersion,
              !isLoading else { return }
        isLoading = true
        errorMessage = nil
        defer { isLoading = false }
        do {
            dashboard = try await client.confirmTestFlightReleaseGate(
                scopeKey: scopeKey, buildVersion: buildVersion, gate: gate
            )
        } catch {
            errorMessage = gate == .install
                ? "インストール確認を保存できませんでした。"
                : "実機確認を保存できませんでした。Installの完了も確認してください。"
        }
    }
}

public extension Notification.Name {
    static let shannonTestFlightDeliveryNotificationOpened = Notification.Name(
        "ShannonTestFlightDeliveryNotificationOpened"
    )
}
