import SwiftUI

/// The two switches every app shows always, in the same look (feature `voice.speak-listen-pills`, 2026-10-26):
/// 「声: 出す／出さない」 her words said aloud outside a call, and 「耳: 聞く／聞かない」 whether she opens the microphone
/// on her own (for his answer after she speaks; on Windows also to wait for her name). A call he starts himself is his
/// and stays a voice call either way. Both are on by default, so nothing changes until he switches one off.
public enum ShannonVoiceEar {
    public static let speaksKey = "shannon.voice.out"
    public static let listensKey = "shannon.voice.ear"

    public static func speaks(_ defaults: UserDefaults = .standard) -> Bool { defaults.object(forKey: speaksKey) as? Bool ?? true }
    public static func listens(_ defaults: UserDefaults = .standard) -> Bool { defaults.object(forKey: listensKey) as? Bool ?? true }
}

/// 「声」 and 「耳」 side by side, as on the Windows body's feet: off is the pale word with a slashed mark, on the darker
/// word with a clear border. These are neither a success nor a warning, so no role colour is used. A press switches at once.
public struct ShannonVoiceEarPills: View {
    @AppStorage(ShannonVoiceEar.speaksKey) private var speaks = true
    @AppStorage(ShannonVoiceEar.listensKey) private var listens = true

    public init() {}

    public var body: some View {
        HStack(spacing: ShannonSpacing.small) {
            ShannonVoiceEarPill(
                isOn: speaks, title: speaks ? ShannonGeneratedStrings.voiceOutOn : ShannonGeneratedStrings.voiceOutOff,
                symbol: speaks ? "speaker.wave.2.fill" : "speaker.slash.fill", slashed: false,
                hint: speaks ? ShannonGeneratedStrings.voiceOutHintOn : ShannonGeneratedStrings.voiceOutHintOff
            ) { speaks.toggle() }
            .accessibilityIdentifier("voice-out-pill")
            ShannonVoiceEarPill(
                isOn: listens, title: listens ? ShannonGeneratedStrings.voiceEarOn : ShannonGeneratedStrings.voiceEarOff,
                symbol: "ear", slashed: !listens,
                hint: listens ? ShannonGeneratedStrings.voiceEarHintOn : ShannonGeneratedStrings.voiceEarHintOff
            ) { listens.toggle() }
            .accessibilityIdentifier("voice-ear-pill")
        }
    }
}

private struct ShannonVoiceEarPill: View {
    let isOn: Bool
    let title: String
    let symbol: String
    /// The ear has no slashed symbol of its own: the slash is drawn over it, as on Windows.
    let slashed: Bool
    let hint: String
    let action: () -> Void

    @Environment(\.colorScheme) private var colorScheme

#if os(iOS)
    /// A finger's reach on the iPhone; the pointer on the Mac needs only the pill.
    private static let minimumHeight = ShannonTouchTarget.minimum
#else
    private static let minimumHeight: CGFloat = 0
#endif

    var body: some View {
        let palette = ShannonPalette.resolve(colorScheme)
        Button(action: action) {
            HStack(spacing: 5) {
                Image(systemName: symbol)
                    .font(.shannon(.caption))
                    .overlay {
                        if slashed {
                            Capsule().frame(width: 1.6).rotationEffect(.degrees(-45))
                        }
                    }
                Text(title)
                    .font(.shannon(.caption).weight(.semibold))
                    .lineLimit(1)
            }
            .foregroundStyle(isOn ? palette.textPrimary : palette.textSecondary)
            .padding(.horizontal, 9)
            .padding(.vertical, ShannonSpacing.extraSmall)
            .background(Capsule().fill(palette.elevatedSurface))
            .overlay(Capsule().strokeBorder(isOn ? palette.borderStrong : palette.divider, lineWidth: 1.5))
            .fixedSize()
            .frame(minHeight: Self.minimumHeight)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
#if os(macOS)
        .help(hint)
#endif
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(title)
        .accessibilityHint(hint)
        .accessibilityAddTraits(.isButton)
    }
}
