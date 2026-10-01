import Foundation

/// Input survives cancellation of output. A response acknowledges only its frozen
/// prefix once a complete answer is visible, never inputs which arrived while
/// that response was running. Audio delivery is tracked independently.
struct ShannonPendingVoiceTurns: Sendable {
    struct Turn: Equatable, Sendable {
        let id: UUID
        let rawText: String
        let text: String
        let source: ShannonVoiceUtteranceSource
        /// 「シャノン」 was heard as an address in this utterance.
        var addressedByName = false
        /// The utterance began while Shannon was speaking or just after she finished.
        var followsShannonTurn = false
        /// A fixed reply spoken on the device instead of asking the model.
        var localReply: String?
        /// Not something a person said: the cue that makes Shannon greet after a switch.
        var isIntroductionCue = false
    }

    struct Batch: Equatable, Sendable {
        let turns: [Turn]
        var id: UUID { turns[turns.count - 1].id }
        var text: String { turns.map(\.text).joined(separator: "\n") }
        var rawText: String { turns.map(\.rawText).filter { !$0.isEmpty }.joined(separator: "\n") }
        var addressedByName: Bool { turns.contains(where: \.addressedByName) }
        var followsShannonTurn: Bool { turns.contains(where: \.followsShannonTurn) }
        var localReply: String? { turns.last?.localReply }
        var source: ShannonVoiceUtteranceSource {
            turns.contains { $0.source == .speech } ? .speech : turns[turns.count - 1].source
        }
    }

    private(set) var turns: [Turn] = []

    mutating func append(
        id: UUID = UUID(), rawText: String, text: String, source: ShannonVoiceUtteranceSource,
        addressedByName: Bool = false, followsShannonTurn: Bool = false,
        localReply: String? = nil, isIntroductionCue: Bool = false
    ) {
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              !turns.contains(where: { $0.id == id }) else { return }
        turns.append(Turn(
            id: id, rawText: rawText, text: text, source: source,
            addressedByName: addressedByName, followsShannonTurn: followsShannonTurn,
            localReply: localReply, isIntroductionCue: isIntroductionCue))
    }

    /// What the subtitle shows for input that has not been answered yet.
    var displayText: String { turns.map(\.rawText).filter { !$0.isEmpty }.joined(separator: "\n") }

    func batch(maximumCharacters: Int = 8_000) -> Batch? {
        var prefix: [Turn] = []
        var count = 0
        for turn in turns {
            let next = count + turn.text.utf16.count + (prefix.isEmpty ? 0 : 1)
            guard next <= maximumCharacters else { break }
            prefix.append(turn)
            count = next
        }
        return prefix.isEmpty ? nil : Batch(turns: prefix)
    }

    mutating func acknowledge(_ batch: Batch) {
        guard Array(turns.prefix(batch.turns.count)) == batch.turns else { return }
        turns.removeFirst(batch.turns.count)
    }

    mutating func reset() { turns.removeAll() }
}

public enum ShannonVoiceUtteranceSource: String, Codable, Equatable, Sendable {
    case speech, typed, camera
}
