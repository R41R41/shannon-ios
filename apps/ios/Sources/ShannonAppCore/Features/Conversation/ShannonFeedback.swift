import Foundation
import Observation

public enum ShannonFeedbackReaction: String, Codable, Sendable { case good, bad }

/// Eligibility and identity are supplied by the server; clients never infer them from reply text.
public struct ShannonFeedbackDTO: Codable, Equatable, Sendable {
    public let targetId: String
    public let threadId: String
    public let turnId: String
    public let revision: Int
    public let reaction: ShannonFeedbackReaction?
    public let operationId: String?
}

public struct ShannonFeedbackReadDTO: Codable, Sendable {
    public let feedback: ShannonFeedbackDTO
    public let operation: ShannonFeedbackDTO?
}

public protocol ShannonFeedbackServing: Sendable {
    func loadFeedback(scopeKey: String, target: ShannonFeedbackDTO, operationID: String?) async throws -> ShannonFeedbackReadDTO
    func changeFeedback(scopeKey: String, target: ShannonFeedbackDTO, reaction: ShannonFeedbackReaction?, operationID: String) async throws -> ShannonFeedbackDTO
}

@MainActor @Observable
public final class ShannonFeedbackModel {
    public private(set) var targets: [String: ShannonFeedbackDTO] = [:]
    public private(set) var notices: [String: String] = [:]
    public private(set) var pending: [String: Pending] = [:]
    public private(set) var freshTargets: Set<String> = []
    public private(set) var othersPresent = false
    public private(set) var threadID: String?
    private let scopeKey: String
    private let client: (any ShannonFeedbackServing)?
    private var generation = 0
    public var contextRevision: Int { generation }
    private var readRevisions: [String: Int] = [:]
    public struct Pending: Sendable {
        let target: ShannonFeedbackDTO
        let operationID: String
        let reaction: ShannonFeedbackReaction?
        public var checking: Bool
    }

    public init(scopeKey: String, client: (any ShannonFeedbackServing)?) {
        self.scopeKey = scopeKey; self.client = client
    }

    public func setContext(threadID: String?, othersPresent: Bool) {
        guard self.threadID != threadID || self.othersPresent != othersPresent else { return }
        generation += 1
        self.threadID = threadID; self.othersPresent = othersPresent
        targets = [:]; notices = [:]; readRevisions = [:]; freshTargets = []
    }

    public func install(_ values: [ShannonFeedbackDTO], threadID: String) {
        guard client != nil, !othersPresent, self.threadID == threadID else { return }
        for value in values where value.threadId == threadID { accept(value); freshTargets.insert(value.targetId) }
    }

    public func state(for target: ShannonFeedbackDTO) -> ShannonFeedbackDTO? {
        guard !othersPresent, threadID == target.threadId else { return nil }
        return targets[target.targetId]
    }

    public func choose(_ reaction: ShannonFeedbackReaction, target: ShannonFeedbackDTO) async {
        guard let client, let current = state(for: target), pending[target.targetId] == nil,
              freshTargets.contains(target.targetId) else { return }
        let operation = Pending(target: current, operationID: UUID().uuidString,
                                reaction: current.reaction == reaction ? nil : reaction, checking: false)
        pending[target.targetId] = operation
        notices[target.targetId] = nil
        let epoch = generation
        do {
            let updated = try await client.changeFeedback(scopeKey: scopeKey, target: current,
                reaction: operation.reaction, operationID: operation.operationID)
            guard updated.targetId == current.targetId, updated.threadId == current.threadId,
                  updated.operationId == operation.operationID else { throw ShannonAPIError.invalidResponse }
            if pending[current.targetId]?.operationID == operation.operationID { pending[current.targetId] = nil }
            guard epoch == generation, !othersPresent else { return }
            accept(updated)
            freshTargets.insert(current.targetId)
        } catch {
            if Self.definiteRefusal(error) {
                if pending[current.targetId]?.operationID == operation.operationID { pending[current.targetId] = nil }
                guard epoch == generation, !othersPresent else { return }
                notices[current.targetId] = "変更されませんでした。最新の状態を確認します。"
                await check(current)
            } else {
                if pending[current.targetId]?.operationID == operation.operationID { pending[current.targetId]?.checking = true }
                guard epoch == generation, !othersPresent else { return }
                notices[current.targetId] = "届いたか確かめています…"
                await check(current)
            }
        }
    }

    /// A GET can confirm a previous write; it never retries that write.
    public func check(_ target: ShannonFeedbackDTO) async {
        guard let client, !othersPresent, threadID == target.threadId else { return }
        let epoch = generation
        let revision = readRevisions[target.targetId, default: 0] + 1
        readRevisions[target.targetId] = revision
        freshTargets.remove(target.targetId)
        let operation = pending[target.targetId]
        do {
            let response = try await client.loadFeedback(scopeKey: scopeKey, target: target, operationID: operation?.operationID)
            guard response.feedback.targetId == target.targetId, response.feedback.threadId == target.threadId else {
                throw ShannonAPIError.invalidResponse
            }
            // Resolve the operation even when another, newer GET already won display freshness.
            if let operation, response.operation?.operationId == operation.operationID,
               response.operation?.targetId == target.targetId, response.operation?.threadId == target.threadId,
               pending[target.targetId]?.operationID == operation.operationID {
                pending[target.targetId] = nil
                if epoch == generation, !othersPresent { notices[target.targetId] = nil }
            }
            guard epoch == generation, readRevisions[target.targetId] == revision, !othersPresent else { return }
            accept(response.feedback)
            freshTargets.insert(target.targetId)
            notices[target.targetId] = pending[target.targetId] == nil ? nil : "届いたか確かめています…"
        } catch {
            guard epoch == generation, readRevisions[target.targetId] == revision else { return }
            freshTargets.remove(target.targetId)
            if Self.hidden(error) { targets[target.targetId] = nil; notices[target.targetId] = nil }
            else { notices[target.targetId] = pending[target.targetId] == nil ? "接続を確認して、もう一度お試しください。" : "届いたか確認できません。接続後に確認してください。" }
        }
    }

    private func accept(_ value: ShannonFeedbackDTO) {
        guard value.revision >= (targets[value.targetId]?.revision ?? -1) else { return }
        targets[value.targetId] = value
    }
    static func definiteRefusal(_ error: any Error) -> Bool {
        guard case ShannonAPIError.rejected(let status) = error else { return false }
        // A 403 may hide an already accepted write after the audience changes.
        return [400, 401, 409, 422].contains(status)
    }
    static func hidden(_ error: any Error) -> Bool {
        guard case ShannonAPIError.rejected(let status) = error else { return false }
        return [401, 403, 404].contains(status)
    }
}
