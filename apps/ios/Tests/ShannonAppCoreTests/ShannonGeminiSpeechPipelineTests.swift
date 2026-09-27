import Foundation
import Testing
@testable import ShannonAppCore

@Suite("Gemini sentence speech prefetch")
@MainActor
struct ShannonGeminiSpeechPipelineTests {
    @Test("prefetches exactly one following sentence while preserving playback order")
    func prefetchesOneSentence() async throws {
        var events: [String] = []
        let segments = ["最初です。", "次です。", "最後です。"]

        try await ShannonGeminiSpeechPipeline.play(
            segments: segments,
            style: { "style:\($0)" },
            streamSpeech: { text, style in
                events.append("request:\(text):\(style ?? "")")
                return Self.stream(named: text)
            },
            consumeSpeech: { speech in
                events.append("play-start:\(speech.voice)")
                await Task.yield()
                for try await _ in speech.chunks {}
                events.append("play-end:\(speech.voice)")
            }
        )

        let requestSecond = try #require(events.firstIndex(where: { $0.hasPrefix("request:次です。") }))
        let endFirst = try #require(events.firstIndex(of: "play-end:最初です。"))
        let requestThird = try #require(events.firstIndex(where: { $0.hasPrefix("request:最後です。") }))
        let startSecond = try #require(events.firstIndex(of: "play-start:次です。"))
        let endSecond = try #require(events.firstIndex(of: "play-end:次です。"))

        #expect(requestSecond < endFirst)
        #expect(requestThird > endFirst)
        #expect(requestThird < endSecond)
        #expect(startSecond > endFirst)
        #expect(events.filter { $0.hasPrefix("play-start:") } == segments.map { "play-start:\($0)" })
        #expect(events.filter { $0.hasPrefix("play-end:") } == segments.map { "play-end:\($0)" })
    }

    private static func stream(named name: String) -> ShannonGeminiSpeechStream {
        ShannonGeminiSpeechStream(
            model: "test",
            voice: name,
            outputUsdPerTenSeconds: 0,
            chunks: AsyncThrowingStream { continuation in
                continuation.yield(Data(repeating: 1, count: 4_800))
                continuation.finish()
            }
        )
    }
}
