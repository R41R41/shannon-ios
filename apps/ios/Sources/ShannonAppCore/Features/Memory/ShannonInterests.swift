import Foundation
import Observation

public struct ShannonInterestDTO: Codable, Identifiable, Equatable, Sendable {
    public let id: String
    public let title: String
    public let description: String
    public let reason: String
    public var weight: Double? = nil
    public var evidenceRefs: [String]? = nil
    public let revision: Int
    public let pinned: Bool
    public let banned: Bool
    public let forgotten: Bool
    public let frozen: Bool
    public let retired: Bool
    public let createdAt: String
    public let updatedAt: String
    public var active: Bool { !banned && !forgotten && !retired }
}
public struct ShannonInterestChangeDTO: Codable, Identifiable, Equatable, Sendable {
    public var id: String { changeId }
    public let changeId: String
    public let seq: Int
    public let itemId: String
    public let actor: String
    public let kind: String
    public let reason: String
    public let before: ShannonInterestDTO?
    public let after: ShannonInterestDTO
    public let nightKey: String?
    public let createdAt: String
}
public struct ShannonInterestsDTO: Codable, Equatable, Sendable {
    public let revision: Int
    public let items: [ShannonInterestDTO]
    public let changes: [ShannonInterestChangeDTO]
    public let capacity: Capacity
    public let nextCursor: Int?
    public struct Capacity: Codable, Equatable, Sendable { public let used: Int; public let limit: Int }
}
public struct ShannonInterestDetailDTO: Codable, Sendable {
    public let revision: Int
    public let item: ShannonInterestDTO
    public let changes: [ShannonInterestChangeDTO]
    public let nextCursor: Int?
    public var evidence: Evidence? = nil
    public struct Evidence: Codable, Sendable {
        public let status: String
        public let total: Int
        public let items: [Item]
        public let omitted: Int
        public struct Item: Codable, Identifiable, Sendable { public let id: String; public let text: String; public let truncated: Bool }
    }
}
public enum ShannonInterestAction: String, Codable, Sendable { case undo, pin, unpin, ban, unban, forget, resume }
public struct ShannonInterestMutationDTO: Codable, Sendable {
    public let code: String
    public let item: ShannonInterestDTO?
    public let revision: Int
}
public struct ShannonInterestOperationDTO: Codable, Sendable {
    public let operationId: String
    public let found: Bool
    public let result: ShannonInterestMutationDTO?
    public let latest: ShannonInterestsDTO
}
public protocol ShannonInterestsServing: Sendable {
    func loadInterests(scopeKey: String, cursor: Int?) async throws -> ShannonInterestsDTO
    func loadInterest(scopeKey: String, id: String, cursor: Int?) async throws -> ShannonInterestDetailDTO
    func changeInterest(scopeKey: String, item: ShannonInterestDTO, action: ShannonInterestAction, changeID: String?, operationID: String) async throws -> ShannonInterestMutationDTO
    func loadInterestOperation(scopeKey: String, operationID: String) async throws -> ShannonInterestOperationDTO
}

@MainActor @Observable
public final class ShannonInterestsModel {
    public private(set) var snapshot: ShannonInterestsDTO?
    public private(set) var changes: [ShannonInterestChangeDTO] = []
    public private(set) var isLoading = false
    public private(set) var fresh = false
    public private(set) var hidden = false
    public private(set) var othersPresent = false
    public private(set) var notice: String?
    public private(set) var pending: Pending?
    public private(set) var details: [String: ShannonInterestDetailDTO] = [:]
    private let scopeKey: String
    private let client: (any ShannonInterestsServing)?
    private var generation = 0
    private var didLoad = false
    public struct Pending: Sendable {
        public let itemID: String
        let operationID: String
        public var checking: Bool
    }
    public init(scopeKey: String, client: (any ShannonInterestsServing)?) { self.scopeKey = scopeKey; self.client = client }
    public var offered: Bool { snapshot != nil && !hidden }
    public func setAudience(othersPresent: Bool) {
        guard self.othersPresent != othersPresent else { return }
        generation += 1; self.othersPresent = othersPresent; hidden = othersPresent
        snapshot = nil; changes = []; details = [:]; fresh = false; notice = nil; didLoad = false; isLoading = false
    }
    public func item(_ id: String) -> ShannonInterestDTO? {
        let latest = snapshot?.items.first { $0.id == id }
        let detail = details[id]?.item
        return (detail?.revision ?? -1) > (latest?.revision ?? -1) ? detail : latest
    }
    public func loadDetail(_ id: String, cursor: Int? = nil) async {
        guard let client, !hidden, !othersPresent else { return }
        let epoch = generation
        do {
            let value = try await client.loadInterest(scopeKey: scopeKey, id: id, cursor: cursor)
            guard generation == epoch, value.item.id == id, value.revision >= (snapshot?.revision ?? 0) else { return }
            let previous = cursor == nil ? [] : details[id]?.changes ?? []
            let all = Dictionary((previous + value.changes).map { ($0.id, $0) }, uniquingKeysWith: { $1 }).values.sorted { $0.seq > $1.seq }
            details[id] = ShannonInterestDetailDTO(revision: value.revision, item: value.item, changes: all, nextCursor: value.nextCursor, evidence: value.evidence)
        } catch {
            guard generation == epoch else { return }
            if ShannonFeedbackModel.hidden(error) { hidden = true; snapshot = nil; changes = []; details = [:]; fresh = false }
            notice = "関心の詳細を読み込めません。最新の内容を読み直してください。"
        }
    }
    public func loadIfNeeded() async {
        guard !didLoad else { return }; didLoad = true; await reload()
    }
    public func reload(cursor: Int? = nil) async {
        guard let client, !othersPresent else { hidden = true; return }
        didLoad = true
        generation += 1; let epoch = generation
        fresh = false
        isLoading = true
        defer { if generation == epoch { isLoading = false } }
        do {
            let result = try await client.loadInterests(scopeKey: scopeKey, cursor: cursor)
            guard epoch == generation else { return }
            accept(result, append: cursor != nil)
            hidden = false
            fresh = true
            notice = pending == nil ? nil : "届いたか確かめています…"
        } catch {
            guard epoch == generation else { return }
            hidden = ShannonFeedbackModel.hidden(error)
            if hidden { snapshot = nil; changes = []; details = [:] }
            else { notice = "関心を読み込めません。接続を確認してください。" }
        }
    }
    public func perform(item: ShannonInterestDTO, action: ShannonInterestAction, changeID: String? = nil) async {
        guard let client, !hidden, fresh, !othersPresent, pending == nil else { return }
        let operation = Pending(itemID: item.id, operationID: UUID().uuidString, checking: false)
        pending = operation; notice = nil
        do {
            let result = try await client.changeInterest(scopeKey: scopeKey, item: item, action: action,
                changeID: changeID, operationID: operation.operationID)
            guard result.code == "changed" else { throw ShannonAPIError.rejected(status: 409) }
            // The mutation's item may be older than a concurrent read. Always read the current journal.
            if pending?.operationID == operation.operationID { pending = nil }
            await reload()
        } catch {
            if ShannonFeedbackModel.definiteRefusal(error) {
                if pending?.operationID == operation.operationID { pending = nil }
                await reload()
                notice = "変更されませんでした。最新の内容を表示しています。"
            } else {
                if pending?.operationID == operation.operationID { pending?.checking = true }
                notice = "届いたか確かめています…"
                await checkPending()
            }
        }
    }
    public func checkPending() async {
        guard !othersPresent else { return }
        guard let client, let operation = pending else { await reload(); return }
        generation += 1; let epoch = generation
        do {
            let response = try await client.loadInterestOperation(scopeKey: scopeKey, operationID: operation.operationID)
            guard response.operationId == operation.operationID else { throw ShannonAPIError.invalidResponse }
            let acknowledged = response.found && response.result != nil
            if acknowledged, pending?.operationID == operation.operationID {
                pending = nil
                if !hidden { notice = nil }
            }
            guard epoch == generation else { return }
            accept(response.latest, append: false)
            hidden = false
            fresh = true
            notice = acknowledged ? (response.result?.code == "changed" ? nil : "変更されませんでした。最新の内容を表示しています。") : "届いたか確かめています…"
        } catch {
            guard epoch == generation else { return }
            hidden = ShannonFeedbackModel.hidden(error)
            if hidden { snapshot = nil; changes = []; details = [:] }
            notice = "届いたか確認できません。接続後に確認してください。"
        }
    }
    private func accept(_ value: ShannonInterestsDTO, append: Bool) {
        guard value.revision >= (snapshot?.revision ?? -1) else { return }
        snapshot = value
        details = [:]
        let all = (append ? changes : []) + value.changes
        changes = Dictionary(all.map { ($0.id, $0) }, uniquingKeysWith: { $1 }).values.sorted { $0.seq > $1.seq }
    }
}
