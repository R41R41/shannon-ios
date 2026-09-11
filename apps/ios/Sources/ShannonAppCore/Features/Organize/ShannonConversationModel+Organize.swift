import Foundation
import Observation

extension ShannonConversationModel {
    public func decideOrganizeItem(
        sessionID: String,
        itemID: String,
        decision: ShannonOrganizeDecisionDTO,
        title: String? = nil,
        details: String? = nil,
        operation: ShannonOrganizeOperationDTO? = nil,
        target: ShannonVoyagerTaskProjectionDTO? = nil,
        projectIds: [String]? = nil
    ) async {
        guard let session = organizeSessions.first(where: { $0.id == sessionID }),
              !pendingOrganizeSessionIDs.contains(sessionID) else { return }
        pendingOrganizeSessionIDs.insert(sessionID)
        organizeActionErrors.removeValue(forKey: sessionID)
        defer { pendingOrganizeSessionIDs.remove(sessionID) }
        do {
            let updated = try await client.decideOrganizeItemV2(
                scopeKey: scopeKey, sessionId: sessionID, itemId: itemID,
                expectedRevision: session.revision, decision: decision,
                title: title, details: details, operation: operation,
                target: target, projectIds: projectIds
            )
            upsertOrganizeSession(updated)
        } catch {
            organizeActionErrors[sessionID] = "Task案を更新できませんでした。もう一度お試しください。"
        }
    }

    public func searchVoyagerTasks(itemID: String, query: String) async {
        let normalized = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalized.isEmpty, !pendingVoyagerCatalogItemIDs.contains(itemID) else { return }
        pendingVoyagerCatalogItemIDs.insert(itemID)
        voyagerCatalogErrorsByItemID.removeValue(forKey: itemID)
        defer { pendingVoyagerCatalogItemIDs.remove(itemID) }
        do {
            async let tasks = client.searchVoyagerTasks(scopeKey: scopeKey, query: normalized)
            async let projects = client.loadVoyagerProjects(scopeKey: scopeKey)
            voyagerTaskCandidatesByItemID[itemID] = try await tasks
            voyagerProjects = try await projects
        } catch {
            voyagerCatalogErrorsByItemID[itemID] = "Voyagerの候補を取得できませんでした。接続を確認して再試行してください。"
        }
    }

    public func loadVoyagerProjects(itemID: String) async {
        guard voyagerProjects.isEmpty, !pendingVoyagerCatalogItemIDs.contains(itemID) else { return }
        pendingVoyagerCatalogItemIDs.insert(itemID)
        voyagerCatalogErrorsByItemID.removeValue(forKey: itemID)
        defer { pendingVoyagerCatalogItemIDs.remove(itemID) }
        do {
            voyagerProjects = try await client.loadVoyagerProjects(scopeKey: scopeKey)
        } catch {
            voyagerCatalogErrorsByItemID[itemID] = "VoyagerのProjectを取得できませんでした。"
        }
    }

    public func applyOrganizeSession(_ sessionID: String) async {
        guard let session = organizeSessions.first(where: { $0.id == sessionID }),
              !pendingOrganizeSessionIDs.contains(sessionID) else { return }
        pendingOrganizeSessionIDs.insert(sessionID)
        organizeActionErrors.removeValue(forKey: sessionID)
        defer { pendingOrganizeSessionIDs.remove(sessionID) }
        do {
            let result = try await client.applyOrganizeSession(
                scopeKey: scopeKey, sessionId: sessionID, expectedRevision: session.revision
            )
            upsertOrganizeSession(result.session)
            if result.session.state == .partiallyApplied {
                organizeActionErrors[sessionID] = "一部をVoyagerへ反映できませんでした。同じ内容で再試行できます。"
            } else if result.appliedCount > 0 {
                let names = result.tasks.map(\.title).joined(separator: "、")
                statusMessage = "Voyagerに\(result.appliedCount)件反映しました：\(names)"
            } else {
                statusMessage = "今回はVoyagerへ反映するTaskはありません。"
            }
        } catch {
            organizeActionErrors[sessionID] = "Voyagerへ反映できませんでした。接続回復後に同じ内容で再試行できます。"
        }
    }

    public func isAgentTaskActionInFlight(_ id: UUID) -> Bool {
        pendingAgentTaskActionIDs.contains(id)
    }

    public func agentTaskActionError(_ id: UUID) -> String? {
        agentTaskActionErrors[id]
    }

    public func dismissAgentTaskActionError(_ id: UUID) {
        agentTaskActionErrors.removeValue(forKey: id)
    }
}
