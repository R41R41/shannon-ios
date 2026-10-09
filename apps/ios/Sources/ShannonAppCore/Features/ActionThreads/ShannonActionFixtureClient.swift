#if DEBUG
import Foundation
/// Synthetic, isolated preview. Never reads or controls the production server.
actor ShannonActionFixtureClient: ShannonActionThreadsServing {
    nonisolated static var isRequested: Bool { UserDefaults.standard.bool(forKey: "ShannonPreviewActionThreads") || (Bundle.main.object(forInfoDictionaryKey: "ShannonPreviewActionThreads") as? Bool == true) }
    private var states: [String]
    private var acknowledged = Set<String>()
    private let scenario: String
    init() {
        scenario = UserDefaults.standard.string(forKey: "ShannonPreviewActionState") ?? (Bundle.main.object(forInfoDictionaryKey: "ShannonPreviewActionState") as? String) ?? "ready"
        states = scenario == "unknown" ? ["unknown", "stopping", "failed"] : ["running", "waiting", "queued"]
    }
    func loadActionThreads(scopeKey: String, othersPresent: Bool) async throws -> ShannonActionThreadsDTO { reading(others: othersPresent) }
    func controlActionThread(scopeKey: String, id: String?, resume: Bool, requestID: String) async throws -> ShannonActionThreadsDTO {
        for index in states.indices where id == nil || id == "fixture-\(index)" {
            if states[index] != "unknown" { states[index] = resume ? "queued" : "cancelled" }
        }
        return reading(others: false)
    }
    func acknowledgeActionNotice(scopeKey: String, id: String, notificationID: String, requestID: String) async throws -> ShannonActionThreadsDTO {
        guard states.indices.contains(where: { id == "fixture-\($0)" && states[$0] == "unknown" && notificationID == "fixture-notice-\($0)" }) else { throw ShannonAPIError.rejected(status: 409) }
        acknowledged.insert(notificationID)
        return reading(others: false)
    }
    private func reading(others: Bool) -> ShannonActionThreadsDTO {
        let kinds = [scenario == "sleep" ? "agentTask" : "ownTime", "agentTask", "minecraft"]
        let titles = [scenario == "sleep" ? "睡眠整理" : "自分の時間", "作業環境での作業", "Minecraft"]
        let at = Date().formatted(.iso8601)
        return .init(availability: scenario == "recovering" ? "recovering" : "ready", generatedAt: at, count: states.filter { ["running", "waiting", "queued", "stopping"].contains($0) }.count,
            threads: (others || scenario == "others") ? [] : states.indices.map { .init(id: "fixture-\($0)", kind: kinds[$0], title: titles[$0], origin: $0 == 0 ? (scenario == "sleep" ? "maintenance" : "own_time") : "owner_request",
                state: states[$0], progress: nil, result: nil, updatedAt: at, failures: scenario == "unknown" && $0 == 2 ? 5 : 0, canResume: kinds[$0] == "ownTime" && states[$0] == "cancelled", notification: states[$0] == "unknown" ? .init(id: "fixture-notice-\($0)", acknowledgedAt: acknowledged.contains("fixture-notice-\($0)") ? at : nil) : nil) }, othersPresent: others || scenario == "others")
    }
}
#endif
