import Foundation
import Observation
import SwiftUI

public enum ShannonWorldSubscriptionApprovalDTO: String, Codable, Sendable {
    case pending
    case approved
    case rejected
}

public enum ShannonWorldSubscriptionStatusDTO: String, Codable, Sendable {
    case trial
    case active
    case paused
    case rejected
}

public enum ShannonWorldSubscriptionDecisionDTO: String, Codable, Sendable {
    case approve
    case reject
}

public struct ShannonWorldSubscriptionDTO: Codable, Equatable, Identifiable, Sendable {
    public let id: String
    public let feedURL: String
    public let title: String
    public let status: ShannonWorldSubscriptionStatusDTO
    public let approval: ShannonWorldSubscriptionApprovalDTO
    public let reason: String
    public let discoveredAt: String
    public let trialExpiresAt: String
    public let fetchedItemCount: Int
    public let updatedAt: String

    public init(
        id: String,
        feedURL: String,
        title: String,
        status: ShannonWorldSubscriptionStatusDTO,
        approval: ShannonWorldSubscriptionApprovalDTO,
        reason: String,
        discoveredAt: String,
        trialExpiresAt: String,
        fetchedItemCount: Int,
        updatedAt: String
    ) {
        self.id = id
        self.feedURL = feedURL
        self.title = title
        self.status = status
        self.approval = approval
        self.reason = reason
        self.discoveredAt = discoveredAt
        self.trialExpiresAt = trialExpiresAt
        self.fetchedItemCount = fetchedItemCount
        self.updatedAt = updatedAt
    }
}

public struct ShannonWorldSubscriptionListDTO: Codable, Equatable, Sendable {
    public let subscriptions: [ShannonWorldSubscriptionDTO]
}

public struct ShannonWorldSubscriptionDecisionRequestDTO: Codable, Equatable, Sendable {
    public let scopeKey: String
    public let decision: ShannonWorldSubscriptionDecisionDTO
    public let expectedUpdatedAt: String
}

@MainActor
@Observable
public final class ShannonWorldSubscriptionModel {
    public private(set) var subscriptions: [ShannonWorldSubscriptionDTO]
    public private(set) var isLoading = false
    public private(set) var decidingID: String?
    public private(set) var errorMessage: String?

    private let scopeKey: String
    private let client: any ShannonAPIClientProtocol

    public init(
        scopeKey: String = "local-owner",
        client: any ShannonAPIClientProtocol = ShannonAPIClient(),
        subscriptions: [ShannonWorldSubscriptionDTO] = []
    ) {
        self.scopeKey = scopeKey
        self.client = client
        self.subscriptions = subscriptions
    }

    public var pendingCount: Int {
        subscriptions.count { $0.approval == .pending }
    }

    public var summary: String {
        pendingCount > 0 ? "新しい候補 " + String(pendingCount) + "件" : "購読候補と試読状況"
    }

    public func reload() async {
        guard !isLoading, decidingID == nil else { return }
        isLoading = true
        errorMessage = nil
        defer { isLoading = false }
        do {
            subscriptions = try await client.loadWorldSubscriptions(scopeKey: scopeKey)
        } catch {
            errorMessage = "情報源を読み込めませんでした。接続を確認してください。"
        }
    }

    public func decide(
        _ subscription: ShannonWorldSubscriptionDTO,
        decision: ShannonWorldSubscriptionDecisionDTO
    ) async {
        guard decidingID == nil, subscription.approval == .pending else { return }
        decidingID = subscription.id
        errorMessage = nil
        defer { decidingID = nil }
        do {
            let updated = try await client.decideWorldSubscription(
                scopeKey: scopeKey,
                subscriptionID: subscription.id,
                decision: decision,
                expectedUpdatedAt: subscription.updatedAt
            )
            if let index = subscriptions.firstIndex(where: { $0.id == updated.id }) {
                subscriptions[index] = updated
            } else {
                await reload()
            }
        } catch let error as ShannonAPIError {
            if case .rejected(status: 409) = error {
                decidingID = nil
                await reload()
                errorMessage = "この候補は別の端末で更新されました。最新状態を読み直しました。"
            } else {
                errorMessage = "判断を保存できませんでした。少し待ってもう一度お試しください。"
            }
        } catch {
            errorMessage = "判断を保存できませんでした。少し待ってもう一度お試しください。"
        }
    }
}

public struct ShannonWorldSubscriptionView: View {
    @Bindable private var model: ShannonWorldSubscriptionModel
    @Environment(\.dismiss) private var dismiss

    public init(model: ShannonWorldSubscriptionModel) {
        self.model = model
    }

    public var body: some View {
        NavigationStack {
            List {
                if model.subscriptions.isEmpty, !model.isLoading {
                    ContentUnavailableView(
                        "購読候補はありません",
                        systemImage: "newspaper",
                        description: Text("シャノンが良さそうな公開情報源を見つけた時だけ、ここで相談します。")
                    )
                }

                let pending = model.subscriptions.filter { $0.approval == .pending }
                if !pending.isEmpty {
                    Section("確認が必要") {
                        ForEach(pending) { subscription in
                            proposalRow(subscription)
                        }
                    }
                }

                let decided = model.subscriptions.filter { $0.approval != .pending }
                if !decided.isEmpty {
                    Section("試読と購読") {
                        ForEach(decided) { subscription in
                            decidedRow(subscription)
                        }
                    }
                }

                Section {
                    Text("候補を承認するまで取得は始まりません。承認後は7日間だけ試読し、役立たない情報源は自動で停止します。非公開・認証が必要な情報源は対象外です。")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }

                if let errorMessage = model.errorMessage {
                    Section {
                        Text(errorMessage)
                            .font(.footnote)
                            .foregroundStyle(.red)
                    }
                }
            }
            .navigationTitle("情報源")
            .refreshable { await model.reload() }
            .overlay {
                if model.isLoading, model.subscriptions.isEmpty {
                    ProgressView("情報源を確認中")
                }
            }
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("完了") { dismiss() }
                }
            }
            .task { await model.reload() }
        }
    }

    private func proposalRow(_ subscription: ShannonWorldSubscriptionDTO) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            sourceHeader(subscription)
            Text(subscription.reason)
                .font(.callout)
                .foregroundStyle(.secondary)
            HStack {
                Button("今回は見送る", role: .destructive) {
                    Task { await model.decide(subscription, decision: .reject) }
                }
                .disabled(model.decidingID != nil)
                Spacer()
                Button("7日間試す") {
                    Task { await model.decide(subscription, decision: .approve) }
                }
                .buttonStyle(.borderedProminent)
                .disabled(model.decidingID != nil)
            }
            if model.decidingID == subscription.id {
                ProgressView("保存中")
                    .controlSize(.small)
            }
        }
        .padding(.vertical, 4)
    }

    private func decidedRow(_ subscription: ShannonWorldSubscriptionDTO) -> some View {
        VStack(alignment: .leading, spacing: 7) {
            sourceHeader(subscription)
            HStack(spacing: 8) {
                Label(statusLabel(subscription), systemImage: statusSymbol(subscription))
                if subscription.fetchedItemCount > 0 {
                    Text("取得 \(subscription.fetchedItemCount)件")
                }
            }
            .font(.caption)
            .foregroundStyle(.secondary)
        }
        .padding(.vertical, 3)
    }

    private func sourceHeader(_ subscription: ShannonWorldSubscriptionDTO) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(subscription.title)
                .font(.headline)
            if let url = URL(string: subscription.feedURL) {
                Link(url.host() ?? subscription.feedURL, destination: url)
                    .font(.caption)
                    .lineLimit(1)
            } else {
                Text(subscription.feedURL)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
        }
    }

    private func statusLabel(_ subscription: ShannonWorldSubscriptionDTO) -> String {
        switch subscription.status {
        case .trial: "試読中"
        case .active: "購読中"
        case .paused: "停止"
        case .rejected: "見送り"
        }
    }

    private func statusSymbol(_ subscription: ShannonWorldSubscriptionDTO) -> String {
        switch subscription.status {
        case .trial: "clock"
        case .active: "checkmark.circle.fill"
        case .paused: "pause.circle"
        case .rejected: "xmark.circle"
        }
    }
}
