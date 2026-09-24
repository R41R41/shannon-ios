import XCTest
@testable import ShannonAppCore

@MainActor
final class ShannonVoiceProposalContinuityTests: XCTestCase {
    func testVoiceProposalIsReviewableWithoutACompletedSpokenTurn() async throws {
        let model = ShannonConversationModel(client: VoiceProposalClient(), usesDisplayCache: false)
        _ = try await model.performLiveVoiceDelegation(transcript: "写真整理をタスクにして",
            userUtterance: .init(id: "input-1", text: "写真整理をタスクにして"), participantMode: .owner)
        XCTAssertTrue(model.messages.isEmpty)
        XCTAssertEqual(model.unattachedSelectedThreadOrganizeSessions.map(\.id), ["voice-proposal"])
        XCTAssertEqual(model.organizeSessions.first?.state, .readyForReview)
        _ = try await model.performLiveVoiceDelegation(transcript: "写真整理をタスクにして", participantMode: .owner)
        XCTAssertEqual(model.organizeSessions.count, 1)

        let restored = ShannonConversationModel(client: VoiceProposalClient(), usesDisplayCache: false)
        restored.selectedThreadId = model.selectedThreadId
        restored.organizeSessions = try JSONDecoder().decode([ShannonOrganizeSessionDTO].self,
            from: JSONEncoder().encode(model.organizeSessions))
        XCTAssertEqual(restored.unattachedSelectedThreadOrganizeSessions.map(\.id), ["voice-proposal"])
        restored.selectedThreadId = "different-thread"
        XCTAssertTrue(restored.unattachedSelectedThreadOrganizeSessions.isEmpty)
    }

    func testAttachedReviewIsNotDuplicatedAndOldVoiceRepliesRemainDecodable() throws {
        let model = ShannonConversationModel(client: VoiceProposalClient(), usesDisplayCache: false)
        let message = ConversationMessage(role: .shannon, text: "確認してね")
        model.selectedThreadId = "voice-thread"
        model.messages = [message]
        model.organizeSessions = [proposal(sourceID: message.id.uuidString)]
        XCTAssertEqual(model.organizeSession(sourceMessageID: message.id)?.id, "voice-proposal")
        XCTAssertTrue(model.unattachedSelectedThreadOrganizeSessions.isEmpty)
        let legacy = try JSONDecoder().decode(ShannonLiveVoiceDelegationResponseDTO.self,
            from: Data(#"{"threadId":"old","model":"test","reply":"hello"}"#.utf8))
        XCTAssertNil(legacy.organizeSession)
    }
}

private func proposal(sourceID: String? = nil) -> ShannonOrganizeSessionDTO {
    ShannonOrganizeSessionDTO(id: "voice-proposal", scopeKey: "local-owner", threadId: "voice-thread",
        state: .readyForReview, revision: 1, sourceMessageIds: ["utterance:input-1"],
        commandThroughMessageId: sourceID, items: [], createdAt: "2026-09-24T12:00:00Z",
        updatedAt: "2026-09-24T12:00:00Z", appliedAt: nil)
}

private actor VoiceProposalClient: ShannonAPIClientProtocol {
    func send(message: String, scopeKey: String, threadId: String?) async throws -> ChatResponseDTO {
        throw ShannonAPIError.invalidResponse
    }
    func performLiveVoiceDelegation(scopeKey: String, threadId: String?, transcript: String,
        participantMode: ShannonVoiceParticipantMode, deviceContext: ShannonVoiceDeviceContextDTO?
    ) async throws -> ShannonLiveVoiceDelegationResponseDTO {
        let result = ShannonLiveVoiceDelegationResponseDTO(threadId: "voice-thread", model: "test",
            reply: "確認してね", organizeSession: proposal())
        return try JSONDecoder().decode(ShannonLiveVoiceDelegationResponseDTO.self, from: JSONEncoder().encode(result))
    }
}
