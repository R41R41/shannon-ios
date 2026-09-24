import SwiftUI

struct ShannonVoiceGlowLayer: View {
    let phase: ShannonVoiceGlowPhase
    let microphoneLevel: Double
    let playbackLevel: Double
    let isMuted: Bool
    let usesCompactHeight: Bool

    var body: some View {
        ShannonVoiceGlowView(
            phase: phase,
            microphoneLevel: microphoneLevel,
            playbackLevel: playbackLevel,
            isMuted: isMuted
        )
        .frame(maxWidth: .infinity)
        .frame(height: usesCompactHeight ? 170 : 220)
        .frame(maxHeight: .infinity, alignment: .bottom)
        .ignoresSafeArea(edges: .bottom)
    }
}
