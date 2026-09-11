import Foundation
import Observation

@MainActor
@Observable
public final class ShannonMemoryModel {
    public private(set) var dashboard: ShannonMemoryDashboardDTO?
    public private(set) var isLoading = false
    public private(set) var mutatingMemoryID: String?
    public private(set) var errorMessage: String?

    private let scopeKey: String
    private let client: any ShannonMemoryServing
    private var didLoad = false

    public init(
        scopeKey: String = "local-owner",
        client: any ShannonMemoryServing = ShannonAPIClient()
    ) {
        self.scopeKey = scopeKey
        self.client = client
    }

    public var activeItems: [ShannonMemoryItemDTO] {
        dashboard?.items.filter { $0.status == .active } ?? []
    }

    public var hiddenItems: [ShannonMemoryItemDTO] {
        dashboard?.items.filter { $0.status != .active } ?? []
    }

    public var latestSleepReport: ShannonSleepReportDTO? {
        dashboard?.sleepReports.first
    }

    public func loadIfNeeded() async {
        guard !didLoad else { return }
        didLoad = true
        await reload()
    }

    public func reload() async {
        guard !isLoading else { return }
        isLoading = true
        errorMessage = nil
        defer { isLoading = false }
        do {
            dashboard = try await client.loadMemories(scopeKey: scopeKey)
        } catch {
            errorMessage = "記憶を読み込めませんでした。接続を確認して、もう一度お試しください。"
        }
    }

    public func act(
        on item: ShannonMemoryItemDTO,
        action: ShannonMemoryActionDTO,
        text: String? = nil
    ) async -> Bool {
        guard mutatingMemoryID == nil else { return false }
        mutatingMemoryID = item.id
        errorMessage = nil
        defer { mutatingMemoryID = nil }
        do {
            dashboard = try await client.mutateMemory(
                scopeKey: scopeKey,
                memoryID: item.id,
                action: action,
                text: text
            )
            return true
        } catch {
            errorMessage = "記憶を更新できませんでした。変更は保存されていません。"
            return false
        }
    }

    public func correctKnowledge(answerID: String, answer: String) async -> Bool {
        guard mutatingMemoryID == nil else { return false }
        mutatingMemoryID = answerID
        errorMessage = nil
        defer { mutatingMemoryID = nil }
        do {
            dashboard = try await client.correctKnowledge(scopeKey: scopeKey, answerId: answerID, answer: answer)
            return true
        } catch {
            errorMessage = "知識を訂正できませんでした。"
            return false
        }
    }

    public func dismissError() {
        errorMessage = nil
    }
}
