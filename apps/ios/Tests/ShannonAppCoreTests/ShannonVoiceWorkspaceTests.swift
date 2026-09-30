import Foundation
import Testing
@testable import ShannonAppCore

@MainActor
struct ShannonVoiceWorkspaceTests {
    @Test func pinnedVoiceRequestsNeverFollowTheBrowsedThread() async throws {
        let client = VoiceWorkspaceClient()
        let model = ShannonConversationModel(client: client, usesDisplayCache: false)
        model.selectedThreadId = "browsed"
        model.messages = [.init(role: .user, text: "別の会話")]

        _ = try await model.createGeminiLiveSession(participantMode: .owner, threadID: "call")
        _ = try await model.performLiveVoiceDelegationResponse(
            transcript: "実装して", participantMode: .owner, threadID: "call")
        _ = try await model.performLiveVoiceDelegationStreamingResponse(
            transcript: "続き", participantMode: .owner, threadID: "call", onSegment: { _, _ in })
        _ = try await model.analyzeVoiceCameraSnapshot(jpegData: Data([1]), threadID: "call")
        try await model.commitRealtimeVoiceTurn(userTranscript: "実装して", shannonTranscript: "確認してね", threadID: "call")

        #expect(await client.requestedThreads == ["call", "call", "call", "call", "call"])
        #expect(model.selectedThreadId == "browsed")
        #expect(model.messages.map(\.text) == ["別の会話"])
        #expect(model.organizeSessions.isEmpty)
        #expect(model.cachedHistories["call"]?.map(\.text) == ["実装して", "確認してね"])
    }

    @Test func navigationDuringHistoryWriteKeepsTheOriginalThread() async throws {
        let client = VoiceWorkspaceClient(pausesCommit: true)
        let model = ShannonConversationModel(client: client, usesDisplayCache: false)
        model.selectedThreadId = "call"
        let writing = Task {
            try await model.commitRealtimeVoiceTurn(userTranscript: "先の発話", shannonTranscript: "返答", threadID: "call")
        }
        await client.waitForCommit()
        model.selectedThreadId = "browsed"
        model.messages = [.init(role: .shannon, text: "別トークの履歴")]
        await client.finishCommit()
        try await writing.value
        #expect(model.selectedThreadId == "browsed")
        #expect(model.messages.map(\.text) == ["別トークの履歴"])
        #expect(model.cachedHistories["call"]?.map(\.text) == ["先の発話", "返答"])
    }

    @Test func unselectedCallStartsANewThreadInsteadOfBorrowingCurrentSelection() async throws {
        let client = VoiceWorkspaceClient()
        let model = ShannonConversationModel(client: client, usesDisplayCache: false)
        model.selectedThreadId = "later-selection"
        let session = try await model.createGeminiLiveSession(participantMode: .owner, threadID: nil)
        #expect(session.threadId == "new-call")
        #expect(await client.requestedThreads == [nil])
        #expect(model.selectedThreadId == "later-selection")
    }

    @Test func delayedHistoryReloadCannotPullNavigationBackToTheCall() async {
        let client = VoiceWorkspaceClient(pausesHistory: true)
        let model = ShannonConversationModel(client: client, usesDisplayCache: false)
        model.selectedThreadId = "call"
        let oldLoad = Task { await model.reloadConversation(threadId: "call") }
        await client.waitForHistory()
        await model.selectThread("browsed")
        await client.finishHistory()
        await oldLoad.value
        #expect(model.selectedThreadId == "browsed")
        #expect(model.messages.map(\.text) == ["browsedの履歴"])
        #expect(!model.isLoadingHistory)
    }

    @Test func slowOrganizeFetchDoesNotDelayHistoryOrRestoreThePreviousThread() async {
        let client = VoiceWorkspaceClient(pausesOrganize: true)
        let model = ShannonConversationModel(client: client, usesDisplayCache: false)
        model.selectedThreadId = "call"
        let oldLoad = Task { await model.reloadConversation(threadId: "call") }
        await client.waitForOrganize()
        #expect(model.messages.map(\.text) == ["callの履歴"])
        await model.selectThread("browsed")
        await client.finishOrganize()
        await oldLoad.value
        #expect(model.selectedThreadId == "browsed")
        #expect(model.messages.map(\.text) == ["browsedの履歴"])
        #expect(model.organizeSessions.isEmpty)
    }

    @Test func voiceImplementationProposalWaitsForReviewAndStartsOnlyExplicitly() async throws {
        let client = VoiceWorkspaceClient()
        let model = ShannonConversationModel(client: client, usesDisplayCache: false)
        let id = UUID()
        let blocks = [ShannonUIBlockDTO(proposalId: id.uuidString, cognitiveIntentID: "intent",
            title: "Minebot音声対応", goal: "音声会話を実装する", projectHint: "Minebot")]
        model.installAgentTaskProposals(blocks, threadID: "call", sourceMessageID: UUID())
        #expect(model.agentTask(id: id)?.status == .proposed)
        #expect(model.agentTask(id: id)?.conversationThreadID == "call")
        #expect(await client.startCount == 0)
        model.configureAgentTask(id, hostPreference: .local, projectHint: "Minebot", model: "gpt-5.6-sol", reasoningEffort: .high)
        await model.startAgentTask(id)
        #expect(await client.startCount == 1)
        #expect(model.agentTask(id: id)?.status == .queued)
        model.installAgentTaskProposals(blocks, threadID: "call", sourceMessageID: UUID())
        #expect(model.agentTasks.count == 1)
        #expect(model.agentTask(id: id)?.status == .queued)
        #expect(model.agentTask(id: id)?.projectHint == "Minebot")
    }

    @Test func voiceFollowUpRefinesTheProposalWithoutDiscardingReviewedSettings() {
        let model = ShannonConversationModel(client: VoiceWorkspaceClient(), usesDisplayCache: false)
        let id = UUID()
        model.installAgentTaskProposals([.init(proposalId: id.uuidString, title: "音声対応", goal: "音声で話す")],
            threadID: "call", sourceMessageID: UUID())
        model.configureAgentTask(id, hostPreference: .local, projectHint: "Minebot", model: "gpt-5.6-sol", reasoningEffort: .high)
        model.installAgentTaskProposals([.init(proposalId: id.uuidString, title: "Minebot音声対応", goal: "友人とも会話する", projectHint: "other")],
            threadID: "call", sourceMessageID: UUID())
        #expect(model.agentTasks.count == 1)
        #expect(model.agentTask(id: id)?.goal == "友人とも会話する")
        #expect(model.agentTask(id: id)?.projectHint == "Minebot")
        #expect(model.agentTask(id: id)?.model == "gpt-5.6-sol")
        #expect(model.agentTask(id: id)?.status == .proposed)
    }

    @Test func compactStatusNeverMisrepresentsFailureOrStartupAsListening() {
        #expect(ShannonGeminiLivePhase.failed.workspaceTitle == "音声会話の接続を確認")
        #expect(ShannonGeminiLivePhase.connecting.workspaceTitle == "音声会話へ接続中")
        #expect(ShannonGeminiLivePhase.speaking.workspaceTitle == "シャノンが話しています")
    }
}

private actor VoiceWorkspaceClient: ShannonAPIClientProtocol {
    private(set) var requestedThreads: [String?] = []
    private(set) var startCount = 0
    let pausesCommit: Bool
    let pausesHistory: Bool
    let pausesOrganize: Bool
    private var commitStarted = false
    private var startWaiter: CheckedContinuation<Void, Never>?
    private var commitWaiter: CheckedContinuation<Void, Never>?
    private var historyStarted = false
    private var historyStartWaiter: CheckedContinuation<Void, Never>?
    private var historyWaiter: CheckedContinuation<Void, Never>?
    private var organizeStarted = false
    private var organizeStartWaiter: CheckedContinuation<Void, Never>?
    private var organizeWaiter: CheckedContinuation<Void, Never>?

    init(pausesCommit: Bool = false, pausesHistory: Bool = false, pausesOrganize: Bool = false) {
        self.pausesCommit = pausesCommit
        self.pausesHistory = pausesHistory
        self.pausesOrganize = pausesOrganize
    }
    func send(message: String, scopeKey: String, threadId: String?) async throws -> ChatResponseDTO {
        throw ShannonAPIError.invalidResponse
    }
    func createGeminiLiveSession(scopeKey: String, threadId: String?, participantMode: ShannonVoiceParticipantMode) async throws -> ShannonGeminiLiveSessionDTO {
        requestedThreads.append(threadId)
        return .init(token: "fixture", model: "test", voice: "test", threadId: threadId ?? "new-call",
            instructions: "fixture", expiresAt: "2026-09-29T00:00:00Z", inputUsdPerMinute: 0, outputUsdPerMinute: 0)
    }
    func performLiveVoiceDelegation(scopeKey: String, threadId: String?, transcript: String,
        participantMode: ShannonVoiceParticipantMode, deviceContext: ShannonVoiceDeviceContextDTO?
    ) async throws -> ShannonLiveVoiceDelegationResponseDTO {
        requestedThreads.append(threadId)
        return .init(threadId: threadId ?? "new-call", model: "test", reply: "確認してね",
            organizeSession: .init(id: "organize-fixture", scopeKey: "fixture", threadId: threadId ?? "new-call",
                state: .readyForReview, revision: 1, sourceMessageIds: [], commandThroughMessageId: nil,
                items: [], createdAt: "2026-09-29T00:00:00Z", updatedAt: "2026-09-29T00:00:00Z", appliedAt: nil))
    }
    func analyzeVoiceCameraSnapshot(scopeKey: String, threadId: String?, jpegData: Data) async throws -> ShannonVoiceVisionResponseDTO {
        requestedThreads.append(threadId)
        return .init(threadId: threadId ?? "new-call", model: "test", description: "合成写真")
    }
    func commitRealtimeVoiceTurn(scopeKey: String, threadId: String?, userTranscript: String, shannonTranscript: String) async throws -> ShannonRealtimeVoiceTurnResponseDTO {
        requestedThreads.append(threadId)
        commitStarted = true
        startWaiter?.resume(); startWaiter = nil
        if pausesCommit { await withCheckedContinuation { commitWaiter = $0 } }
        let state = CompanionStateDTO(scopeKey: "fixture", version: 1, updatedAt: "2026-09-29T00:00:00Z",
            temperament: .init(curiosity: 0.5, initiative: 0.5, closeness: 0.5, calmness: 0.5, needForContinuity: 0.5, confidenceAboutUser: 0.5),
            emotion: .init(valence: 0, arousal: 0.3, openness: 0.5), interests: [], userFacts: [], activeMemories: [])
        return .init(threadId: threadId ?? "new-call",
            messageEmotion: .init(valence: 0, arousal: 0.3, openness: 0.5, expression: .calm), state: state)
    }
    func waitForCommit() async {
        if !commitStarted { await withCheckedContinuation { startWaiter = $0 } }
    }
    func finishCommit() { commitWaiter?.resume(); commitWaiter = nil }
    func loadConversation(scopeKey: String, threadId: String?) async throws -> ConversationHistoryResponseDTO {
        if pausesHistory, threadId == "call" {
            historyStarted = true
            historyStartWaiter?.resume(); historyStartWaiter = nil
            await withCheckedContinuation { historyWaiter = $0 }
        }
        let state = CompanionStateDTO(scopeKey: "fixture", version: 1, updatedAt: "2026-09-29T00:00:00Z",
            temperament: .init(curiosity: 0.5, initiative: 0.5, closeness: 0.5, calmness: 0.5, needForContinuity: 0.5, confidenceAboutUser: 0.5),
            emotion: .init(valence: 0, arousal: 0.3, openness: 0.5), interests: [], userFacts: [], activeMemories: [])
        return .init(threadId: threadId ?? "new-call", messages: [
            .init(id: UUID().uuidString, role: "user", content: "\(threadId ?? "new-call")の履歴", observedAt: "2026-09-29T00:00:00Z")
        ], state: state)
    }
    func waitForHistory() async {
        if !historyStarted { await withCheckedContinuation { historyStartWaiter = $0 } }
    }
    func finishHistory() { historyWaiter?.resume(); historyWaiter = nil }
    func loadOrganizeSessions(scopeKey: String, threadId: String) async throws -> [ShannonOrganizeSessionDTO] {
        if pausesOrganize, threadId == "call" {
            organizeStarted = true
            organizeStartWaiter?.resume(); organizeStartWaiter = nil
            await withCheckedContinuation { organizeWaiter = $0 }
        }
        return []
    }
    func waitForOrganize() async {
        if !organizeStarted { await withCheckedContinuation { organizeStartWaiter = $0 } }
    }
    func finishOrganize() { organizeWaiter?.resume(); organizeWaiter = nil }
    func createAgentTask(scopeKey: String, task: ShannonAgentTask, idempotencyKey: String) async throws -> ShannonAgentTask {
        startCount += 1
        var queued = task
        queued.status = .queued
        return queued
    }
}
