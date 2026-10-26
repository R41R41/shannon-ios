import Foundation
import Observation

/// The message a reaction picker is open for.
public struct ShannonReactionTarget: Identifiable, Equatable, Sendable {
    public let message: ConversationMessage
    /// The server's message id, or her reply's turn id before the Talk was read back.
    public let targetID: String
    public let threadID: String
    public var id: UUID { message.id }
}

/// The owner's emoji reactions (rich chat, owner decision 2026-10-13): several per message, each toggled on its own, for
/// the owner alone. A change is set-based on the server, so a repeated request after an unknown outcome is harmless.
/// Her own reactions (rich chat §4, owner request 2026-10-26) are shown beside his, Discord-style: one chip per emoji with
/// how many put it on; only his can be taken off here.
@MainActor @Observable
public final class ShannonReactionsModel {
    /// Offered first, in this order (Syzygy ADR-0009 §10); the full picker offers the rest.
    public nonisolated static let quick = ["❤️", "😂", "👍", "😮", "🥲", "🙏"]

    public private(set) var othersPresent = false
    public private(set) var pending: Set<String> = []
    public private(set) var notice: String?
    /// The message the notice is about.
    public private(set) var noticeMessageID: UUID?
    /// The message whose full emoji picker is open.
    public var pickerTarget: ShannonReactionTarget?
    private var overrides: [String: [String]] = [:]
    /// Her reactions this app learned since the Talk was read, by server message id.
    private var hers: [String: [String]] = [:]
    /// The server id of a message he sent, learned from her reaction on it before the Talk was read back.
    private var serverIDs: [UUID: String] = [:]
    private let scopeKey: String
    private let client: (any ShannonReactionServing)?
    private var generation = 0

    public init(scopeKey: String, client: (any ShannonReactionServing)?) {
        self.scopeKey = scopeKey
        self.client = client
    }

    public var isAvailable: Bool { client != nil && !othersPresent }

    public func setAudience(othersPresent: Bool) {
        guard self.othersPresent != othersPresent else { return }
        generation += 1
        self.othersPresent = othersPresent
        overrides = [:]
        hers = [:]
        serverIDs = [:]
        notice = nil
        noticeMessageID = nil
        pickerTarget = nil
    }

    /// Nil while others may see the screen, before the message reached the server, or for a message with no server identity.
    public func target(for message: ConversationMessage, threadID: String?) -> ShannonReactionTarget? {
        guard isAvailable, let threadID, message.deliveryState == .sent else { return nil }
        guard let id = serverID(of: message) ?? (message.role == .shannon ? message.turnID : nil), !id.isEmpty else { return nil }
        return ShannonReactionTarget(message: message, targetID: id, threadID: threadID)
    }

    private func serverID(of message: ConversationMessage) -> String? {
        message.serverID ?? serverIDs[message.id]
    }

    /// Her reaction of a turn, on the message he sent (the chat response's `shannonReaction`).
    public func noteShannonReaction(_ reaction: ShannonOwnReactionDTO, onMessage id: UUID) {
        guard !othersPresent else { return }
        serverIDs[id] = reaction.messageId
        let current = hers[reaction.messageId] ?? []
        if !current.contains(reaction.emoji) { hers[reaction.messageId] = current + [reaction.emoji] }
    }

    /// Her reactions to show: what this app learned last, else what the server sent; none while others may see.
    public func shannonEmojis(for message: ConversationMessage) -> [String] {
        guard !othersPresent else { return [] }
        if let id = serverID(of: message), let value = hers[id] { return value }
        return message.shannonReactions
    }

    /// One chip per emoji under the message, his first, with how many put it on.
    public func chips(for message: ConversationMessage) -> [ShannonReactionChip] {
        ShannonReactionChip.chips(mine: emojis(for: message), hers: shannonEmojis(for: message))
    }

    /// The reactions to show: the last change this app made, else what the server sent; none while others may see.
    public func emojis(for message: ConversationMessage) -> [String] {
        guard !othersPresent else { return [] }
        if let id = serverID(of: message), let value = overrides[id] { return value }
        if let id = message.turnID, message.role == .shannon, let value = overrides[id] { return value }
        return message.reactions
    }

    public func isPending(_ message: ConversationMessage) -> Bool {
        [message.serverID, message.turnID].compactMap { $0 }.contains { pending.contains($0) }
    }

    public func toggle(_ emoji: String, on message: ConversationMessage, threadID: String?) async {
        guard let client, let target = target(for: message, threadID: threadID), !pending.contains(target.targetID) else { return }
        let on = !emojis(for: message).contains(emoji)
        let epoch = generation
        pending.insert(target.targetID)
        notice = nil
        noticeMessageID = nil
        defer { pending.remove(target.targetID) }
        do {
            let result = try await client.changeReaction(scopeKey: scopeKey, threadId: target.threadID,
                                                         messageId: target.targetID, emoji: emoji, on: on)
            guard epoch == generation, !othersPresent else { return }
            overrides[result.messageId] = result.emojis
            overrides[target.targetID] = result.emojis
            if let value = result.shannonEmojis { hers[result.messageId] = value }
        } catch {
            guard epoch == generation, !othersPresent else { return }
            notice = "反応を付けられませんでした。もう一度お試しください。"
            noticeMessageID = message.id
        }
    }

    /// One emoji from what the owner typed into the full picker: its last character, when that is an emoji.
    public nonisolated static func emoji(from typed: String) -> String? {
        guard let last = typed.last else { return nil }
        let isEmoji = last.unicodeScalars.contains { scalar in
            scalar.properties.isEmojiPresentation || (scalar.properties.isEmoji && scalar.value > 0x238C)
        }
        return isEmoji ? String(last) : nil
    }
}
