import Foundation

struct ShannonEyeReactionSample: Equatable, Sendable {
    let style: ShannonEyeStyle
    let blushOpacity: Double
}

enum ShannonEyeReactionTimeline {
    static let duration = 0.90

    static func sample(
        origin: ShannonEyeStyle,
        base: ShannonEyeStyle,
        elapsedTime: TimeInterval
    ) -> ShannonEyeReactionSample {
        _ = origin
        guard elapsedTime >= 0, elapsedTime <= duration else {
            return .init(style: base, blushOpacity: 0)
        }
        let reaction = sin(min(1, elapsedTime / duration) * .pi)
        var style = base
        style.left.width *= 1 + reaction * 0.07
        style.right.width *= 1 + reaction * 0.07
        style.left.height *= 1 - reaction * 0.10
        style.right.height *= 1 - reaction * 0.10
        return .init(
            style: style,
            blushOpacity: reaction > 0.20 ? 0.40 + reaction * 0.14 : 0
        )
    }
}
