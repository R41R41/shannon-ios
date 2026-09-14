import SwiftUI

public struct ShannonTestFlightDeliveryView: View {
    let model: ShannonTestFlightDeliveryModel
    let showsDismissButton: Bool
    let requestRelease: ((ShannonAppleReleaseTarget) -> Void)?

    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var colorScheme

    public init(
        model: ShannonTestFlightDeliveryModel,
        showsDismissButton: Bool = true,
        requestRelease: ((ShannonAppleReleaseTarget) -> Void)? = nil
    ) {
        self.model = model
        self.showsDismissButton = showsDismissButton
        self.requestRelease = requestRelease
    }

    public var body: some View {
        let palette = ShannonPalette.resolve(colorScheme)
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: ShannonSpacing.large) {
                    if requestRelease != nil {
                        releaseRequestCard(palette: palette)
                    }
                    if let dashboard = model.dashboard {
                        currentCard(dashboard, palette: palette)
                        if let release = dashboard.release {
                            releaseProgress(release, palette: palette)
                        }
                        if dashboard.history.isEmpty {
                            emptyHistory(palette)
                        } else {
                            Text("履歴")
                                .font(.headline)
                                .padding(.top, ShannonSpacing.small)
                            LazyVStack(spacing: ShannonSpacing.small) {
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
                        HStack(spacing: ShannonSpacing.medium) {
                            Text(errorMessage)
                                .font(.subheadline)
                                .foregroundStyle(palette.onDangerTint)
                            Spacer(minLength: 0)
                            Button("再試行") { Task { await model.reload() } }
                                .font(.subheadline.weight(.semibold))
                            Button(action: model.dismissError) {
                                Image(systemName: "xmark")
                            }
                            .accessibilityLabel("閉じる")
                        }
                        .padding(ShannonSpacing.medium)
                        .background(palette.dangerTint, in: RoundedRectangle(cornerRadius: ShannonShape.medium))
                    }
                }
                .padding(ShannonSpacing.large)
            }
            .refreshable { await model.reload() }
            .background(palette.readingSurface)
            .navigationTitle("Release Center")
#if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
#endif
            .toolbar {
                if showsDismissButton {
                    ToolbarItem(placement: .confirmationAction) {
                        Button("完了") { dismiss() }
                    }
                }
            }
        }
        .task { await model.reload() }
    }

    private func releaseRequestCard(palette: ShannonPalette) -> some View {
        VStack(alignment: .leading, spacing: ShannonSpacing.medium) {
            Label("新しい配信", systemImage: "paperplane.fill")
                .font(.headline)
            Text("Shannonに配信作業を依頼し、承認・結果・実機確認まで作業画面で追跡します。")
                .font(.subheadline)
                .foregroundStyle(palette.textSecondary)
            Menu {
                ForEach(ShannonAppleReleaseTarget.allCases, id: \.self) { target in
                    Button("\(target.displayName)を配信") { requestRelease?(target) }
                }
            } label: {
                Label("配信作業を依頼", systemImage: "shippingbox")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
        }
        .padding(ShannonSpacing.large)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(palette.canvas, in: RoundedRectangle(cornerRadius: ShannonShape.large))
        .overlay {
            RoundedRectangle(cornerRadius: ShannonShape.large)
                .stroke(palette.divider.opacity(0.7), lineWidth: 0.7)
        }
    }

    private func releaseProgress(_ release: ShannonReleaseProgressDTO, palette: ShannonPalette) -> some View {
        VStack(alignment: .leading, spacing: ShannonSpacing.medium) {
            HStack {
                Label("Release Center", systemImage: "shippingbox")
                    .font(.headline)
                Spacer()
                if let version = release.buildVersion {
                    Text("Build \(version)")
                        .font(.caption.monospacedDigit())
                        .foregroundStyle(palette.textSecondary)
                }
            }
            Text("配信の7段階を、確認できた事実だけで表示します。")
                .font(.caption)
                .foregroundStyle(palette.textSecondary)
            Text("自動取得はiOS Internal。Mac版は作業画面の結果で確認します。")
                .font(.caption)
                .foregroundStyle(palette.textSecondary)

            VStack(spacing: 0) {
                ForEach(Array(release.gates.enumerated()), id: \.element.id) { index, gate in
                    HStack(spacing: ShannonSpacing.medium) {
                        Image(systemName: gateSymbol(gate.status))
                            .foregroundStyle(gateColor(gate.status, palette: palette))
                            .frame(width: 22)
                        VStack(alignment: .leading, spacing: 2) {
                            Text("\(index + 1). \(gate.key.title)")
                                .font(.callout.weight(.semibold))
                            Text(gateDetail(gate))
                                .font(.caption)
                                .foregroundStyle(palette.textSecondary)
                        }
                        Spacer()
                        if gate.status == .pending && (gate.key == .install || gate.key == .smoke) {
                            Button(gate.key == .install ? "インストール済み" : "実機確認済み") {
                                Task { await model.confirm(gate.key) }
                            }
                            .buttonStyle(.bordered)
                            .controlSize(.small)
                            .disabled(model.isLoading || !canConfirm(gate.key, in: release))
                        }
                    }
                    .padding(.vertical, ShannonSpacing.small)
                    if index < release.gates.count - 1 { Divider() }
                }
            }
        }
        .padding(ShannonSpacing.large)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(palette.canvas, in: RoundedRectangle(cornerRadius: ShannonShape.large))
        .overlay {
            RoundedRectangle(cornerRadius: ShannonShape.large)
                .stroke(palette.divider.opacity(0.7), lineWidth: 0.7)
        }
    }

    private func canConfirm(_ gate: ShannonReleaseGateKeyDTO, in release: ShannonReleaseProgressDTO) -> Bool {
        guard release.buildVersion != nil else { return false }
        let completed = Set(release.gates.filter { $0.status == .complete }.map(\.key))
        if gate == .install { return completed.contains(.assignment) }
        if gate == .smoke { return completed.contains(.install) }
        return false
    }

    private func gateDetail(_ gate: ShannonReleaseGateDTO) -> String {
        switch gate.status {
        case .complete: "確認済み"
        case .attention: "確認が必要"
        case .pending:
            switch gate.key {
            case .install: "TestFlightから実機へインストール"
            case .smoke: "既存データと主要導線を実機確認"
            default: "未確認"
            }
        }
    }

    private func gateSymbol(_ status: ShannonReleaseGateStatusDTO) -> String {
        switch status {
        case .complete: "checkmark.circle.fill"
        case .attention: "exclamationmark.triangle.fill"
        case .pending: "circle"
        }
    }

    private func gateColor(_ status: ShannonReleaseGateStatusDTO, palette: ShannonPalette) -> Color {
        switch status {
        case .complete: palette.success
        case .attention: palette.danger
        case .pending: palette.textSecondary
        }
    }

    private func currentCard(_ dashboard: ShannonTestFlightDeliveryDashboardDTO, palette: ShannonPalette) -> some View {
        HStack(alignment: .top, spacing: ShannonSpacing.medium) {
            Image(systemName: conditionSymbol(dashboard.condition))
                .font(.system(size: 22, weight: .semibold))
                .foregroundStyle(conditionColor(dashboard.condition, palette: palette))
                .frame(width: 48, height: 48)
                .background(conditionColor(dashboard.condition, palette: palette).opacity(0.14), in: Circle())
            VStack(alignment: .leading, spacing: 5) {
                Text(conditionTitle(dashboard.condition))
                    .font(.title3.bold())
                    .foregroundStyle(palette.textPrimary)
                Text(conditionDetail(dashboard))
                    .font(.subheadline)
                    .foregroundStyle(palette.textSecondary)
                if let checkedAt = dashboard.lastCheckedAt {
                    Text("最終確認  \(formattedDate(checkedAt))")
                        .font(.caption)
                        .foregroundStyle(palette.textSecondary)
                        .padding(.top, 2)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(ShannonSpacing.large)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(palette.canvas, in: RoundedRectangle(cornerRadius: ShannonShape.large))
        .overlay {
            RoundedRectangle(cornerRadius: ShannonShape.large)
                .stroke(palette.divider.opacity(0.7), lineWidth: 0.7)
        }
    }

    private func historyRow(_ item: ShannonTestFlightDeliveryHistoryItemDTO, palette: ShannonPalette) -> some View {
        HStack(alignment: .top, spacing: ShannonSpacing.medium) {
            Image(systemName: historySymbol(item.status))
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(item.status == .failed ? palette.danger : palette.action)
                .frame(width: 34, height: 34)
                .background(
                    (item.status == .failed ? palette.dangerTint : palette.userMessage),
                    in: Circle()
                )
            VStack(alignment: .leading, spacing: 3) {
                Text(historyTitle(item))
                    .font(.body.weight(.semibold))
                    .foregroundStyle(palette.textPrimary)
                Text(formattedDate(item.checkedAt))
                    .font(.caption)
                    .foregroundStyle(palette.textSecondary)
                if item.status == .failed, item.notificationStatus == .sent {
                    Text("通知済み")
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(palette.action)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(ShannonSpacing.medium)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(palette.canvas, in: RoundedRectangle(cornerRadius: ShannonShape.medium))
    }

    private func emptyHistory(_ palette: ShannonPalette) -> some View {
        Text("まだ配信履歴はありません。")
            .font(.body)
            .foregroundStyle(palette.textSecondary)
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

    private func conditionColor(_ condition: ShannonTestFlightConditionDTO, palette: ShannonPalette) -> Color {
        condition == .attention ? palette.danger : palette.action
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
