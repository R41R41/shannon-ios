import SwiftUI

/// How much the ambient background moves for a call phase. Pure and testable.
enum ShannonVoiceAmbientMotion {
    /// 0 keeps the mesh still; 1 is the liveliest it gets. Speaking is only slightly
    /// livelier than listening so the surface never competes with the Eye.
    static func intensity(for phase: ShannonGeminiLivePhase) -> Double {
        switch phase {
        case .speaking: 1
        case .listening, .thinking: 0.6
        case .requestingPermission, .connecting, .reconnecting: 0.35
        case .idle, .failed: 0
        }
    }

    /// The moving center and edge offset of the 3×3 mesh at `time`, bounded so
    /// the mesh never folds over itself.
    static func drift(time: Double, intensity: Double) -> (x: Float, y: Float, edge: Float) {
        let amount = min(1, max(0, intensity))
        let x = 0.5 + 0.16 * amount * sin(time * 0.31)
        let y = 0.5 + 0.13 * amount * sin(time * 0.23 + 1.3)
        let edge = 0.07 * amount * sin(time * 0.27 + 0.6)
        return (Float(x), Float(y), Float(edge))
    }
}

#if os(iOS)
/// The call screen background: Shannon's sky, presence and depth tints drifting slowly
/// behind the Waterlight Eye. Reduce Motion and iOS 17 keep the still gradient.
struct ShannonVoiceAmbientBackground: View {
    let phase: ShannonGeminiLivePhase
    let palette: ShannonPalette
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        ZStack {
            LinearGradient(
                colors: [palette.canvas, palette.intelligenceSoft.opacity(0.78), palette.canvas],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            )
            if #available(iOS 18.0, *), !reduceMotion {
                ShannonVoiceAmbientMesh(
                    intensity: ShannonVoiceAmbientMotion.intensity(for: phase),
                    palette: palette
                )
                .animation(.easeInOut(duration: 1.4), value: phase)
                .transition(.opacity)
            }
        }
        .accessibilityHidden(true)
    }
}

@available(iOS 18.0, *)
private struct ShannonVoiceAmbientMesh: View, @MainActor Animatable {
    var intensity: Double
    let palette: ShannonPalette

    var animatableData: Double {
        get { intensity }
        set { intensity = newValue }
    }

    var body: some View {
        // A still mesh needs no timeline; the phase change itself is eased by `animatableData`.
        TimelineView(.animation(minimumInterval: 1.0 / 24.0, paused: intensity <= 0.001)) { timeline in
            let drift = ShannonVoiceAmbientMotion.drift(
                time: timeline.date.timeIntervalSinceReferenceDate, intensity: intensity)
            MeshGradient(
                width: 3,
                height: 3,
                points: [
                    [0, 0], [0.5 + drift.edge, 0], [1, 0],
                    [0, 0.5 - drift.edge], [drift.x, drift.y], [1, 0.5 + drift.edge],
                    [0, 1], [0.5 - drift.edge, 1], [1, 1],
                ],
                colors: [
                    palette.canvas, palette.intelligenceSoft.opacity(0.55), palette.canvas,
                    palette.intelligenceSky.opacity(0.22), palette.intelligenceSoft.opacity(0.95),
                    palette.brandPresence.opacity(0.14),
                    palette.canvas, palette.intelligenceSoft.opacity(0.65), palette.canvas,
                ],
                background: palette.canvas
            )
        }
    }
}
#endif
