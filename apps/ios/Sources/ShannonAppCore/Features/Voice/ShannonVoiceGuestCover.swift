import SwiftUI

/// Coordinator decision 2026-10-06: while a call is in 「友人も一緒」 the owner's Talk is not on screen. Wherever
/// it would be (the Mac's Talk beside the call bar, its sidebar list and outline; the iPhone's screens under the
/// call pill) this neutral panel stands in, and the call itself stays reachable.
public struct ShannonVoiceGuestCover: View {
    @Environment(\.colorScheme) private var colorScheme

    public init() {}

    public var body: some View {
        let palette = ShannonPalette.resolve(colorScheme)
        VStack(spacing: ShannonSpacing.small) {
            Image(systemName: "person.2.fill")
                .font(.shannon(.title2))
                .foregroundStyle(palette.textSecondary)
                .accessibilityHidden(true)
            Text(ShannonGeneratedStrings.voiceGuestHidesTalk)
                .font(.shannon(.callout))
                .foregroundStyle(palette.textSecondary)
                .multilineTextAlignment(.center)
        }
        .padding(ShannonSpacing.large)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(palette.canvas)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("voice-guest-cover")
    }
}

extension ShannonGeminiLiveSessionModel {
    /// A call in 「友人も一緒」 is on (also failed or reconnecting): the owner's Talk and its traces are covered.
    public var hidesOwnerScreens: Bool { phase != .idle && participantMode == .guest }
}
