import SwiftUI

struct ShannonVoiceGlowLayer: View {
    let model: ShannonRealtimeVoiceSessionModel
    let usesCompactHeight: Bool

    var body: some View {
        ShannonVoiceGlowView(
            phase: model.phase,
            microphoneLevel: model.microphoneLevel,
            playbackLevel: model.playbackLevel,
            isMuted: model.isMuted
        )
        .frame(maxWidth: .infinity)
        .frame(height: usesCompactHeight ? 170 : 220)
        .frame(maxHeight: .infinity, alignment: .bottom)
        .ignoresSafeArea(edges: .bottom)
    }
}
