import Foundation
import Observation

/// Her reply while the server writes it (docs/chat-stream-contract.md), shown under his message as it grows.
public struct ShannonStreamingReply: Equatable, Sendable {
    public enum Phase: Equatable, Sendable {
        /// Sentences are arriving; `done` replaces the row with the stored reply.
        case writing
        /// The stream broke before `done`: what arrived is kept, marked as cut off, until the Talk says more.
        case interrupted
    }

    public let id: UUID
    public let userMessageID: UUID
    /// The Talk on screen when he sent; the row is drawn only there.
    public let threadAtSend: String?
    public internal(set) var text: String
    public internal(set) var phase: Phase
    public let startedAt: Date

    /// The row as a message: hers, unsent while she writes, failed once the stream broke. No face yet:
    /// the face of a text reply comes with `done` (`messageEmotion`).
    public var message: ConversationMessage {
        ConversationMessage(
            id: id,
            role: .shannon,
            text: text,
            sentAt: startedAt,
            deliveryState: phase == .interrupted ? .failed : .sending
        )
    }
}

/// A sent message whose turn may exist on the server although this device never saw its end.
struct ShannonUncertainTurn: Sendable {
    let sentText: String
    /// The thread to read: the one `start` named, else the one on screen at sending.
    let threadID: String?
    let threadAtSend: String?
    /// Server message ids and turn ids already on screen when he sent: a stored reply among them is an older turn.
    let knownIdentities: Set<String>
    /// When he sent it: a stored message of his older than this is an earlier turn with the same words.
    let sentAt: Date
    /// Until when the server may still be writing the turn (its 30-second model budget, and some margin).
    let settlesBy: Date
}

enum ShannonUncertainTurnCheck: Equatable {
    case recovered
    case absent
    case unknown
}

extension ShannonConversationModel {
    /// The writing (or cut-off) reply when it belongs to the Talk on screen and has words.
    public var visibleStreamingReply: ShannonStreamingReply? {
        guard let streamingReply, streamingReply.threadAtSend == selectedThreadId, !streamingReply.text.isEmpty else {
            return nil
        }
        return streamingReply
    }

    /// The waiting indicator stands until her first sentence arrives; while a reply is drawn at her pace, the pace decides.
    public var showsTypingIndicator: Bool {
        if let replyPacing { return replyPacing.showsTyping }
        return isSending && visibleStreamingReply == nil
    }

    /// Whether the last failed message is being checked against the Talk before it may be sent again.
    public var isConfirmingFailedSend: Bool { isCheckingUncertainTurn }

    // MARK: The provisional row

    func beginStreamingReply(id: UUID, userMessageID: UUID, threadAtSend: String?) {
        streamingReply = ShannonStreamingReply(
            id: id,
            userMessageID: userMessageID,
            threadAtSend: threadAtSend,
            text: "",
            phase: .writing,
            startedAt: Date()
        )
    }

    func streamingReplyDidGrow(_ id: UUID, _ progress: ShannonChatStreamProgress) {
        guard streamingReply?.id == id, streamingReply?.phase == .writing else { return }
        // A reply with a pace (ADR-0013 item 10) is held and drawn at that pace once whole; a bypass is shown as it comes.
        if let register = progress.textRegister, register.bypass == nil { return }
        streamingReply?.text = progress.text
    }

    func discardStreamingReply(_ id: UUID) {
        guard streamingReply?.id == id else { return }
        streamingReply = nil
    }

    /// What arrived before the stream broke stays on screen, marked as cut off; nothing arrived: nothing stays.
    func keepInterruptedReply(_ id: UUID, partialText: String) {
        guard streamingReply?.id == id else { return }
        guard !partialText.isEmpty else {
            streamingReply = nil
            return
        }
        streamingReply?.text = partialText
        streamingReply?.phase = .interrupted
    }

    func discardInterruptedReply(for userMessageID: UUID) {
        guard streamingReply?.userMessageID == userMessageID, streamingReply?.phase == .interrupted else { return }
        streamingReply = nil
    }

    /// The reply message `done` (or the JSON response) stands for. It takes the provisional row's identity, so the
    /// row that grew is the row that stays; an organize turn keeps the id its session points at.
    nonisolated static func reconciledReply(
        _ response: ChatResponseDTO,
        provisionalID: UUID,
        sentAt: Date = Date()
    ) -> ConversationMessage {
        let organizeSession = response.uiBlocks?.compactMap(\.session).first
        return ConversationMessage(
            id: organizeSession?.commandThroughMessageId.flatMap(UUID.init(uuidString:)) ?? provisionalID,
            role: .shannon,
            text: response.reply,
            sentAt: sentAt,
            emotionSnapshot: ConversationMessage.EmotionSnapshot(response.messageEmotion, stateVersion: response.snapshotVersion),
            artifacts: response.artifacts ?? [],
            places: response.uiBlocks?.flatMap { $0.places ?? [] } ?? [],
            turnID: response.turnId,
            feedback: response.feedback
        )
    }

    // MARK: Her pace (Syzygy ADR-0013 item 10)

    /// Shows `reply` at its pace: her typing hidden for what is left of the pause, then her typing, then the reply, or its
    /// first sentence, her typing again and the whole reply (the same message, so the history keeps one).
    /// He may write and send meanwhile (a sulk's pause can be 20 s): sending puts the held reply in whole at once
    /// (`flushPacedReply`), and this returns without touching it again.
    func showPaced(_ reply: ConversationMessage, _ pacing: ShannonReplyPacing) async {
        guard !pacing.isImmediate else {
            messages.append(reply)
            return
        }
        heldPacedReply = reply
        // The Talk the reply belongs to: it is never put into another one.
        let origin = selectedThreadId
        heldPacedThread = origin
        // The composer is free while she takes her time.
        isSending = false
        replyPacing = ShannonReplyPacingState(threadID: selectedThreadId, showsTyping: pacing.pause == 0)
        defer {
            if heldPacedReply?.id == reply.id {
                heldPacedReply = nil
                replyPacing = nil
            }
        }
        if pacing.pause > 0 {
            guard await pacedWait(pacing.pause, for: reply.id) else { return }
            replyPacing?.showsTyping = true
        }
        if pacing.typing > 0 { guard await pacedWait(pacing.typing, for: reply.id) else { return } }
        guard pacing.parts.count == 2 else {
            placeWhole(reply, in: origin)
            return
        }
        // The first message carries her face only: its actions (reactions, feedback, places) come with the whole reply.
        // Only while its own Talk is on screen; elsewhere the whole reply goes into its Talk at once.
        guard selectedThreadId == origin else {
            placeWhole(reply, in: origin)
            return
        }
        messages.append(ConversationMessage(
            id: reply.id, role: .shannon, text: pacing.parts[0], sentAt: reply.sentAt, emotionSnapshot: reply.emotionSnapshot))
        replyPacing?.showsTyping = true
        if pacing.gap > 0 { guard await pacedWait(pacing.gap, for: reply.id) else { return } }
        placeWhole(reply, in: origin)
    }

    /// Waits for the pace; false when the reply was put in meanwhile (he sent something).
    private func pacedWait(_ seconds: TimeInterval, for id: UUID) async -> Bool {
        let sleep = pacingSleep
        let wait = Task { await sleep(seconds) }
        pacingWait = wait
        await wait.value
        return heldPacedReply?.id == id
    }

    /// He sends while a reply is held at her pace: the reply goes in whole and unsplit now, before his message.
    func flushPacedReply() {
        guard let reply = heldPacedReply else { return }
        heldPacedReply = nil
        replyPacing = nil
        pacingWait?.cancel()
        placeWhole(reply, in: heldPacedThread)
    }

    /// The whole reply in its own Talk: in place of its first sentence, or appended; into that Talk's cached history when
    /// another Talk is on screen, never into the one shown.
    private func placeWhole(_ reply: ConversationMessage, in thread: String?) {
        guard selectedThreadId == thread else {
            guard let thread else { return }
            var history = cachedHistories[thread, default: []]
            history.removeAll { $0.id == reply.id }
            history.append(ShannonConversationCache.CachedMessage(reply))
            cachedHistories[thread] = history
            return
        }
        if let index = messages.firstIndex(where: { $0.id == reply.id }) {
            messages[index] = reply
        } else {
            messages.append(reply)
        }
    }

    // MARK: A turn whose end this device did not see

    /// The server message ids and turn ids already on screen.
    func knownTurnIdentities() -> Set<String> {
        Set(messages.flatMap { [$0.serverID, $0.turnID].compactMap { $0 } })
    }

    func rememberUncertainTurn(
        _ userMessageID: UUID,
        sentText: String,
        threadID: String?,
        threadAtSend: String?,
        knownIdentities: Set<String>,
        sentAt: Date,
        settlesBy: Date
    ) {
        uncertainTurns[userMessageID] = ShannonUncertainTurn(
            sentText: sentText,
            threadID: threadID,
            threadAtSend: threadAtSend,
            knownIdentities: knownIdentities,
            sentAt: sentAt,
            settlesBy: settlesBy
        )
    }

    /// An error after which the request may have reached the server and been answered there.
    nonisolated static func sendMayHaveReachedServer(_ error: Error) -> Bool {
        if error is ShannonChatStreamInterrupted { return true }
        guard let urlError = error as? URLError else { return false }
        return [.timedOut, .networkConnectionLost].contains(urlError.code)
    }

    /// Reads the Talk while the server may still be finishing the turn, and shows the turn once it is there.
    func scheduleUncertainTurnRecovery(_ userMessageID: UUID, every interval: Duration = .seconds(3)) {
        uncertainTurnRecoveryTask?.cancel()
        uncertainTurnRecoveryTask = Task { @MainActor [weak self] in
            var first = true
            while !Task.isCancelled {
                try? await Task.sleep(for: first ? .milliseconds(600) : interval)
                first = false
                guard !Task.isCancelled, let self, let pending = self.uncertainTurns[userMessageID] else { return }
                if !self.isSending, !self.isCheckingUncertainTurn,
                   await self.checkUncertainTurn(userMessageID) == .recovered {
                    return
                }
                // Past the server's budget the turn either exists or never will: 再送 decides then.
                if Date() > pending.settlesBy.addingTimeInterval(10) { return }
            }
        }
    }

    /// Reads the Talk once. `.recovered`: the turn was there and is now shown, so it must not be sent again.
    @discardableResult
    func checkUncertainTurn(_ userMessageID: UUID) async -> ShannonUncertainTurnCheck {
        guard !isCheckingUncertainTurn else { return .unknown }
        isCheckingUncertainTurn = true
        defer { isCheckingUncertainTurn = false }
        return await readUncertainTurn(userMessageID)
    }

    /// 再送 of a message whose turn may exist: reads the Talk, and while the server may still be writing the turn,
    /// reads it again, so that 再送 never makes a second turn of one that was only late.
    func confirmUncertainTurnBeforeResend(_ userMessageID: UUID) async -> ShannonUncertainTurnCheck {
        guard let pending = uncertainTurns[userMessageID], !isCheckingUncertainTurn else { return .unknown }
        uncertainTurnRecoveryTask?.cancel()
        isCheckingUncertainTurn = true
        defer { isCheckingUncertainTurn = false }
        var check = await readUncertainTurn(userMessageID)
        while check == .absent, Date() < pending.settlesBy, !Task.isCancelled {
            statusMessage = Self.confirmingFailedSendStatus
            try? await Task.sleep(for: .seconds(2))
            check = await readUncertainTurn(userMessageID)
        }
        if statusMessage == Self.confirmingFailedSendStatus { statusMessage = nil }
        return check
    }

    static let confirmingFailedSendStatus = "前の返事が届いていないか確かめています…"

    private func readUncertainTurn(_ userMessageID: UUID) async -> ShannonUncertainTurnCheck {
        guard let pending = uncertainTurns[userMessageID] else { return .unknown }
        let history: ConversationHistoryResponseDTO
        do {
            history = try await client.loadConversation(scopeKey: scopeKey, threadId: pending.threadID)
        } catch {
            return .unknown
        }
        guard uncertainTurns[userMessageID] != nil else { return .recovered }
        guard Self.storedTurnExists(
            in: history.messages,
            sentText: pending.sentText,
            sentAt: pending.sentAt,
            knownIdentities: pending.knownIdentities
        ) else { return .absent }

        uncertainTurns.removeValue(forKey: userMessageID)
        pendingAttachmentsByMessageID.removeValue(forKey: userMessageID)
        pendingPhotoByMessageID.removeValue(forKey: userMessageID)
        pendingWebSearchMessageIDs.remove(userMessageID)
        if streamingReply?.userMessageID == userMessageID { streamingReply = nil }
        errorMessage = nil
        let onScreen = selectedThreadId == pending.threadAtSend || selectedThreadId == history.threadId
        if onScreen, !isSending {
            // The stored Talk is the authority: it has his message, her reply, its face and its blocks.
            await reloadConversation(threadId: history.threadId)
        } else {
            updateDeliveryState(for: userMessageID, to: .sent)
        }
        return .recovered
    }

    /// How far the server's clock may run behind this device's when a stored message is compared with the send time.
    nonisolated static let clockSkewAllowance: TimeInterval = 10

    /// Whether `stored` holds a turn for `sentText` that was not on screen when it was sent: his message, stored at
    /// or after `sentAt` (less the clock allowance), followed by her reply, among the last few, with a reply id and
    /// turn id this device did not already show. An older 「おはよう」 with the same words is never taken for it.
    nonisolated static func storedTurnExists(
        in stored: [StoredConversationMessageDTO],
        sentText: String,
        sentAt: Date,
        knownIdentities: Set<String>
    ) -> Bool {
        let earliest = sentAt.addingTimeInterval(-clockSkewAllowance)
        let wanted = sentText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !wanted.isEmpty, stored.count >= 2 else { return false }
        let lowest = max(0, stored.count - 12)
        for index in stride(from: stored.count - 2, through: lowest, by: -1) {
            let user = stored[index]
            let reply = stored[index + 1]
            guard user.role == "user", reply.role == "assistant",
                  user.content.trimmingCharacters(in: .whitespacesAndNewlines) == wanted,
                  let storedAt = storedDate(user.observedAt), storedAt >= earliest else { continue }
            if knownIdentities.contains(reply.id) { continue }
            if let turn = reply.sourceExperienceId, knownIdentities.contains(turn) { continue }
            return true
        }
        return false
    }

    nonisolated static func storedDate(_ value: String) -> Date? {
        if let parsed = try? Date.ISO8601FormatStyle(includingFractionalSeconds: true).parse(value) { return parsed }
        return try? Date.ISO8601FormatStyle().parse(value)
    }

    /// Back in front: a reply whose stream broke while the app was away is looked for in the Talk.
    public func resumeInterruptedReplies() async {
        guard !isSending, !isCheckingUncertainTurn,
              let message = messages.last(where: { $0.role == .user && $0.deliveryState == .failed }),
              uncertainTurns[message.id] != nil
        else { return }
        if await checkUncertainTurn(message.id) != .recovered {
            scheduleUncertainTurnRecovery(message.id)
        }
    }
}
