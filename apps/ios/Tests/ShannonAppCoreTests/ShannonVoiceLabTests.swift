import Testing
@testable import ShannonAppCore

@Suite("Shannon Voice Lab")
struct ShannonVoiceLabTests {
    @Test("pitch comparison keeps the requested OFF, 80, 120 and 160 cent anchors")
    func pitchComparisonAnchors() {
        let presets = ShannonVoiceLabPreset.comparisonSet
        #expect(presets.first?.kind == .bypass)
        #expect(presets.filter { $0.kind == .appleTimePitch }.map(\.pitchCents) == [80, 120, 160])
    }

    @Test("formant-only and combined comparisons are distinct")
    func independentFormantComparison() throws {
        let presets = ShannonVoiceLabPreset.comparisonSet
        let formantOnly = try #require(presets.first { $0.id == "formant-only" })
        let combined = try #require(presets.first { $0.id == "pitch-formant" })

        #expect(formantOnly.pitchCents == 0)
        #expect(formantOnly.formantSemitones > 0)
        #expect(combined.pitchCents > 0)
        #expect(combined.formantSemitones > 0)
    }

    @Test("custom tuning clamps values and chooses the live-capable path only without formant")
    func customTuning() {
        let pitchOnly = ShannonVoiceLabPreset.custom(pitchCents: 135, formantSemitones: 0)
        let pitchAndFormant = ShannonVoiceLabPreset.custom(pitchCents: 135, formantSemitones: 1.3)
        let clamped = ShannonVoiceLabPreset.custom(pitchCents: 999, formantSemitones: -9)

        #expect(pitchOnly.kind == .appleTimePitch)
        #expect(pitchAndFormant.kind == .signalsmith)
        #expect(clamped.pitchCents == ShannonVoiceLabTuning.pitchRange.upperBound)
        #expect(clamped.formantSemitones == ShannonVoiceLabTuning.formantRange.lowerBound)
        #expect(pitchAndFormant.id.contains("p+135"))
        #expect(pitchAndFormant.id.contains("f+1.3"))
    }

    @Test("RVC chunk policy stays bounded for realtime backpressure")
    func rvcChunkPolicy() {
        let policy = ShannonVoiceLabChunkPolicy()
        #expect(policy.framesPerChunk == 7_680)
        #expect(policy.maximumBufferedFrames == 30_720)
        #expect(policy.maximumBufferedMilliseconds == policy.chunkMilliseconds * 4)
    }

    @Test(
        "p95 uses a nearest-rank percentile",
        arguments: [
            ([1.0], 1.0),
            ([1.0, 2.0, 3.0, 4.0], 4.0),
            (Array(1...20).map(Double.init), 19.0),
        ]
    )
    func p95(values: [Double], expected: Double) {
        #expect(ShannonVoiceLabStatistics.percentile95(values) == expected)
    }
}
