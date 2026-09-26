import Foundation

public enum ShannonVoiceLabSource: String, CaseIterable, Identifiable, Sendable {
    case fixedJapanese
    case importedWAV
    case realtime

    public var id: String { rawValue }

    public var japaneseName: String {
        switch self {
        case .fixedJapanese: "固定の日本語"
        case .importedWAV: "WAV / PCM"
        case .realtime: "GPT-Live"
        }
    }
}

public enum ShannonVoiceLabProcessingKind: String, Sendable {
    case bypass
    case appleTimePitch
    case signalsmith
    case rvc
}

public struct ShannonVoiceLabPreset: Identifiable, Hashable, Sendable {
    public let id: String
    public let title: String
    public let detail: String
    public let kind: ShannonVoiceLabProcessingKind
    public let pitchCents: Float
    public let formantSemitones: Float
    public let rate: Float
    public let outputGainDB: Float

    public init(
        id: String,
        title: String,
        detail: String,
        kind: ShannonVoiceLabProcessingKind,
        pitchCents: Float = 0,
        formantSemitones: Float = 0,
        rate: Float = 1,
        outputGainDB: Float = 0
    ) {
        self.id = id
        self.title = title
        self.detail = detail
        self.kind = kind
        self.pitchCents = pitchCents
        self.formantSemitones = formantSemitones
        self.rate = rate
        self.outputGainDB = outputGainDB
    }

    public static let comparisonSet: [Self] = [
        .init(
            id: "off",
            title: "OFF",
            detail: "加工なしの基準音",
            kind: .bypass
        ),
        .init(
            id: "pitch-80",
            title: "Pitch +80",
            detail: "AVAudioUnitTimePitch・自然さ優先",
            kind: .appleTimePitch,
            pitchCents: 80,
            outputGainDB: -0.5
        ),
        .init(
            id: "pitch-120",
            title: "Pitch +120",
            detail: "AVAudioUnitTimePitch・中間候補",
            kind: .appleTimePitch,
            pitchCents: 120,
            outputGainDB: -0.8
        ),
        .init(
            id: "pitch-160",
            title: "Pitch +160",
            detail: "AVAudioUnitTimePitch・可愛さ強め",
            kind: .appleTimePitch,
            pitchCents: 160,
            outputGainDB: -1
        ),
        .init(
            id: "formant-only",
            title: "Formant +1.4",
            detail: "Signalsmith・声道だけ短くする比較",
            kind: .signalsmith,
            formantSemitones: 1.4,
            outputGainDB: -0.8
        ),
        .init(
            id: "pitch-formant",
            title: "Pitch +100 / Formant +1.2",
            detail: "Signalsmith・Shannon候補",
            kind: .signalsmith,
            pitchCents: 100,
            formantSemitones: 1.2,
            outputGainDB: -1
        ),
        .init(
            id: "rvc",
            title: "RVC",
            detail: "許諾済みShannonモデルのローカル変換",
            kind: .rvc,
            outputGainDB: -1
        ),
        .init(
            id: "rvc-finish",
            title: "RVC + finish",
            detail: "RVC後に+60 centsで仕上げる複合候補",
            kind: .rvc,
            pitchCents: 60,
            outputGainDB: -1.2
        ),
    ]

    public static func custom(
        pitchCents: Float,
        formantSemitones: Float
    ) -> Self {
        let pitch = ShannonVoiceLabTuning.clampedPitch(pitchCents)
        let formant = ShannonVoiceLabTuning.clampedFormant(formantSemitones)
        let kind: ShannonVoiceLabProcessingKind
        if abs(formant) >= ShannonVoiceLabTuning.formantStep / 2 {
            kind = .signalsmith
        } else if abs(pitch) >= ShannonVoiceLabTuning.pitchStep / 2 {
            kind = .appleTimePitch
        } else {
            kind = .bypass
        }
        return .init(
            id: String(format: "custom-p%+.0f-f%+.1f", pitch, formant),
            title: "Custom",
            detail: "Pitch \(ShannonVoiceLabTuning.pitchLabel(pitch)) / Formant \(ShannonVoiceLabTuning.formantLabel(formant))",
            kind: kind,
            pitchCents: pitch,
            formantSemitones: formant,
            outputGainDB: kind == .bypass ? 0 : -1
        )
    }
}

public enum ShannonVoiceLabTuning {
    public static let pitchRange: ClosedRange<Float> = -300...400
    public static let formantRange: ClosedRange<Float> = -3...3
    public static let pitchStep: Float = 10
    public static let formantStep: Float = 0.1
    public static let defaultPitchCents: Float = 100
    public static let defaultFormantSemitones: Float = 1.2

    public static func clampedPitch(_ value: Float) -> Float {
        min(max(value, pitchRange.lowerBound), pitchRange.upperBound)
    }

    public static func clampedFormant(_ value: Float) -> Float {
        min(max(value, formantRange.lowerBound), formantRange.upperBound)
    }

    public static func pitchLabel(_ value: Float) -> String {
        String(format: "%+.0f cents", value)
    }

    public static func formantLabel(_ value: Float) -> String {
        String(format: "%+.1f semitone", value)
    }
}

public enum ShannonVoiceLabEvaluationScript {
    public static let japanese = """
    おはよう、シャノンです。浜松駅で待ち合わせて、うなぎと餃子を食べに行こう。
    青い空、赤い傘、白い雲。きょうはちょっと暑いけれど、ゆっくり歩けば大丈夫。
    新幹線、アップルパイ、コーヒー、学校、東京、遠州鉄道、シャノン。
    """
}

public struct ShannonVoiceLabChunkPolicy: Equatable, Sendable {
    public let sampleRate: Int
    public let chunkMilliseconds: Int
    public let lookAheadMilliseconds: Int
    public let maximumBufferedMilliseconds: Int

    public init(
        sampleRate: Int = 48_000,
        chunkMilliseconds: Int = 160,
        lookAheadMilliseconds: Int = 320,
        maximumBufferedMilliseconds: Int = 640
    ) {
        self.sampleRate = sampleRate
        self.chunkMilliseconds = chunkMilliseconds
        self.lookAheadMilliseconds = lookAheadMilliseconds
        self.maximumBufferedMilliseconds = maximumBufferedMilliseconds
    }

    public var framesPerChunk: Int { sampleRate * chunkMilliseconds / 1_000 }
    public var maximumBufferedFrames: Int { sampleRate * maximumBufferedMilliseconds / 1_000 }
}

public struct ShannonVoiceLabMeasurement: Identifiable, Equatable, Sendable {
    public let id: UUID
    public let presetID: String
    public let processingMilliseconds: Double
    public let algorithmLatencyMilliseconds: Double
    public let sourceDurationSeconds: Double
    public let recordedAt: Date

    public init(
        id: UUID = UUID(),
        presetID: String,
        processingMilliseconds: Double,
        algorithmLatencyMilliseconds: Double,
        sourceDurationSeconds: Double,
        recordedAt: Date = .now
    ) {
        self.id = id
        self.presetID = presetID
        self.processingMilliseconds = processingMilliseconds
        self.algorithmLatencyMilliseconds = algorithmLatencyMilliseconds
        self.sourceDurationSeconds = sourceDurationSeconds
        self.recordedAt = recordedAt
    }
}

public enum ShannonVoiceLabStatistics {
    public static func percentile95(_ values: [Double]) -> Double? {
        guard !values.isEmpty else { return nil }
        let sorted = values.sorted()
        let index = Int(ceil(Double(sorted.count) * 0.95)) - 1
        return sorted[max(0, min(index, sorted.count - 1))]
    }
}

#if DEBUG
enum ShannonVoiceLabLiveSettings {
    static let presetKey = "shannon.voiceLab.livePreset"
    static let customPitchKey = "shannon.voiceLab.customPitchCents"
    static let customFormantKey = "shannon.voiceLab.customFormantSemitones"

    static var preset: ShannonVoiceLabPreset {
        let identifier = UserDefaults.standard.string(forKey: presetKey) ?? "off"
        if identifier.hasPrefix("custom-") {
            return .custom(
                pitchCents: UserDefaults.standard.float(forKey: customPitchKey),
                formantSemitones: UserDefaults.standard.float(forKey: customFormantKey)
            )
        }
        return ShannonVoiceLabPreset.comparisonSet.first { $0.id == identifier }
            ?? ShannonVoiceLabPreset.comparisonSet[0]
    }

    static func save(_ preset: ShannonVoiceLabPreset) {
        UserDefaults.standard.set(preset.id, forKey: presetKey)
        if preset.id.hasPrefix("custom-") {
            UserDefaults.standard.set(preset.pitchCents, forKey: customPitchKey)
            UserDefaults.standard.set(preset.formantSemitones, forKey: customFormantKey)
        }
    }
}
#endif
