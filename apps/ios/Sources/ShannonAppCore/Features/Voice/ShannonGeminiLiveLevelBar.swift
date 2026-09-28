#if os(iOS)
import SwiftUI

struct ShannonGeminiLiveLevelBar: View {
    let level: Float
    let phase: ShannonGeminiLivePhase
    let palette: ShannonPalette
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        HStack(spacing: 3) {
            ForEach(0..<5) { index in
                Capsule()
                    .fill(palette.brandPresence.opacity(phase == .listening ? 0.85 : 0.35))
                    .frame(width: 3, height: barHeight(index))
            }
        }
        .frame(width: 28, height: 18)
        .animation(reduceMotion ? nil : .easeOut(duration: 0.18), value: level)
        .accessibilityHidden(true)
    }

    private func barHeight(_ index: Int) -> CGFloat {
        guard !reduceMotion, phase == .listening else { return 5 }
        let shape = [0.45, 0.75, 1.0, 0.75, 0.45][index]
        return 5 + CGFloat(min(1, max(0, level))) * 13 * shape
    }
}
#endif
