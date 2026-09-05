import SwiftUI

public struct ShannonTestFlightDeliveryView: View {
    let model: ShannonTestFlightDeliveryModel

    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var colorScheme

    public init(model: ShannonTestFlightDeliveryModel) {
        self.model = model
    }

    public var body: some View {
        let palette = M3Palette.resolve(colorScheme)
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: M3Spacing.large) {
                    if let dashboard = model.dashboard {
                        currentCard(dashboard, palette: palette)
                        if dashboard.history.isEmpty {
                            emptyHistory(palette)
                        } else {
                            Text("履歴")
                                .font(.headline)
                                .padding(.top, M3Spacing.small)
                            LazyVStack(spacing: M3Spacing.small) {
                                ForEach(dashboard.history) { item in
                                    historyRow(item, palette: palette)
                                }
                            }
                        }
                    } else if model.isLoading {
                        ProgressView("配信状況を確認中…")
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 64)
                    } else {
                        emptyHistory(palette)
                    }

                    if let errorMessage = model.errorMessage {
                        HStack(spacing: M3Spacing.medium) {
                            Text(errorMessage)
                                .font(.subheadline)
                                .foregroundStyle(palette.onErrorContainer)
                            Spacer(minLength: 0)
                            Button("再試行") { Task { await model.reload() } }
                                .font(.subheadline.weight(.semibold))
                            Button(action: model.dismissError) {
                                Image(systemName: "xmark")
                            }
                            .accessibilityLabel("閉じる")
                        }
                        .padding(M3Spacing.medium)
                        .background(palette.errorContainer, in: RoundedRectangle(cornerRadius: M3Shape.medium))
                    }
                }
                .padding(M3Spacing.large)
            }
            .refreshable { await model.reload() }
            .background(palette.surfaceContainerLow)
            .navigationTitle("アプリの更新")
#if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
#endif
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("完了") { dismiss() }
                }
            }
        }
        .task { await model.reload() }
    }

    private func currentCard(_ dashboard: ShannonTestFlightDeliveryDashboardDTO, palette: M3Palette) -> some View {
        HStack(alignment: .top, spacing: M3Spacing.medium) {
            Image(systemName: conditionSymbol(dashboard.condition))
                .font(.system(size: 22, weight: .semibold))
                .foregroundStyle(conditionColor(dashboard.condition, palette: palette))
                .frame(width: 48, height: 48)
                .background(conditionColor(dashboard.condition, palette: palette).opacity(0.14), in: Circle())
            VStack(alignment: .leading, spacing: 5) {
                Text(conditionTitle(dashboard.condition))
                    .font(.title3.bold())
                    .foregroundStyle(palette.onSurface)
                Text(conditionDetail(dashboard))
                    .font(.subheadline)
                    .foregroundStyle(palette.onSurfaceVariant)
                if let checkedAt = dashboard.lastCheckedAt {
                    Text("最終確認  \(formattedDate(checkedAt))")
                        .font(.caption)
                        .foregroundStyle(palette.onSurfaceVariant)
                        .padding(.top, 2)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(M3Spacing.large)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(palette.surface, in: RoundedRectangle(cornerRadius: M3Shape.large))
        .overlay {
            RoundedRectangle(cornerRadius: M3Shape.large)
                .stroke(palette.outlineVariant.opacity(0.7), lineWidth: 0.7)
        }
    }

    private func historyRow(_ item: ShannonTestFlightDeliveryHistoryItemDTO, palette: M3Palette) -> some View {
        HStack(alignment: .top, spacing: M3Spacing.medium) {
            Image(systemName: historySymbol(item.status))
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(item.status == .failed ? palette.error : palette.primary)
                .frame(width: 34, height: 34)
                .background(
                    (item.status == .failed ? palette.errorContainer : palette.primaryContainer),
                    in: Circle()
                )
            VStack(alignment: .leading, spacing: 3) {
                Text(historyTitle(item))
                    .font(.body.weight(.semibold))
                    .foregroundStyle(palette.onSurface)
                Text(formattedDate(item.checkedAt))
                    .font(.caption)
                    .foregroundStyle(palette.onSurfaceVariant)
                if item.status == .failed, item.notificationStatus == .sent {
                    Text("通知済み")
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(palette.primary)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(M3Spacing.medium)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(palette.surface, in: RoundedRectangle(cornerRadius: M3Shape.medium))
    }

    private func emptyHistory(_ palette: M3Palette) -> some View {
        Text("まだ配信履歴はありません。")
            .font(.body)
            .foregroundStyle(palette.onSurfaceVariant)
            .frame(maxWidth: .infinity, minHeight: 120)
    }

    private func conditionTitle(_ condition: ShannonTestFlightConditionDTO) -> String {
        switch condition {
        case .healthy: "正常です"
        case .waiting: "新しいビルドを待っています"
        case .attention: "配信を確認してください"
        }
    }

    private func conditionDetail(_ dashboard: ShannonTestFlightDeliveryDashboardDTO) -> String {
        if dashboard.condition == .attention {
            return failureDescription(dashboard.activeFailureCode)
        }
        if let version = dashboard.latestBuildVersion {
            return "最新の配信はビルド \(version) です。"
        }
        return "配信できるビルドが見つかると、ここに表示されます。"
    }

    private func historyTitle(_ item: ShannonTestFlightDeliveryHistoryItemDTO) -> String {
        switch item.status {
        case .distributed: "ビルド \(item.buildVersion ?? "—") を配信"
        case .alreadyCurrent: "ビルド \(item.buildVersion ?? "—") を確認"
        case .noValidBuild: "配信できるビルドを待機"
        case .failed: failureDescription(item.failureCode)
        }
    }

    private func failureDescription(_ code: String?) -> String {
        switch code {
        case "authentication": "App Store Connectへの接続を確認してください。"
        case "permission": "配信に必要な権限を確認してください。"
        case "rate-limit": "Apple側の利用制限で、しばらく待機しています。"
        case "network": "ネットワーク接続でつまずいています。"
        case "configuration": "配信設定を確認してください。"
        case "app-store-connect": "App Store Connectが一時的に応答していません。"
        default: "新しいビルドの配信でつまずきました。"
        }
    }

    private func conditionSymbol(_ condition: ShannonTestFlightConditionDTO) -> String {
        switch condition {
        case .healthy: "checkmark.circle.fill"
        case .waiting: "clock.fill"
        case .attention: "exclamationmark.triangle.fill"
        }
    }

    private func conditionColor(_ condition: ShannonTestFlightConditionDTO, palette: M3Palette) -> Color {
        condition == .attention ? palette.error : palette.primary
    }

    private func historySymbol(_ status: ShannonTestFlightDeliveryStatusDTO) -> String {
        switch status {
        case .distributed: "arrow.down.app.fill"
        case .alreadyCurrent: "checkmark"
        case .noValidBuild: "clock"
        case .failed: "exclamationmark"
        }
    }

    private func formattedDate(_ value: String) -> String {
        guard let date = Self.iso8601.date(from: value) ?? ISO8601DateFormatter().date(from: value) else {
            return value
        }
        return date.formatted(.dateTime.month().day().hour().minute())
    }

    private static let iso8601: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()
}
