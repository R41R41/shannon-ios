import Foundation
import Testing
@testable import ShannonAppCore

struct ShannonPendingVoiceTurnsTests {
    @Test func interruptionRetainsOriginalRequestAndCorrection() throws {
        var ledger = ShannonPendingVoiceTurns()
        let originalID = UUID()
        ledger.append(id: originalID, rawText: "エーテルのノート見て", text: "Aetherのノート見て", source: .speech)
        let cancelled = try #require(ledger.batch())
        // Output was cancelled; no acknowledgement should be made.
        ledger.append(rawText: "あと、最新のやつね", text: "あと、最新のやつね", source: .speech)
        let replacement = try #require(ledger.batch())
        #expect(replacement.text == "Aetherのノート見て\nあと、最新のやつね")
        #expect(replacement.rawText == "エーテルのノート見て\nあと、最新のやつね")
        #expect(replacement.turns.first?.id == originalID)
        ledger.acknowledge(cancelled)
        #expect(ledger.turns.count == 1)
        // A stale replacement cannot acknowledge a different current prefix.
        ledger.acknowledge(replacement)
        #expect(ledger.turns.count == 1)
    }

    @Test func retriesKeepIdentityWithoutDroppingIdenticalIntentionalInputs() throws {
        var ledger = ShannonPendingVoiceTurns()
        let id = UUID()
        ledger.append(id: id, rawText: "続けて", text: "続けて", source: .typed)
        ledger.append(id: id, rawText: "続けて", text: "続けて", source: .typed)
        #expect(ledger.turns.count == 1)
        #expect(ledger.batch()?.id == id)
        ledger.append(rawText: "続けて", text: "続けて", source: .typed)
        #expect(ledger.turns.count == 2)
        ledger.acknowledge(try #require(ledger.batch()))
        #expect(ledger.turns.isEmpty)
    }

    @Test func boundedBatchNeverSilentlyTruncatesOrDropsLaterInput() throws {
        var ledger = ShannonPendingVoiceTurns()
        ledger.append(rawText: "最初", text: "最初", source: .speech)
        ledger.append(rawText: "次の話", text: "次の話", source: .typed)
        let prefix = try #require(ledger.batch(maximumCharacters: 3))
        #expect(prefix.text == "最初")
        #expect(ledger.turns.count == 2)
        ledger.acknowledge(prefix)
        #expect(ledger.batch()?.text == "次の話")
        #expect(ledger.batch(maximumCharacters: 1) == nil)
        #expect(ledger.turns.count == 1)
        ledger.reset()
        #expect(ledger.turns.isEmpty)
    }

    @Test func provenanceIsOptionalForOlderClients() throws {
        let legacy = try JSONDecoder().decode(ShannonVoiceUserUtteranceDTO.self,
            from: Data(#"{"id":"old","text":"こんにちは"}"#.utf8))
        #expect(legacy.source == nil)
        #expect(legacy.rawText == nil)
        let new = ShannonVoiceUserUtteranceDTO(id: "new", text: "Aether", source: .speech, rawText: "エーテル")
        let decoded = try JSONDecoder().decode(ShannonVoiceUserUtteranceDTO.self, from: JSONEncoder().encode(new))
        #expect(decoded.source == .speech)
        #expect(decoded.rawText == "エーテル")
    }
}
