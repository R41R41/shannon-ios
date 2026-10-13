import CoreGraphics

/// The three moments of Talk's dialogue display in the Live2D form (owner pick 2026-10-13, option C
/// 「話す時は大きく、読む時は小さく」). Pure, so the rules are tested without a view.
///
/// - `talk`: she is large, her upper body (上半身) over the upper part of the screen, with the owner's last line
///   and her reply under her.
/// - `read`: the owner scrolled back to read the conversation: the conversation takes the full width and she is
///   a still close-up of her face in the corner (the Live2D page is not drawn meanwhile). Tapping it returns.
/// - `call`: a voice conversation runs: she fills the screen and the composer gives way to the call's controls.
public enum ShannonDialogueStage: String, CaseIterable, Equatable, Sendable {
    case talk, read, call

    /// A running voice conversation always wins; otherwise the owner's reading decides.
    public static func resolve(callIsLive: Bool, reads: Bool) -> Self {
        if callIsLive { return .call }
        return reads ? .read : .talk
    }

    /// What changes whether the owner is reading the conversation.
    public enum Event: Equatable, Sendable {
        /// He pulled the words down (scrolled back) or chose 「会話全体を読む」.
        case scrolledBack
        /// He tapped her face in the corner.
        case tappedFace
        /// He sent something: she is about to answer, large.
        case ownerSent
        /// Another conversation was opened.
        case threadChanged
        /// A voice conversation began or ended: she comes back large after it.
        case callChanged
    }

    /// Whether the owner reads the conversation after `event`.
    public static func reads(after event: Event) -> Bool {
        switch event {
        case .scrolledBack: true
        case .tappedFace, .ownerSent, .threadChanged, .callChanged: false
        }
    }

    /// A downward pull of the words longer than this (points) is a scroll back to read.
    public static let scrollBackDistance: CGFloat = 48

    /// A vertical pull: down (positive) and mostly vertical.
    public static func isScrollBack(translation: CGSize) -> Bool {
        translation.height > scrollBackDistance && abs(translation.height) > abs(translation.width) * 1.5
    }

    /// The share of the stage's height (top safe area included) her figure takes.
    public var figureShare: CGFloat {
        switch self {
        case .talk: 0.6
        case .call: 0.82
        case .read: 0
        }
    }

    /// The diameter of her face in the corner while the owner reads.
    public static let cornerFaceSize: CGFloat = 56

    /// The Live2D page is drawn only while she is large; the corner face is a still picture.
    public var drawsLive2D: Bool { self != .read }

    /// The composer is replaced by the call's controls during a call.
    public var showsComposer: Bool { self != .call }

    /// The one line of work in progress over the composer has no place beside the call's controls.
    public var showsActivityLine: Bool { self != .call }
}
