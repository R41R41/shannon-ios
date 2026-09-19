import CoreGraphics
import Foundation

extension ShannonEyeRig {
    static func pose(
        for expression: ShannonExpressionDTO,
        activity: ShannonDialogueActivity,
        elapsedTime: TimeInterval,
        isAnimated: Bool,
        tracking: CGPoint? = nil
    ) -> Pose {
        let time = max(0, elapsedTime)
        let duration = activityDuration(activity)
        let phase = isAnimated ? (time / duration).truncatingRemainder(dividingBy: 1) : 0.25
        var style = style(for: expression)
        var decor = Decor.none

        switch activity {
        case .idle:
            break
        case .preparing:
            let settle = smoothstep(isAnimated ? time / 0.55 : 1)
            scaleEyes(&style, width: 0.88 + 0.12 * settle, height: 0.72 + 0.28 * settle)
            addGaze(&style, yaw: -4, pitch: -3, roll: 2)
        case .connecting:
            let angle = phase * 2 * .pi
            style.left = .init(
                width: 0.16,
                height: 0.16,
                offsetX: cos(angle) * 0.125,
                offsetY: sin(angle) * 0.081
            )
            style.right = .init(
                width: 0.16,
                height: 0.16,
                offsetX: cos(angle + .pi) * 0.125,
                offsetY: sin(angle + .pi) * 0.081
            )
            style.split -= 8
            style.gaze = .init(
                yaw: sin(angle) * 4,
                pitch: cos(angle) * 3,
                roll: isAnimated ? -5 : 0
            )
            decor = .init(
                kind: .orbit,
                strength: isAnimated ? transitionEnvelope(time) * 0.76 : 0.18,
                phase: phase
            )
        case .listening:
            let listen = isAnimated ? 0.5 + 0.5 * sin(phase * 2 * .pi) : 0.5
            scaleEyes(&style, width: 1 + listen * 0.04, height: 1 + listen * 0.075)
            style.left.offsetY -= isAnimated ? 0.019 : 0
            style.right.offsetY -= isAnimated ? 0.019 : 0
            addGaze(&style, yaw: 10, pitch: -1, roll: -5)
        case .thinking:
            let wave: (Double) -> Double = { delay in
                guard isAnimated else { return 1 }
                return 0.82 + 0.22 * max(0, sin((phase - delay) * 2 * .pi))
            }
            style.left = .init(
                width: 0.145 * wave(0),
                height: 0.145 * wave(0),
                offsetX: -0.081,
                offsetY: 0.029
            )
            style.right = .init(
                width: 0.145 * wave(0.36),
                height: 0.145 * wave(0.36),
                offsetX: 0.081,
                offsetY: 0.029
            )
            style.split -= 3
            style.gaze = .init(yaw: 0, pitch: 0, roll: 0)
            decor = .init(kind: .thinkingDot, strength: 1, phase: phase)
        case .speaking:
            let left = isAnimated ? 0.5 + 0.5 * sin(phase * 4 * .pi) : 0.5
            let right = isAnimated ? 0.5 + 0.5 * sin(phase * 4 * .pi + .pi * 0.72) : 0.5
            scaleEye(&style.left, width: 1 + left * 0.08, height: 0.88 + left * 0.22)
            scaleEye(&style.right, width: 1 + right * 0.08, height: 0.88 + right * 0.22)
            addGaze(
                &style,
                yaw: isAnimated ? sin(phase * 2 * .pi) * 3 : 0,
                pitch: 1,
                roll: isAnimated ? sin(phase * 2 * .pi) * 2 : 0
            )
        case .working:
            let sweep = isAnimated ? sin(phase * 2 * .pi) : 0
            addGaze(&style, yaw: sweep * 15, pitch: 5, roll: -sweep * 4)
            scaleEyes(&style, width: 1, height: 0.94)
            decor = .init(kind: .scan, strength: isAnimated ? 0.46 : 0.12, phase: phase)
        case .searching:
            let places = [-18.0, 16, -8, 21]
            let step = isAnimated ? Int(floor(phase * 4)) % 4 : 1
            let place = places[step]
            addGaze(
                &style,
                yaw: isAnimated ? place : 0,
                pitch: step == 2 ? 8 : -4,
                roll: isAnimated ? place * -0.22 : 0
            )
            scaleEyes(&style, width: 0.95, height: 1.03)
        case .waiting:
            let sway = isAnimated ? sin(phase * 2 * .pi) : 0
            addGaze(&style, yaw: sway * 7, pitch: 7, roll: sway * -2)
            scaleEyes(&style, width: 0.96, height: 0.92)
        case .done:
            let burst = isAnimated ? pulse(min(1, time / 1.3), center: 0.28, width: 0.28) : 0
            scaleEyes(&style, width: 1 + burst * 0.23, height: 1 + burst * 0.12)
            style.left.offsetX -= burst * 0.074
            style.left.offsetY -= burst * 0.059
            style.right.offsetX += burst * 0.074
            style.right.offsetY -= burst * 0.059
            addGaze(&style, yaw: 0, pitch: -burst * 10, roll: 0)
            decor = .init(kind: .burst, strength: burst, phase: phase)
        case .failed:
            let breathe = isAnimated ? sin(phase * 2 * .pi) * 0.03 : 0
            scaleEyes(&style, width: 1, height: 0.25 + breathe)
            style.left.offsetY += isAnimated ? 0.044 : 0
            style.right.offsetY += isAnimated ? 0.044 : 0
            addGaze(&style, yaw: 0, pitch: -13, roll: 0)
        }

        if let tracking, isAnimated {
            let trackingX = Double(max(-1, min(1, tracking.x)))
            let trackingY = Double(max(-1, min(1, tracking.y)))
            style.gaze = .init(
                yaw: trackingX * 31,
                pitch: trackingY * -24,
                roll: trackingX * -8
            )
        }

        return Pose(
            style: style,
            energy: energy(for: expression),
            decor: decor,
            blinkProfile: blinkProfile(for: expression)
        )
    }

    private static func activityDuration(_ activity: ShannonDialogueActivity) -> Double {
        switch activity {
        case .idle: 2.8
        case .preparing: 1.8
        case .connecting: 2.6
        case .listening: 2.4
        case .thinking: 2.6
        case .speaking: 2.2
        case .working: 2.5
        case .searching: 2.8
        case .waiting: 2.7
        case .done: 2.2
        case .failed: 2.5
        }
    }

    private static func energy(for expression: ShannonExpressionDTO) -> Double {
        switch expression {
        case .excited: 0.92
        case .laughing: 0.82
        case .surprised: 0.72
        case .amused: 0.66
        case .curious: 0.65
        case .joyful: 0.62
        case .determined: 0.58
        case .neutral: 0.56
        case .confused: 0.52
        case .jealous: 0.46
        case .thinking, .annoyed: 0.44
        case .bashful, .wry: 0.42
        case .embarrassed: 0.38
        case .tender, .concerned: 0.34
        case .relieved, .exasperated: 0.28
        case .sad: 0.24
        case .calm: 0.22
        case .sleepy: 0.14
        }
    }

    private static func blinkProfile(for expression: ShannonExpressionDTO) -> BlinkProfile {
        switch expression {
        case .neutral, .curious: .natural
        case .joyful: .bright
        case .excited, .surprised, .determined: .sparse
        case .relieved, .thinking, .tender, .calm, .sad: .slow
        case .laughing, .bashful, .embarrassed, .confused, .concerned: .double
        case .amused, .wry: .wink
        case .jealous, .exasperated, .annoyed: .sideEye
        case .sleepy: .drowsy
        }
    }

    private static func scaleEyes(_ style: inout ShannonEyeStyle, width: Double, height: Double) {
        scaleEye(&style.left, width: width, height: height)
        scaleEye(&style.right, width: width, height: height)
    }

    private static func scaleEye(_ eye: inout ShannonEyeStyle.Eye, width: Double, height: Double) {
        eye.width *= width
        eye.height *= height
    }

    private static func addGaze(
        _ style: inout ShannonEyeStyle,
        yaw: Double,
        pitch: Double,
        roll: Double
    ) {
        style.gaze.yaw += yaw
        style.gaze.pitch += pitch
        style.gaze.roll += roll
    }

    private static func smoothstep(_ value: Double) -> Double {
        let value = min(1, max(0, value))
        return value * value * (3 - 2 * value)
    }

    private static func pulse(_ value: Double, center: Double, width: Double) -> Double {
        let distance = abs(value - center) / width
        guard distance < 1 else { return 0 }
        return 1 - distance * distance * (3 - 2 * distance)
    }

    private static func transitionEnvelope(_ elapsedTime: Double) -> Double {
        smoothstep(elapsedTime / 0.24)
    }
}
