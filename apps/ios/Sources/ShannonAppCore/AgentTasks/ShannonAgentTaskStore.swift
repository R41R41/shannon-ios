import Foundation

@MainActor
struct ShannonAgentTaskStore {
    private struct Snapshot: Codable {
        let tasks: [ShannonAgentTask]
    }

    private let defaults: UserDefaults
    private let prefix = "shannon.agent-task-cache.v1."
    private let acknowledgementPrefix = "shannon.agent-task-acknowledgements.v1."

    static let standard = ShannonAgentTaskStore(defaults: .standard)

    init(defaults: UserDefaults) {
        self.defaults = defaults
    }

    func load(scopeKey: String) -> [ShannonAgentTask] {
        guard let data = defaults.data(forKey: prefix + scopeKey),
              let snapshot = try? JSONDecoder().decode(Snapshot.self, from: data)
        else { return [] }
        return snapshot.tasks
            .filter { !Self.isLegacyDebugPreview($0) }
            .sorted { $0.updatedAt > $1.updatedAt }
    }

    func save(_ tasks: [ShannonAgentTask], scopeKey: String) {
        guard let data = try? JSONEncoder().encode(Snapshot(tasks: tasks)) else { return }
        defaults.set(data, forKey: prefix + scopeKey)
    }

    func loadAcknowledgedTaskIDs(scopeKey: String) -> Set<UUID> {
        let values = defaults.stringArray(forKey: acknowledgementPrefix + scopeKey) ?? []
        return Set(values.compactMap(UUID.init(uuidString:)))
    }

    func saveAcknowledgedTaskIDs(_ ids: Set<UUID>, scopeKey: String) {
        defaults.set(ids.map(\.uuidString).sorted(), forKey: acknowledgementPrefix + scopeKey)
    }

    func remove(scopeKey: String) {
        defaults.removeObject(forKey: prefix + scopeKey)
        defaults.removeObject(forKey: acknowledgementPrefix + scopeKey)
    }

    private static func isLegacyDebugPreview(_ task: ShannonAgentTask) -> Bool {
        task.title == "ログイン障害を調査"
            && task.summary == "認証状態の復元処理を追いかけてるところ。"
            && task.currentAction == "既存の対話履歴を壊さないか確認中"
    }
}
