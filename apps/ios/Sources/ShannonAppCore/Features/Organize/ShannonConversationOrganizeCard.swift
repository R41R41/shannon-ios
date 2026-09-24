import SwiftUI

/// Both Apple conversation surfaces consume the same review/action binding.
public struct ShannonConversationOrganizeCard: View {
    @Bindable var model: ShannonConversationModel
    let session: ShannonOrganizeSessionDTO

    public init(model: ShannonConversationModel, session: ShannonOrganizeSessionDTO) {
        self.model = model
        self.session = session
    }

    public var body: some View {
        ShannonOrganizeSessionCard(
            session: session,
            isWorking: model.pendingOrganizeSessionIDs.contains(session.id),
            error: model.organizeActionErrors[session.id],
            taskCandidatesByItemID: model.voyagerTaskCandidatesByItemID,
            projects: model.voyagerProjects,
            pendingCatalogItemIDs: model.pendingVoyagerCatalogItemIDs,
            catalogErrorsByItemID: model.voyagerCatalogErrorsByItemID,
            decide: { itemID, decision, title, details, operation, target, projectIds in
                Task {
                    await model.decideOrganizeItem(sessionID: session.id, itemID: itemID,
                        decision: decision, title: title, details: details,
                        operation: operation, target: target, projectIds: projectIds)
                }
            },
            searchTasks: { itemID, query in
                Task { await model.searchVoyagerTasks(itemID: itemID, query: query) }
            },
            loadProjects: { itemID in Task { await model.loadVoyagerProjects(itemID: itemID) } },
            apply: { Task { await model.applyOrganizeSession(session.id) } }
        )
    }
}
