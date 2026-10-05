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

public enum ShannonWorldSourceKindDTO: String, Codable, Sendable {
    case rss
    case weather
    case hackerNews = "hacker-news"
    case arxiv
    case pubmed
    case bluesky
    case github
}

public enum ShannonWorldSourceOriginDTO: String, Codable, Sendable {
    case builtIn = "built-in"
    case approvedSubscription = "approved-subscription"
}

public struct ShannonWorldSourceDTO: Codable, Equatable, Identifiable, Sendable {
    public let id: String
    public let kind: ShannonWorldSourceKindDTO
    public let title: String
    public let url: String
    public let enabled: Bool
    public let intervalMinutes: Int
    public let lastRunAt: String?
    public let nextRunAt: String
    public let hasError: Bool
    public let fetchedItemCount: Int
    public let origin: ShannonWorldSourceOriginDTO

    public init(
        id: String,
        kind: ShannonWorldSourceKindDTO,
        title: String,
        url: String,
        enabled: Bool,
        intervalMinutes: Int,
        lastRunAt: String?,
        nextRunAt: String,
        hasError: Bool,
        fetchedItemCount: Int,
        origin: ShannonWorldSourceOriginDTO
    ) {
        self.id = id
        self.kind = kind
        self.title = title
        self.url = url
        self.enabled = enabled
        self.intervalMinutes = intervalMinutes
        self.lastRunAt = lastRunAt
        self.nextRunAt = nextRunAt
        self.hasError = hasError
        self.fetchedItemCount = fetchedItemCount
        self.origin = origin
    }
}

public struct ShannonWorldSourceListDTO: Codable, Equatable, Sendable {
    public let sources: [ShannonWorldSourceDTO]
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
    public private(set) var sources: [ShannonWorldSourceDTO]
    public private(set) var subscriptions: [ShannonWorldSubscriptionDTO]
    public private(set) var isLoading = false
    public private(set) var decidingID: String?
    public private(set) var errorMessage: String?

    private let scopeKey: String
    private let client: any ShannonWorldServing

    public init(
        scopeKey: String = "local-owner",
        client: any ShannonWorldServing = ShannonAPIClient(),
        sources: [ShannonWorldSourceDTO] = [],
        subscriptions: [ShannonWorldSubscriptionDTO] = []
    ) {
        self.scopeKey = scopeKey
        self.client = client
        self.sources = sources
        self.subscriptions = subscriptions
    }

    public var pendingCount: Int {
        subscriptions.count { $0.approval == .pending }
    }

    public var summary: String {
        if pendingCount > 0 { return "新しい候補 " + String(pendingCount) + "件" }
        let enabledCount = sources.count { $0.enabled }
        return enabledCount > 0 ? "情報源 " + String(enabledCount) + "件" : "情報源と試読状況"
    }

    public func reload() async {
        guard !isLoading, decidingID == nil else { return }
        isLoading = true
        errorMessage = nil
        defer { isLoading = false }
        var failed = false
        do {
            subscriptions = try await client.loadWorldSubscriptions(scopeKey: scopeKey)
        } catch {
            failed = true
        }
        do {
            sources = try await client.loadWorldSources(scopeKey: scopeKey)
        } catch {
            failed = true
        }
        if failed {
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
            if let refreshedSources = try? await client.loadWorldSources(scopeKey: scopeKey) {
                sources = refreshedSources
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
                if model.sources.isEmpty, model.subscriptions.isEmpty, !model.isLoading {
                    ContentUnavailableView(
                        "情報源はありません",
                        systemImage: "newspaper",
                        description: Text("接続後、シャノンが読んでいる公開情報源と新しい候補がここに表示されます。")
                    )
                }

                let enabledSources = model.sources.filter(\.enabled)
                if !enabledSources.isEmpty {
                    Section("読んでいる情報源") {
                        ForEach(enabledSources) { source in
                            sourceRow(source)
                        }
                    }
                }

                let pausedSources = model.sources.filter { !$0.enabled }
                if !pausedSources.isEmpty {
                    Section("停止中") {
                        ForEach(pausedSources) { source in
                            sourceRow(source)
                        }
                    }
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
                    Text("標準の公開情報源と、あなたが承認した候補だけを読みます。候補は承認後に7日間だけ試読し、役立たなければ自動で停止します。非公開・認証が必要な情報源は対象外です。")
                        .font(.shannon(.footnote))
                        .foregroundStyle(.secondary)
                    if let noticeURL = URL(string: "https://www.ncbi.nlm.nih.gov/home/about/policies/") {
                        Link("PubMed／NCBIの免責・著作権", destination: noticeURL)
                            .font(.shannon(.footnote))
                    }
                }

                if let errorMessage = model.errorMessage {
                    Section {
                        Text(errorMessage)
                            .font(.shannon(.footnote))
                            .foregroundStyle(Color.shannonDanger)
                    }
                }
            }
            .navigationTitle("情報源")
            .refreshable { await model.reload() }
            .overlay {
                if model.isLoading, model.sources.isEmpty, model.subscriptions.isEmpty {
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

    private func sourceRow(_ source: ShannonWorldSourceDTO) -> some View {
        VStack(alignment: .leading, spacing: 7) {
            VStack(alignment: .leading, spacing: 3) {
                Text(source.title)
                    .font(.shannon(.headline))
                if source.origin == .approvedSubscription {
                    Label("承認済み", systemImage: "checkmark.circle")
                        .font(.shannon(.caption2).weight(.semibold))
                        .foregroundStyle(.secondary)
                }
                if let url = URL(string: source.url) {
                    Link(url.host() ?? source.url, destination: url)
                        .font(.shannon(.caption))
                        .lineLimit(1)
                }
            }
            Label(sourceStatus(source), systemImage: sourceSymbol(source))
                .font(.shannon(.caption))
                .foregroundStyle(source.enabled && source.hasError ? Color.shannonAttention : .secondary)
            if source.fetchedItemCount > 0 || source.enabled {
                HStack(spacing: 8) {
                    if source.fetchedItemCount > 0 {
                        Text("取得 \(source.fetchedItemCount)件")
                    }
                    if source.enabled {
                        Text(intervalLabel(source.intervalMinutes))
                    }
                }
                .font(.shannon(.caption))
                .foregroundStyle(.secondary)
            }
            if let lastRunAt = source.lastRunAt,
               let lastRunDate = try? Date(
                   lastRunAt,
                   strategy: Date.ISO8601FormatStyle(includingFractionalSeconds: true)
               ) {
                HStack(spacing: 4) {
                    Text("最終取得")
                    Text(lastRunDate, style: .relative)
                }
                .font(.shannon(.caption2))
                .foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 3)
    }

    private func sourceStatus(_ source: ShannonWorldSourceDTO) -> String {
        if !source.enabled { return "停止" }
        if source.hasError { return "再試行中" }
        if source.lastRunAt == nil { return "取得待ち" }
        return "更新済み"
    }

    private func sourceSymbol(_ source: ShannonWorldSourceDTO) -> String {
        if !source.enabled { return "pause.circle" }
        if source.hasError { return "exclamationmark.arrow.triangle.2.circlepath" }
        if source.lastRunAt == nil { return "clock" }
        return "checkmark.circle"
    }

    private func intervalLabel(_ minutes: Int) -> String {
        if minutes.isMultiple(of: 1_440) { return "\(minutes / 1_440)日ごと" }
        if minutes.isMultiple(of: 60) { return "\(minutes / 60)時間ごと" }
        return "\(minutes)分ごと"
    }

    private func proposalRow(_ subscription: ShannonWorldSubscriptionDTO) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            sourceHeader(subscription)
            Text(subscription.reason)
                .font(.shannon(.callout))
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
            .font(.shannon(.caption))
            .foregroundStyle(.secondary)
        }
        .padding(.vertical, 3)
    }

    private func sourceHeader(_ subscription: ShannonWorldSubscriptionDTO) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(subscription.title)
                .font(.shannon(.headline))
            if let url = URL(string: subscription.feedURL) {
                Link(url.host() ?? subscription.feedURL, destination: url)
                    .font(.shannon(.caption))
                    .lineLimit(1)
            } else {
                Text(subscription.feedURL)
                    .font(.shannon(.caption))
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
