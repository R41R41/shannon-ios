import Foundation

extension ShannonAPIClient: ShannonTaskTreeServing {
    private struct ProposalList: Decodable { let proposals: [ShannonTaskTreeProposalDTO] }
    private struct ProposalEnvelope: Decodable { let proposal: ShannonTaskTreeProposalDTO }
    private struct TreeEnvelope: Decodable { let tree: ShannonTaskTreeDTO }
    private struct ProposalRequest: Encodable {
        let scopeKey: String; let expectedRevision: Int; let change: ShannonTaskTreeChangeDTO; let operationId: String
    }
    private struct ApprovalRequest: Encodable {
        let scopeKey: String; let expectedRevision: Int; let proposalId: String; let diffHash: String
    }
    public func loadTaskTree(scopeKey: String, taskID: String) async throws -> ShannonTaskTreeReadDTO {
        try await response(ShannonTaskTreeReadDTO.self, for: autonomyGet("/v1/agent/tasks/\(try Self.pathComponent(taskID))/tree", scopeKey: scopeKey))
    }
    public func loadTaskTreeProposals(scopeKey: String, taskID: String) async throws -> [ShannonTaskTreeProposalDTO] {
        try await response(ProposalList.self, for: autonomyGet("/v1/agent/tasks/\(try Self.pathComponent(taskID))/tree/proposals", scopeKey: scopeKey)).proposals
    }
    public func proposeTaskTree(scopeKey: String, taskID: String, revision: Int, change: ShannonTaskTreeChangeDTO,
                                operationID: String) async throws -> ShannonTaskTreeProposalDTO {
        try await response(ProposalEnvelope.self, for: autonomyPost("/v1/agent/tasks/\(try Self.pathComponent(taskID))/tree/proposals",
            body: ProposalRequest(scopeKey: currentConnection()?.scopeKey ?? scopeKey, expectedRevision: revision, change: change,
                                  operationId: operationID), connection: currentConnection())).proposal
    }
    public func approveTaskTree(scopeKey: String, proposal: ShannonTaskTreeProposalDTO) async throws -> ShannonTaskTreeDTO {
        try await response(TreeEnvelope.self, for: autonomyPost("/v1/agent/tasks/\(try Self.pathComponent(proposal.taskId))/tree/approve",
            body: ApprovalRequest(scopeKey: currentConnection()?.scopeKey ?? scopeKey, expectedRevision: proposal.expectedRevision,
                                  proposalId: proposal.id, diffHash: proposal.diffHash), connection: currentConnection())).tree
    }
}
