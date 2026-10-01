import Foundation

@MainActor
struct ShannonAgentTaskStore {
    private struct Snapshot: Codable {
        let tasks: [ShannonAgentTask]
    }

    private let defaults: UserDefaults
    private let prefix = "shannon.agent-task-cache.v1."
    /// v1 stored acknowledged task IDs; a task opened once then never notified again.
    private let legacyAcknowledgementPrefix = "shannon.agent-task-acknowledgements.v1."
    /// v2 stores which attention state of each task the owner has seen.
    private let acknowledgementPrefix = "shannon.agent-task-acknowledgements.v2."

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

    /// Loads what the owner has seen. The first load after the v1 format carries the
    /// old per-task acknowledgements over so finished work does not notify again.
    func loadAcknowledgements(
        scopeKey: String,
        tasks: [ShannonAgentTask],
        now: Date = Date()
    ) -> ShannonAgentTaskAcknowledgements {
        if let data = defaults.data(forKey: acknowledgementPrefix + scopeKey),
           let saved = try? JSONDecoder().decode(ShannonAgentTaskAcknowledgements.self, from: data) {
            return saved
        }
        let legacy = Set((defaults.stringArray(forKey: legacyAcknowledgementPrefix + scopeKey) ?? [])
            .compactMap(UUID.init(uuidString:)))
        guard !legacy.isEmpty else { return ShannonAgentTaskAcknowledgements() }
        let migrated = ShannonAgentTaskAcknowledgements(legacyTaskIDs: legacy, tasks: tasks, migratedAt: now)
        saveAcknowledgements(migrated, scopeKey: scopeKey)
        return migrated
    }

    func saveAcknowledgements(_ acknowledgements: ShannonAgentTaskAcknowledgements, scopeKey: String) {
        guard let data = try? JSONEncoder().encode(acknowledgements) else { return }
        defaults.set(data, forKey: acknowledgementPrefix + scopeKey)
    }

    func remove(scopeKey: String) {
        defaults.removeObject(forKey: prefix + scopeKey)
        defaults.removeObject(forKey: acknowledgementPrefix + scopeKey)
        defaults.removeObject(forKey: legacyAcknowledgementPrefix + scopeKey)
    }

    private static func isLegacyDebugPreview(_ task: ShannonAgentTask) -> Bool {
        task.title == "ログイン障害を調査"
            && task.summary == "認証状態の復元処理を追いかけてるところ。"
            && task.currentAction == "既存の対話履歴を壊さないか確認中"
    }
}
