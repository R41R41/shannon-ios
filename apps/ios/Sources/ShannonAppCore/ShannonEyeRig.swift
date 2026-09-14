import CoreGraphics
import Foundation

// Sphere projection, measured eye geometry, and ambient timing are adapted from
// Jérémy Perret's MIT-licensed bloub reference implementation. See THIRD_PARTY_NOTICES.md.
struct ShannonEyeStyle: Equatable, Sendable {
    struct Gaze: Equatable, Sendable {
        var yaw: Double
        var pitch: Double
        var roll: Double
    }

    struct Eye: Equatable, Sendable {
        var width: Double
        var height: Double
        var tilt: Double = 0
        var open: Double = 1
    }

    var gaze: Gaze
    var split: Double
    var left: Eye
    var right: Eye

    func blended(toward target: Self, progress: Double) -> Self {
        let progress = min(1, max(0, progress))
        func mix(_ start: Double, _ end: Double) -> Double {
            start + (end - start) * progress
        }
        func mixEye(_ start: Eye, _ end: Eye) -> Eye {
            Eye(
                width: mix(start.width, end.width),
                height: mix(start.height, end.height),
                tilt: mix(start.tilt, end.tilt),
                open: mix(start.open, end.open)
            )
        }

        return Self(
            gaze: Gaze(
                yaw: mix(gaze.yaw, target.gaze.yaw),
                pitch: mix(gaze.pitch, target.gaze.pitch),
                roll: mix(gaze.roll, target.gaze.roll)
            ),
            split: mix(split, target.split),
            left: mixEye(left, target.left),
            right: mixEye(right, target.right)
        )
    }
}

enum ShannonEyeRig {
    static let transitionDuration = 0.45
    static let heroEyeScale = 1.6
    static let eyeWidth = 0.186
    static let eyeHeight = 0.412
    static let eyeSplit = 15.46

    struct ProjectedEye: Sendable {
        let configuration: ShannonEyeStyle.Eye
        let position: CGPoint
        let horizontal: CGVector
        let vertical: CGVector
        let depth: Double
    }

    struct Frame: Sendable {
        let eyes: [ProjectedEye]
        let lid: Double
        let driftX: Double
        let driftY: Double
        let breath: Double
    }

    private struct Vector3: Sendable {
        var x: Double
        var y: Double
        var z: Double
    }

    static func style(for expression: ShannonExpressionDTO) -> ShannonEyeStyle {
        switch expression {
        case .joyful, .amused, .tender:
            return style(gaze: (5, 9, 0), split: 17, pair: (0.27, 0.17, 14, 1))
        case .excited:
            return style(gaze: (6, -14, 0), split: 19.5, pair: (0.40, 0.56, -10, 1))
        case .laughing:
            return style(gaze: (4, 14, 0), split: 18, pair: (0.34, 0.13, 20, 1))
        case .bashful, .embarrassed:
            return style(gaze: (-19, -14, -7), split: 14, pair: (0.17, 0.30, 0, 1))
        case .relieved:
            return style(gaze: (5, 17, 0), split: 17, pair: (0.30, 0.15, 18, 1))
        case .surprised:
            return style(gaze: (3, -3, 0), split: 19, pair: (0.45, 0.47, 0, 1))
        case .curious:
            return style(gaze: (16, -9, -15), split: 16.5, pair: (0.24, 0.46, -8, 1), rightSize: (0.20, 0.38))
        case .thinking:
            return style(
                gaze: (12, 6, -6),
                split: 16,
                left: .init(width: 0.21, height: 0.40),
                right: .init(width: 0.22, height: 0.15)
            )
        case .confused:
            return style(
                gaze: (-14, 3, 8),
                split: 16.5,
                left: .init(width: 0.20, height: 0.44, tilt: -18),
                right: .init(width: 0.28, height: 0.17, tilt: 14)
            )
        case .determined, .annoyed:
            return style(gaze: (3, 7, 0), split: 17, pair: (0.34, 0.15, 30, 1))
        case .calm, .neutral:
            return style(gaze: (28.49, 28.62, -13), split: eyeSplit, pair: (eyeWidth, eyeHeight, 0, 1))
        case .jealous, .wry:
            return style(
                gaze: (12, 6, -6),
                split: 16,
                left: .init(width: 0.21, height: 0.40),
                right: .init(width: 0.22, height: 0.15)
            )
        case .exasperated:
            return style(gaze: (-22, 2, 0), split: 16, pair: (0.30, 0.12, 0, 1))
        case .concerned, .sad:
            return style(gaze: (3, -13, 0), split: 16, pair: (0.22, 0.40, -28, 1))
        case .sleepy:
            return style(gaze: (6, -9, -3), split: 16, pair: (0.20, 0.42, 0, 0.42))
        }
    }

    static func frame(
        style: ShannonEyeStyle,
        elapsedTime: TimeInterval,
        isAnimated: Bool
    ) -> Frame {
        let liveness = isAnimated ? liveness(at: elapsedTime) : Liveness.still
        var forward = Vector3(x: 0, y: 0, z: 1)
        var horizontal = Vector3(x: 1, y: 0, z: 0)
        var vertical = Vector3(x: 0, y: 1, z: 0)

        spin(&forward, &horizontal, degrees: style.gaze.yaw + liveness.yaw)
        spin(&vertical, &forward, degrees: style.gaze.pitch + liveness.pitch)
        spin(&horizontal, &vertical, degrees: style.gaze.roll + liveness.roll)

        let configurations = [style.left, style.right]
        let eyes = [-1.0, 1.0].enumerated().map { index, side -> ProjectedEye in
            var eyeForward = forward
            var eyeHorizontal = horizontal
            spin(&eyeForward, &eyeHorizontal, degrees: style.split * side)
            return ProjectedEye(
                configuration: configurations[index],
                position: CGPoint(x: eyeForward.x, y: eyeForward.y),
                horizontal: CGVector(dx: eyeHorizontal.x, dy: eyeHorizontal.y),
                vertical: CGVector(dx: vertical.x, dy: vertical.y),
                depth: eyeForward.z
            )
        }

        return Frame(
            eyes: eyes,
            lid: liveness.lid,
            driftX: liveness.driftX,
            driftY: liveness.driftY,
            breath: liveness.breath
        )
    }

    static func easeOutQuint(_ value: Double) -> Double {
        let value = min(1, max(0, value))
        return 1 - pow(1 - value, 5)
    }

    static func blinkScale(_ lid: Double) -> Double {
        0.06 + 0.94 * min(1, max(0, lid))
    }

    private static func style(
        gaze: (Double, Double, Double),
        split: Double,
        pair: (Double, Double, Double, Double),
        rightSize: (Double, Double)? = nil
    ) -> ShannonEyeStyle {
        let rightSize = rightSize ?? (pair.0, pair.1)
        return style(
            gaze: gaze,
            split: split,
            left: .init(width: pair.0, height: pair.1, tilt: pair.2, open: pair.3),
            right: .init(width: rightSize.0, height: rightSize.1, tilt: -pair.2, open: pair.3)
        )
    }

    private static func style(
        gaze: (Double, Double, Double),
        split: Double,
        left: ShannonEyeStyle.Eye,
        right: ShannonEyeStyle.Eye
    ) -> ShannonEyeStyle {
        .init(
            gaze: .init(yaw: gaze.0, pitch: gaze.1, roll: gaze.2),
            split: split,
            left: left,
            right: right
        )
    }

    private static func spin(
        _ first: inout Vector3,
        _ second: inout Vector3,
        degrees: Double
    ) {
        let radians = degrees * .pi / 180
        let cosine = cos(radians)
        let sine = sin(radians)
        let originalFirst = first
        let originalSecond = second
        first = Vector3(
            x: originalFirst.x * cosine + originalSecond.x * sine,
            y: originalFirst.y * cosine + originalSecond.y * sine,
            z: originalFirst.z * cosine + originalSecond.z * sine
        )
        second = Vector3(
            x: originalSecond.x * cosine - originalFirst.x * sine,
            y: originalSecond.y * cosine - originalFirst.y * sine,
            z: originalSecond.z * cosine - originalFirst.z * sine
        )
    }

    private struct Liveness: Sendable {
        let yaw: Double
        let pitch: Double
        let roll: Double
        let lid: Double
        let driftX: Double
        let driftY: Double
        let breath: Double

        static let still = Liveness(
            yaw: 0,
            pitch: 0,
            roll: 0,
            lid: 1,
            driftX: 0,
            driftY: 0,
            breath: 1
        )
    }

    private static func liveness(at time: Double) -> Liveness {
        Liveness(
            yaw: loopNoise(time, period: 11.3, seed: 0.4) * 5.5
                + loopNoise(time, period: 3.7, seed: 2.1) * 1.6,
            pitch: loopNoise(time, period: 9.1, seed: 1.3) * 4.2
                + loopNoise(time, period: 4.3, seed: 0.7) * 1.3,
            roll: loopNoise(time, period: 13.7, seed: 3.2) * 2.2,
            lid: blinkLid(at: time),
            driftX: loopNoise(time, period: 7.9, seed: 1.9) * 0.006,
            driftY: loopNoise(time, period: 5.3, seed: 0.3) * 0.007,
            breath: 1 + sin((time / 3.4) * 2 * .pi) * 0.005
        )
    }

    private static func loopNoise(_ time: Double, period: Double, seed: Double) -> Double {
        let phase = (time / period) * 2 * .pi
        return 0.55 * sin(phase + seed)
            + 0.30 * sin(2 * phase + seed * 1.7 + 1.1)
            + 0.15 * sin(3 * phase + seed * 2.3 + 2.4)
    }

    static func blinkLid(at time: Double) -> Double {
        let blinkDuration = 0.18
        var localTime = time.truncatingRemainder(dividingBy: 900)
        if localTime < 0 { localTime += 900 }

        for start in blinkSchedule {
            if localTime < start { break }
            let elapsed = localTime - start
            guard elapsed <= blinkDuration else { continue }
            let progress = elapsed / blinkDuration
            if progress < 0.45 {
                return 1 - progress / 0.45
            }
            return (progress - 0.45) / 0.55
        }
        return 1
    }

    private static let blinkSchedule: [Double] = {
        var random = SeededRandom(state: 0x5EED)
        var time = 1.4
        var result: [Double] = []
        while time < 900 {
            result.append(time)
            if random.next() < 0.18 {
                result.append(time + 0.24)
            }
            time += 1.9 + random.next() * 2.7
        }
        return result
    }()

    private struct SeededRandom {
        var state: UInt32

        mutating func next() -> Double {
            state &+= 0x6D2B79F5
            var value = state
            value = (value ^ (value >> 15)) &* (UInt32(1) | value)
            value = (value &+ ((value ^ (value >> 7)) &* (UInt32(61) | value))) ^ value
            value ^= value >> 14
            return Double(value) / 4_294_967_296
        }
    }
}

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
