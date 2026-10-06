import XCTest
@testable import ShannonAppCore

final class ShannonTranscriptionPromptLeakTests: XCTestCase {
    private let prompt = "シャノン、ライ、Aether、Voyager、Syzygy、Jev、Minebot、Codex、SwiftUI、TestFlight"

    private func clean(_ text: String) -> String {
        ShannonOpenAITranscriptionProtocol.removingLeakedPrompt(from: text)
    }

    func testDropsATranscriptThatIsOnlyThePrompt() {
        XCTAssertEqual(clean(prompt), "")
        XCTAssertEqual(clean(prompt + prompt), "")
        XCTAssertEqual(clean("  \(prompt)\n"), "")
    }

    func testKeepsRealSpeechAroundALeakedPrompt() {
        XCTAssertEqual(clean("\(prompt) ちょっとお話ししよう。"), "ちょっとお話ししよう。")
        XCTAssertEqual(clean("ちょっとお話ししよう。 \(prompt)"), "ちょっとお話ししよう。")
    }

    func testRemovesAPartialLeakOfFourOrMoreWords() {
        XCTAssertEqual(clean("シャノン、ライ、Aether、Voyager、"), "")
        XCTAssertEqual(clean("aether, voyager, syzygy, jev それから"), "それから")
    }

    func testLeavesOrdinarySentencesThatNameProductsAlone() {
        XCTAssertEqual(clean("AetherとVoyagerの進捗を教えて"), "AetherとVoyagerの進捗を教えて")
        XCTAssertEqual(clean("シャノン、ライ、Aetherの件だけど"), "シャノン、ライ、Aetherの件だけど")
        XCTAssertEqual(clean("ライブ配信のTestFlightを確認して"), "ライブ配信のTestFlightを確認して")
        XCTAssertEqual(clean("今日は晴れだね"), "今日は晴れだね")
    }

    func testLeakedPromptNeverBecomesATranscriptEvent() throws {
        func events(_ transcript: String) throws -> [ShannonTranscriptionEvent] {
            try ShannonOpenAITranscriptionProtocol.events(from: JSONSerialization.data(withJSONObject: [
                "type": "conversation.item.input_audio_transcription.completed", "transcript": transcript,
            ]))
        }
        XCTAssertEqual(try events(prompt), [])
        XCTAssertEqual(try events("\(prompt) ちょっとお話ししよう。"), [.inputTranscript("ちょっとお話ししよう。")])
        XCTAssertEqual(try events(" 明日は晴れるかな。 "), [.inputTranscript("明日は晴れるかな。")])
    }

    func testSwiftVocabularyMatchesTheServerPrompt() throws {
        // The server owns the prompt; the client list must stay in step with it.
        // Found by name anywhere under the API sources, which move into folders (Syzygy ADR-0008 §6).
        let repository = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
        let sources = repository.appending(path: "services/api/src")
        let enumerator = try XCTUnwrap(FileManager.default.enumerator(at: sources, includingPropertiesForKeys: nil))
        let matches = enumerator.compactMap { $0 as? URL }.filter { $0.lastPathComponent == "openaiTranscriptionSession.ts" }
        XCTAssertEqual(matches.count, 1, "exactly one openaiTranscriptionSession.ts under services/api/src")
        let server = try String(contentsOf: try XCTUnwrap(matches.first), encoding: .utf8)
        let marker = "const TRANSCRIPTION_PROMPT = '"
        let start = try XCTUnwrap(server.range(of: marker)?.upperBound)
        let end = try XCTUnwrap(server[start...].firstIndex(of: "'"))
        XCTAssertEqual(String(server[start..<end]), ShannonOpenAITranscriptionProtocol.promptVocabulary.joined(separator: "、"))
    }
}
