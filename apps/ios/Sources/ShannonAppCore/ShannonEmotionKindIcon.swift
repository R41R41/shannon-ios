import Foundation

/// The emotion kinds that have an icon of their own beside the 22 faces (owner decision 2026-10-05: finer
/// emotions in the chat avatar). This is the one list of them. The raw value is the server's kind name
/// (`SHANNON_EMOTION_KINDS`, sent as `messageEmotion.kind`), the picture is the resource
/// `shannon-emotion-<kind>.png` (same framing as the face icons), and the name is the shared copy
/// (`design/strings.ja.json`, `emotion.kind.*`).
///
/// A kind that is not listed here, or whose picture is not in the bundle (yet), shows the face icon: the
/// pictures can be added to `Resources/` at any time without a code change.
public enum ShannonEmotionKindIcon: String, CaseIterable, Equatable, Sendable {
    case pride
    case triumphant
    case competitive
    case mischievous
    case plotting
    case teasing
    case playful
    case affectionate
    case attentionSeeking
    case lightPossessive
    case gratitude
    case sulky
    case cuteAngry
    case seriousAnger
    case frustrated
    case lonely
    case leftOut
    case disappointed
    case hurt
    case lamenting
    case anxious
    case panic
    case speechless
    case helpless
    case deadpan
    case giggle

    /// The name for VoiceOver and for the label beside 「シャノン」 while this icon is shown.
    public var japaneseName: String {
        switch self {
        case .pride: ShannonGeneratedStrings.emotionKindPride
        case .triumphant: ShannonGeneratedStrings.emotionKindTriumphant
        case .competitive: ShannonGeneratedStrings.emotionKindCompetitive
        case .mischievous: ShannonGeneratedStrings.emotionKindMischievous
        case .plotting: ShannonGeneratedStrings.emotionKindPlotting
        case .teasing: ShannonGeneratedStrings.emotionKindTeasing
        case .playful: ShannonGeneratedStrings.emotionKindPlayful
        case .affectionate: ShannonGeneratedStrings.emotionKindAffectionate
        case .attentionSeeking: ShannonGeneratedStrings.emotionKindAttentionSeeking
        case .lightPossessive: ShannonGeneratedStrings.emotionKindLightPossessive
        case .gratitude: ShannonGeneratedStrings.emotionKindGratitude
        case .sulky: ShannonGeneratedStrings.emotionKindSulky
        case .cuteAngry: ShannonGeneratedStrings.emotionKindCuteAngry
        case .seriousAnger: ShannonGeneratedStrings.emotionKindSeriousAnger
        case .frustrated: ShannonGeneratedStrings.emotionKindFrustrated
        case .lonely: ShannonGeneratedStrings.emotionKindLonely
        case .leftOut: ShannonGeneratedStrings.emotionKindLeftOut
        case .disappointed: ShannonGeneratedStrings.emotionKindDisappointed
        case .hurt: ShannonGeneratedStrings.emotionKindHurt
        case .lamenting: ShannonGeneratedStrings.emotionKindLamenting
        case .anxious: ShannonGeneratedStrings.emotionKindAnxious
        case .panic: ShannonGeneratedStrings.emotionKindPanic
        case .speechless: ShannonGeneratedStrings.emotionKindSpeechless
        case .helpless: ShannonGeneratedStrings.emotionKindHelpless
        case .deadpan: ShannonGeneratedStrings.emotionKindDeadpan
        case .giggle: ShannonGeneratedStrings.emotionKindGiggle
        }
    }

    var assetName: String {
        "shannon-emotion-\(rawValue)"
    }

    /// The kinds whose picture is in this build's bundle. The bundle does not change while the app runs.
    static let bundled: Set<ShannonEmotionKindIcon> = Set(allCases.filter {
        ShannonExpressionAssets.url(forAsset: $0.assetName) != nil
    })

    /// The icon to show for a kind name from the server. Nil for no kind, for a kind this build does not
    /// know, and for a kind whose picture is not bundled: the face icon is shown then.
    public static func displayed(_ name: String?) -> ShannonEmotionKindIcon? {
        displayed(name, bundled: bundled)
    }

    static func displayed(_ name: String?, bundled: Set<ShannonEmotionKindIcon>) -> ShannonEmotionKindIcon? {
        guard let kind = name.flatMap(ShannonEmotionKindIcon.init(rawValue:)), bundled.contains(kind) else { return nil }
        return kind
    }
}
