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
        let gate = SpeechConsumptionGate()
        let coordinator = ShannonGeminiStreamingSpeechCoordinator(
            style: { text, _ in "style:\(text)" },
            streamSpeech: { text, style in
                events.append("request:\(text):\(style ?? "")")
                return Self.stream(named: text)
            },
            consumeSpeech: { speech in
                events.append("play-start:\(speech.voice)")
                await gate.wait()
                for try await _ in speech.chunks {}
                events.append("play-end:\(speech.voice)")
            }
        )

        await coordinator.enqueue(segments[0], plan: nil)
        await coordinator.enqueue(segments[1], plan: nil)
        let third = Task { @MainActor in await coordinator.enqueue(segments[2], plan: nil) }
        await waitUntil { await gate.waiterCount == 1 }
        #expect(events.filter { $0.hasPrefix("request:") }.count == 2)

        await gate.releaseOne()
        await third.value
        await waitUntil { await gate.waiterCount == 1 }
        await gate.releaseOne()
        await waitUntil { await gate.waiterCount == 1 }
        await gate.releaseOne()
        try await coordinator.finish()

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

    private func waitUntil(_ condition: @escaping @MainActor () async -> Bool) async {
        for _ in 0..<200 {
            if await condition() { return }
            await Task.yield()
        }
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

private actor SpeechConsumptionGate {
    private var waiters: [CheckedContinuation<Void, Never>] = []

    var waiterCount: Int { waiters.count }

    func wait() async {
        await withCheckedContinuation { waiters.append($0) }
    }

    func releaseOne() {
        guard !waiters.isEmpty else { return }
        waiters.removeFirst().resume()
    }
}
