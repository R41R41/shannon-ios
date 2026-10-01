import Foundation
import Observation

@MainActor
@Observable
public final class ShannonMemoryModel {
    public private(set) var dashboard: ShannonMemoryDashboardDTO?
    public private(set) var cognition = ShannonCognitionDashboardDTO.empty
    public private(set) var isLoading = false
    public private(set) var mutatingMemoryID: String?
    public private(set) var mutatingIntentID: String?
    public private(set) var errorMessage: String?
    public private(set) var cognitionErrorMessage: String?
    /// Shannon's own pursuits and activity record, shown in 頭の中 and Settings.
    public let autonomy: ShannonAutonomyModel

    private let scopeKey: String
    private let client: any ShannonMemoryServing
    private var didLoad = false

    public init(
        scopeKey: String = "local-owner",
        client: any ShannonMemoryServing = ShannonAPIClient()
    ) {
        self.scopeKey = scopeKey
        self.client = client
        self.autonomy = ShannonAutonomyModel(scopeKey: scopeKey, client: client as? any ShannonAutonomyServing)
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

    public var activeIntents: [ShannonCognitiveIntentDTO] {
        cognition.intents.filter { $0.status == .active }
    }

    public var pausedIntents: [ShannonCognitiveIntentDTO] {
        cognition.intents.filter { $0.status == .paused }
    }

    public var closedIntents: [ShannonCognitiveIntentDTO] {
        cognition.intents.filter { $0.status == .completed || $0.status == .dismissed }
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
        cognitionErrorMessage = nil
        defer { isLoading = false }
        do {
            dashboard = try await client.loadMemories(scopeKey: scopeKey)
        } catch {
            errorMessage = "記憶を読み込めませんでした。接続を確認して、もう一度お試しください。"
        }
        do {
            cognition = try await client.loadCognition(scopeKey: scopeKey)
        } catch {
            cognitionErrorMessage = "目的と認知履歴を読み込めませんでした。前回の表示はそのまま残しています。"
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

    public func updateIntent(
        _ intent: ShannonCognitiveIntentDTO,
        status: ShannonCognitiveIntentStatusDTO
    ) async -> Bool {
        guard mutatingIntentID == nil else { return false }
        mutatingIntentID = intent.id
        cognitionErrorMessage = nil
        defer { mutatingIntentID = nil }
        do {
            let updated = try await client.updateCognitiveIntent(
                scopeKey: scopeKey,
                intentID: intent.id,
                status: status
            )
            var intents = cognition.intents
            guard let index = intents.firstIndex(where: { $0.id == updated.id }) else {
                cognitionErrorMessage = "目的の更新結果を確認できませんでした。再読み込みしてください。"
                return false
            }
            intents[index] = updated
            intents.sort { $0.updatedAt > $1.updatedAt }
            cognition = ShannonCognitionDashboardDTO(intents: intents, recentCycles: cognition.recentCycles)
            return true
        } catch let error as ShannonAPIError where error == .rejected(status: 409) {
            cognitionErrorMessage = "同じ内容の継続中の目的があります。再読み込みして整理してください。"
            return false
        } catch {
            cognitionErrorMessage = "目的を更新できませんでした。変更は保存されていません。"
            return false
        }
    }

    public func dismissError() {
        errorMessage = nil
        cognitionErrorMessage = nil
    }
}
