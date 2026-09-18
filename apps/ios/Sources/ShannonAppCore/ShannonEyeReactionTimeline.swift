import Foundation

struct ShannonEyeReactionSample: Equatable, Sendable {
    let style: ShannonEyeStyle
    let blushOpacity: Double
}

enum ShannonEyeReactionTimeline {
    static let surpriseEnd = 0.16
    static let bashfulEnd = 0.42
    static let holdEnd = 1.10
    static let duration = 1.50

    static func sample(
        origin: ShannonEyeStyle,
        base: ShannonEyeStyle,
        elapsedTime: TimeInterval
    ) -> ShannonEyeReactionSample {
        let elapsedTime = max(0, elapsedTime)
        let surprised = ShannonEyeRig.style(for: .surprised)
        let bashful = ShannonEyeRig.style(for: .bashful)

        if elapsedTime < surpriseEnd {
            let progress = ShannonEyeRig.easeOutQuint(elapsedTime / surpriseEnd)
            return .init(
                style: origin.blended(toward: surprised, progress: progress),
                blushOpacity: 0
            )
        }
        if elapsedTime < bashfulEnd {
            let progress = ShannonEyeRig.easeOutQuint(
                (elapsedTime - surpriseEnd) / (bashfulEnd - surpriseEnd)
            )
            return .init(
                style: surprised.blended(toward: bashful, progress: progress),
                blushOpacity: progress
            )
        }
        if elapsedTime < holdEnd {
            return .init(style: bashful, blushOpacity: 1)
        }
        if elapsedTime < duration {
            let progress = ShannonEyeRig.easeOutQuint(
                (elapsedTime - holdEnd) / (duration - holdEnd)
            )
            return .init(
                style: bashful.blended(toward: base, progress: progress),
                blushOpacity: 1 - progress
            )
        }
        return .init(style: base, blushOpacity: 0)
    }
}
