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
            pose: Pose(style: style, energy: 0.56, decor: .none),
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
        let liveness = isAnimated ? liveness(at: elapsedTime, energy: pose.energy) : Liveness.still
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

    private static func liveness(at time: Double, energy: Double) -> Liveness {
        Liveness(
            yaw: (loopNoise(time, period: 11.3, seed: 0.4) * 5.5
                + loopNoise(time, period: 3.7, seed: 2.1) * 1.6) * energy,
            pitch: (loopNoise(time, period: 9.1, seed: 1.3) * 4.2
                + loopNoise(time, period: 4.3, seed: 0.7) * 1.3) * energy,
            roll: loopNoise(time, period: 13.7, seed: 3.2) * 2.2 * energy,
            lid: blinkLid(at: time),
            driftX: loopNoise(time, period: 7.9, seed: 1.9) * 0.006 * energy,
            driftY: loopNoise(time, period: 5.3, seed: 0.3) * 0.007 * energy,
            breath: 1 + sin((time / 3.4) * 2 * .pi) * 0.005 * energy
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
