import Foundation
import Observation

extension ShannonConversationModel {
    public func sendToAether(_ message: ConversationMessage) async {
        guard message.role == .shannon,
              !aetherProposalMessageIDs.contains(message.id),
              !aetherSubmittedMessageIDs.contains(message.id) else { return }
        aetherProposalMessageIDs.insert(message.id)
        defer { aetherProposalMessageIDs.remove(message.id) }
        do {
            let compactTitle = message.text
                .split(whereSeparator: { $0.isNewline })
                .first
                .map(String.init)?
                .trimmingCharacters(in: .whitespacesAndNewlines) ?? "Shannonからの提案"
            _ = try await client.createAetherProposal(
                scopeKey: scopeKey,
                title: String(compactTitle.prefix(120)),
                content: message.text,
                reason: "Shannonの返答から手動で送信"
            )
            aetherSubmittedMessageIDs.insert(message.id)
            statusMessage = "Aetherの提案箱へ送りました。"
        } catch {
            errorMessage = "Aetherへ送れませんでした。連携設定を確認してください。"
        }
    }

    public func refreshInitiatives() async {
        do {
            let inbox = try await client.loadInitiatives(scopeKey: scopeKey)
            unreadInitiativeCount = inbox.unreadCount
            initiativeThreadIDs = Set(inbox.messages.map(\.threadId))
            guard let latest = inbox.messages.last else { return }
            await loadThreads(force: true)
            if selectedThreadId == nil || selectedThreadId == latest.threadId {
                await reloadConversation(threadId: latest.threadId)
            }
        } catch {
            // Initiative polling must never make ordinary conversation look offline.
        }
    }

    public func acknowledgeVisibleInitiatives() async {
        guard let selectedThreadId,
              unreadInitiativeCount > 0,
              initiativeThreadIDs.contains(selectedThreadId)
        else { return }
        await markInitiativesRead()
    }

    @discardableResult
    public func registerPushToken(
        _ deviceToken: String,
        environment: ShannonPushEnvironmentDTO
    ) async -> Bool {
        do {
            try await client.registerPushToken(
                scopeKey: scopeKey,
                deviceToken: deviceToken,
                environment: environment
            )
            return true
        } catch {
            // Registration is retried on the next foreground activation.
            return false
        }
    }

    public func openInitiativeThread(_ threadId: String) async {
        await selectThread(threadId)
        talkPresentationRevision &+= 1
    }

    public var canSendDraft: Bool {
        canSendDraft(attachmentCount: 0)
    }

    public func canSendDraft(attachmentCount: Int) -> Bool {
        (!draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || attachmentCount > 0)
            && !isSending
            && !isLoadingHistory
    }

    public var currentExpression: ShannonExpressionDTO {
        messages
            .last(where: { $0.role == .shannon })?
            .emotionSnapshot?
            .expression ?? .curious
    }

    public var hasFailedMessage: Bool {
        messages.contains { $0.role == .user && $0.deliveryState == .failed }
    }

    public var latestContextReference: ActiveMemoryDTO? {
        state?.activeMemories
            .filter { $0.relevance >= 0.45 }
            .max(by: { $0.relevance < $1.relevance })
    }
}
