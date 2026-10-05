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
            consumeSpeech: { speech, text in
                #expect(segments.contains(text))
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

    @Test("a sentence refused as busy is asked again briefly instead of silencing the reply")
    func retriesABusySentence() async throws {
        var attempts: [String: Int] = [:]
        var played: [String] = []
        let coordinator = ShannonGeminiStreamingSpeechCoordinator(
            style: { _, _ in "" },
            streamSpeech: { text, _ in
                attempts[text, default: 0] += 1
                if text == "最初です。", attempts[text]! <= 2 { throw ShannonSpeechBusy() }
                return Self.stream(named: text)
            },
            consumeSpeech: { speech, _ in
                for try await _ in speech.chunks {}
                played.append(speech.voice)
            },
            busyRetryDelays: [.milliseconds(1), .milliseconds(1), .milliseconds(1)]
        )
        await coordinator.enqueue("最初です。", plan: nil)
        await coordinator.enqueue("次です。", plan: nil)
        try await coordinator.finish()
        #expect(attempts["最初です。"] == 3)
        #expect(played == ["最初です。", "次です。"])
    }

    @Test("a rate-limited sentence is not asked again")
    func doesNotRetryRateLimit() async {
        var attempts = 0
        let coordinator = ShannonGeminiStreamingSpeechCoordinator(
            style: { _, _ in "" },
            streamSpeech: { _, _ in attempts += 1; throw ShannonAPIError.rejected(status: 429) },
            consumeSpeech: { _, _ in },
            busyRetryDelays: [.milliseconds(1), .milliseconds(1)]
        )
        await coordinator.enqueue("最初です。", plan: nil)
        await #expect(throws: ShannonAPIError.rejected(status: 429)) { try await coordinator.finish() }
        #expect(attempts == 1)
    }

    @Test("a sentence still refused after the pauses fails, and other errors are not retried")
    func givesUpOnPersistentRefusal() async {
        var attempts = 0
        let coordinator = ShannonGeminiStreamingSpeechCoordinator(
            style: { _, _ in "" },
            streamSpeech: { _, _ in
                attempts += 1
                if attempts == 1 { throw ShannonSpeechBusy() }
                throw ShannonAPIError.rejected(status: 502)
            },
            consumeSpeech: { _, _ in },
            busyRetryDelays: [.milliseconds(1), .milliseconds(1)]
        )
        await coordinator.enqueue("最初です。", plan: nil)
        await #expect(throws: ShannonAPIError.rejected(status: 502)) { try await coordinator.finish() }
        #expect(attempts == 2)
    }

    @Test("never more than two sentences are in flight, counting the one still streaming")
    func neverExceedsTwoInFlight() async throws {
        var inFlight = 0
        var highest = 0
        let gate = SpeechConsumptionGate()
        let coordinator = ShannonGeminiStreamingSpeechCoordinator(
            style: { _, _ in "" },
            streamSpeech: { text, _ in
                inFlight += 1
                highest = max(highest, inFlight)
                return Self.stream(named: text)
            },
            consumeSpeech: { speech, _ in
                await gate.wait()
                for try await _ in speech.chunks {}
                inFlight -= 1
            }
        )
        let sentences = (0..<5).map { "文\($0)です。" }
        let feeding = Task { @MainActor in
            for sentence in sentences { await coordinator.enqueue(sentence, plan: nil) }
        }
        for _ in sentences {
            await waitUntil { await gate.waiterCount == 1 }
            await gate.releaseOne()
        }
        await feeding.value
        try await coordinator.finish()
        #expect(highest == 2)
        #expect(inFlight == 0)
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
