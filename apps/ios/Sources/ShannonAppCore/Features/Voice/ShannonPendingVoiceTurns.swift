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
    }

    struct Batch: Equatable, Sendable {
        let turns: [Turn]
        var id: UUID { turns[turns.count - 1].id }
        var text: String { turns.map(\.text).joined(separator: "\n") }
        var rawText: String { turns.map(\.rawText).joined(separator: "\n") }
        var source: ShannonVoiceUtteranceSource {
            turns.contains { $0.source == .speech } ? .speech : turns[turns.count - 1].source
        }
    }

    private(set) var turns: [Turn] = []

    mutating func append(id: UUID = UUID(), rawText: String, text: String, source: ShannonVoiceUtteranceSource) {
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              !turns.contains(where: { $0.id == id }) else { return }
        turns.append(Turn(id: id, rawText: rawText, text: text, source: source))
    }

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
