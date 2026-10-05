import Foundation

public enum ShannonVoiceTranscriptSource: String, Codable, Equatable, Sendable {
    case interim
    case final
}

public struct ShannonVoiceTranscriptSegment: Codable, Equatable, Identifiable, Sendable {
    public let id: UUID
    public let text: String
    public let source: ShannonVoiceTranscriptSource
    public let receivedAt: Date

    public init(
        id: UUID = UUID(),
        text: String,
        source: ShannonVoiceTranscriptSource,
        receivedAt: Date
    ) {
        self.id = id
        self.text = text
        self.source = source
        self.receivedAt = receivedAt
    }
}

public struct ShannonVoiceConfidenceSpan: Codable, Equatable, Sendable {
    public let text: String
    public let confidence: Double

    public init(text: String, confidence: Double) {
        self.text = text
        self.confidence = min(1, max(0, confidence))
    }
}

public struct ShannonVoiceTurnEnvelope: Codable, Equatable, Identifiable, Sendable {
    public let id: UUID
    public let rawText: String
    public let normalizedText: String
    public let alternatives: [String]
    public let confidenceSpans: [ShannonVoiceConfidenceSpan]
    public let startedAt: Date
    public let endedAt: Date
    public let speaker: String
    public let addressee: String?
    public let isFinal: Bool
    public let correctionOf: UUID?
    public let segments: [ShannonVoiceTranscriptSegment]
}

/// Combines the cumulative and incremental transcript shapes returned by Gemini Live.
/// Gemini currently exposes neither alternatives nor confidence, so envelopes preserve
/// those fields as empty collections instead of inventing certainty.
struct ShannonVoiceTurnAssembler: Sendable {
    private(set) var finalText = ""
    private(set) var segments: [ShannonVoiceTranscriptSegment] = []
    /// When the first words of the utterance being assembled arrived.
    private(set) var startedAt: Date?
    private var lastCompletedID: UUID?

    var hasFinalText: Bool {
        !finalText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    mutating func preview(interim text: String, receivedAt: Date = Date()) -> String {
        let value = Self.cleaned(text)
        guard !value.isEmpty else { return finalText }
        if startedAt == nil { startedAt = receivedAt }
        return Self.merge(finalText, value)
    }

    mutating func appendFinal(_ text: String, receivedAt: Date = Date()) {
        let value = Self.cleaned(text)
        guard !value.isEmpty else { return }
        if startedAt == nil { startedAt = receivedAt }
        finalText = Self.merge(finalText, value)
        segments.append(
            ShannonVoiceTranscriptSegment(
                text: value,
                source: .final,
                receivedAt: receivedAt
            )
        )
    }

    /// How long the assembler waits for more words before an utterance is finished, by how it ends (milliseconds).
    enum FinalizationPause {
        /// It ends a sentence (。！？).
        static let sentenceEnd = 80
        /// It ends on a comma or a word that continues (けど, から…): the longest wait.
        static let continuation = 420
        /// Three characters or fewer.
        static let fragment = 360
        static let other = 220
    }

    func finalizationDelayMilliseconds(turnComplete: Bool) -> Int {
        if turnComplete { return 0 }
        let value = finalText.trimmingCharacters(in: .whitespacesAndNewlines)
        if value.range(of: #"[。！？!?][」』）】”\"]?$"#, options: .regularExpression) != nil { return FinalizationPause.sentenceEnd }
        if value.range(of: #"(?:[、…]|けど|から|ので|でも|だが|ながら|つつ)$"#, options: .regularExpression) != nil {
            return FinalizationPause.continuation
        }
        return value.count <= 3 ? FinalizationPause.fragment : FinalizationPause.other
    }

    mutating func finish(endedAt: Date = Date()) -> ShannonVoiceTurnEnvelope? {
        let raw = Self.cleaned(finalText)
        guard !raw.isEmpty else { return nil }
        let identifier = UUID()
        let envelope = ShannonVoiceTurnEnvelope(
            id: identifier,
            rawText: raw,
            normalizedText: Self.normalize(raw),
            alternatives: [],
            confidenceSpans: [],
            startedAt: startedAt ?? endedAt,
            endedAt: endedAt,
            speaker: "owner",
            addressee: Self.detectsShannonAddressee(in: raw) ? "shannon" : nil,
            isFinal: true,
            correctionOf: Self.isCorrection(raw) ? lastCompletedID : nil,
            segments: segments
        )
        finalText = ""
        segments = []
        startedAt = nil
        lastCompletedID = identifier
        return envelope
    }

    mutating func reset() {
        finalText = ""
        segments = []
        startedAt = nil
        lastCompletedID = nil
    }

    static func merge(_ current: String, _ next: String) -> String {
        let existing = cleaned(current)
        let incoming = cleaned(next)
        guard !incoming.isEmpty else { return existing }
        guard !existing.isEmpty else { return incoming }
        if incoming == existing || existing.hasSuffix(incoming) { return existing }
        if incoming.hasPrefix(existing) { return incoming }

        let maximumOverlap = min(existing.count, incoming.count)
        for length in stride(from: maximumOverlap, through: 1, by: -1) {
            if existing.suffix(length) == incoming.prefix(length) {
                return existing + incoming.dropFirst(length)
            }
        }

        let needsSpace = existing.last?.isASCIIWordCharacter == true
            && incoming.first?.isASCIIWordCharacter == true
        return existing + (needsSpace ? " " : "") + incoming
    }

    static func normalize(_ text: String) -> String {
        let replacements = [
            ("エーテル", "Aether"),
            ("ボイジャー", "Voyager"),
            ("シジジー", "Syzygy"),
            ("シジギー", "Syzygy"),
            ("ジェブ", "Jev"),
            ("マインボット", "Minebot"),
            ("コードエックス", "Codex"),
            ("スイフトユーアイ", "SwiftUI"),
            ("スイフトUI", "SwiftUI"),
            ("テストフライト", "TestFlight"),
        ]
        return replacements.reduce(cleaned(text)) { value, replacement in
            value.replacingOccurrences(of: replacement.0, with: replacement.1)
        }
    }

    private static func cleaned(_ text: String) -> String {
        text.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private static func isCorrection(_ text: String) -> Bool {
        text.range(
            of: #"^(?:違う[、,。]?|ちがう[、,。]?|訂正(?:すると|です)?[、,。]?|いや[、,])"#,
            options: .regularExpression
        ) != nil
    }

    private static func detectsShannonAddressee(in text: String) -> Bool {
        text.range(of: #"(?:^|[、,。\s])シャノン(?:[、,。\s]|$)"#, options: .regularExpression) != nil
    }
}

enum ShannonVoiceTurnDiagnostics {
    static func recordFinalizationScheduled(delay: Int, turnComplete: Bool) {
        ShannonVoiceDiagnostics.shared.record(
            "gemini.turn.finalization.scheduled",
            metadata: ["delay_ms": String(delay), "turn_complete": String(turnComplete)]
        )
    }

    static func recordAssembled(_ envelope: ShannonVoiceTurnEnvelope, turnComplete: Bool) {
        let duration = Int(max(0, envelope.endedAt.timeIntervalSince(envelope.startedAt)) * 1_000)
        ShannonVoiceDiagnostics.shared.record(
            "gemini.turn.assembled",
            metadata: [
                "assembly_ms": String(duration),
                "character_count": String(envelope.normalizedText.count),
                "correction": String(envelope.correctionOf != nil),
                "segment_count": String(envelope.segments.count),
                "turn_complete": String(turnComplete),
            ]
        )
    }
}

private extension Character {
    var isASCIIWordCharacter: Bool {
        unicodeScalars.count == 1 && unicodeScalars.allSatisfy {
            $0.isASCII && (CharacterSet.alphanumerics.contains($0) || $0 == "_")
        }
    }
}
