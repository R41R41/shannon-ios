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
        var offsetX: Double = 0
        var offsetY: Double = 0
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
                open: mix(start.open, end.open),
                offsetX: mix(start.offsetX, end.offsetX),
                offsetY: mix(start.offsetY, end.offsetY)
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
        let gaze: ShannonEyeStyle.Gaze
        let lid: Double
        let driftX: Double
        let driftY: Double
        let breath: Double
        let decor: Decor
    }

    struct Pose: Sendable {
        let style: ShannonEyeStyle
        let energy: Double
        let decor: Decor
        let blinkProfile: BlinkProfile
    }

    enum BlinkProfile: Equatable, Sendable {
        case natural
        case bright
        case sparse
        case slow
        case double
        case wink
        case sideEye
        case drowsy

        var duration: Double {
            switch self {
            case .slow: 0.28
            case .drowsy: 0.42
            default: 0.18
            }
        }

        var intervalRange: ClosedRange<Double> {
            switch self {
            case .bright: 2.2...3.7
            case .sparse: 4.1...6.7
            case .slow: 3.1...5.2
            case .double: 2.4...4.1
            case .wink: 2.7...4.5
            case .sideEye: 3.2...5.1
            case .drowsy: 1.8...3.0
            case .natural: 2.8...5.2
            }
        }
    }

    struct Decor: Sendable {
        enum Kind: Equatable, Sendable {
            case none
            case orbit
            case thinkingDot
            case scan
            case burst
        }

        let kind: Kind
        let strength: Double
        let phase: Double

        static let none = Decor(kind: .none, strength: 0, phase: 0)
    }

    private struct Vector3: Sendable {
        var x: Double
        var y: Double
        var z: Double
    }

    static func style(for expression: ShannonExpressionDTO) -> ShannonEyeStyle {
        switch expression {
        case .neutral:
            return style(
                gaze: (8, 5, -4),
                split: 16.4,
                left: .init(width: 0.23, height: 0.54, tilt: -7),
                right: .init(width: 0.22, height: 0.51, tilt: -4)
            )
        case .joyful:
            return style(gaze: (1, 10, 0), split: 17.2, pair: (0.32, 0.14, 15, 1))
        case .excited:
            return style(gaze: (2, -11, 0), split: 19.4, pair: (0.37, 0.60, -9, 1))
        case .amused:
            return style(
                gaze: (7, 5, -3),
                split: 17.3,
                left: .init(width: 0.31, height: 0.14, tilt: 15),
                right: .init(width: 0.22, height: 0.48, tilt: -7)
            )
        case .laughing:
            return style(gaze: (0, 14, 0), split: 18.1, pair: (0.35, 0.115, 21, 1))
        case .bashful:
            return style(gaze: (-10, -3, -5), split: 15.2, pair: (0.29, 0.15, 13, 1))
        case .embarrassed:
            return style(gaze: (-17, -12, -7), split: 14.7, pair: (0.19, 0.39, -8, 1))
        case .relieved:
            return style(gaze: (0, 9, 0), split: 16.1, pair: (0.29, 0.13, 10, 1))
        case .surprised:
            return style(gaze: (0, -8, 0), split: 19.8, pair: (0.43, 0.49, 0, 1))
        case .curious:
            return style(
                gaze: (17, -8, -11),
                split: 16.2,
                left: .init(width: 0.25, height: 0.55, tilt: -7),
                right: .init(width: 0.20, height: 0.43, tilt: -7)
            )
        case .thinking:
            return style(
                gaze: (-17, -13, 8),
                split: 15.6,
                left: .init(width: 0.21, height: 0.46, tilt: -12),
                right: .init(width: 0.20, height: 0.39, tilt: -12)
            )
        case .confused:
            return style(
                gaze: (-10, 1, 7),
                split: 16.4,
                left: .init(width: 0.21, height: 0.50, tilt: -18),
                right: .init(width: 0.30, height: 0.16, tilt: 15)
            )
        case .determined:
            return style(gaze: (0, 8, 0), split: 17.1, pair: (0.33, 0.16, 28, 1))
        case .tender:
            return style(gaze: (0, 7, 0), split: 15.8, pair: (0.24, 0.43, 7, 1))
        case .calm:
            return style(gaze: (0, 8, -2), split: 16, pair: (0.28, 0.18, 9, 1))
        case .jealous:
            return style(
                gaze: (20, 3, -5),
                split: 15.8,
                left: .init(width: 0.22, height: 0.38, tilt: -9),
                right: .init(width: 0.28, height: 0.14, tilt: -4)
            )
        case .wry:
            return style(
                gaze: (12, 7, -4),
                split: 16.2,
                left: .init(width: 0.31, height: 0.14, tilt: 14),
                right: .init(width: 0.22, height: 0.42, tilt: -10)
            )
        case .exasperated:
            return style(
                gaze: (19, 2, 0),
                split: 16.8,
                left: .init(width: 0.31, height: 0.13, tilt: 3),
                right: .init(width: 0.28, height: 0.11, tilt: -3)
            )
        case .annoyed:
            return style(gaze: (8, 8, 0), split: 16.6, pair: (0.34, 0.15, 27, 1))
        case .concerned:
            return style(gaze: (0, -7, 0), split: 15.8, pair: (0.22, 0.43, -25, 1))
        case .sad:
            return style(gaze: (0, -15, 0), split: 15.4, pair: (0.22, 0.47, -27, 1))
        case .sleepy:
            return style(gaze: (-4, -5, -3), split: 15.8, pair: (0.28, 0.105, 2, 0.62))
        }
    }

    static func frame(
        style: ShannonEyeStyle,
        elapsedTime: TimeInterval,
        isAnimated: Bool
    ) -> Frame {
        frame(
            pose: Pose(style: style, energy: 0.56, decor: .none, blinkProfile: .natural),
            elapsedTime: elapsedTime,
            isAnimated: isAnimated
        )
    }

    static func frame(
        pose: Pose,
        elapsedTime: TimeInterval,
        isAnimated: Bool
    ) -> Frame {
        let style = pose.style
        let liveness = isAnimated
            ? liveness(at: elapsedTime, energy: pose.energy, blinkProfile: pose.blinkProfile)
            : Liveness.still
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
            gaze: .init(
                yaw: style.gaze.yaw + liveness.yaw,
                pitch: style.gaze.pitch + liveness.pitch,
                roll: style.gaze.roll + liveness.roll
            ),
            lid: liveness.lid,
            driftX: liveness.driftX,
            driftY: liveness.driftY,
            breath: liveness.breath,
            decor: pose.decor
        )
    }

    static func easeOutQuint(_ value: Double) -> Double {
        let value = min(1, max(0, value))
        return 1 - pow(1 - value, 5)
    }

    static func blinkScale(_ lid: Double) -> Double {
        0.06 + 0.94 * min(1, max(0, lid))
    }

    static func hasPersistentBlush(_ expression: ShannonExpressionDTO) -> Bool {
        expression == .bashful || expression == .embarrassed
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

    private static func liveness(
        at time: Double,
        energy: Double,
        blinkProfile: BlinkProfile
    ) -> Liveness {
        Liveness(
            yaw: (signedNoise(time, period: 8.7, phase: 0.13) * 4.8
                + signedNoise(time, period: 3.9, phase: 0.51) * 1.5) * energy,
            pitch: (signedNoise(time, period: 10.9, phase: 0.31) * 3.5
                + signedNoise(time, period: 4.7, phase: 0.09)) * energy,
            roll: signedNoise(time, period: 12.7, phase: 0.76) * 2.1 * energy,
            lid: blinkLid(at: time, profile: blinkProfile),
            driftX: 0,
            driftY: 0,
            breath: 1 + signedNoise(time, period: 4.9, phase: 0.2) * 0.0035 * energy
        )
    }

    private static func signedNoise(_ time: Double, period: Double, phase: Double) -> Double {
        sin((time / period + phase) * 2 * .pi)
    }

    static func blinkLid(at time: Double) -> Double {
        blinkLid(at: time, profile: .natural)
    }

    static func blinkLid(at time: Double, profile: BlinkProfile) -> Double {
        var localTime = time.truncatingRemainder(dividingBy: 900)
        if localTime < 0 { localTime += 900 }

        for start in blinkSchedule(for: profile) {
            if localTime < start { break }
            let elapsed = localTime - start
            guard elapsed <= profile.duration else { continue }
            let progress = elapsed / profile.duration
            if progress < 0.42 {
                return 1 - progress / 0.42
            }
            return (progress - 0.42) / 0.58
        }
        return 1
    }

    private static func blinkSchedule(for profile: BlinkProfile) -> [Double] {
        var time = 1.9
        var blinkIndex = 0
        var result: [Double] = []
        while time < 900 {
            result.append(time)
            blinkIndex += 1
            let seeded = 0.5 + 0.5 * sin(Double(blinkIndex) * 9.173 + 1.7)
            let range = profile.intervalRange
            time += range.lowerBound + (range.upperBound - range.lowerBound) * seeded
        }
        return result
    }
}
