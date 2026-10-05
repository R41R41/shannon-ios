#if os(iOS)
import SwiftUI

/// The call screen's bottom control bar: 写真, 本人だけ／友人も一緒, マイク, 文字, 終了.
///
/// Every control keeps a visible label. When the labels no longer fit on one row
/// (large accessibility text), the controls wrap to two rows, then to a
/// two-column grid, and finally to a single column; labels never truncate.
struct ShannonGeminiLiveCallControls: View {
    enum Control: Hashable {
        case photo, participant, microphone, text, end
    }

    let isMuted: Bool
    let inputState: ShannonVoiceInputState
    let participantMode: ShannonVoiceParticipantMode
    let isPhotoBusy: Bool
    let showsTextComposer: Bool
    let palette: ShannonPalette
    let choosePhoto: () -> Void
    let chooseParticipant: () -> Void
    let toggleMute: () -> Void
    let selectInput: (ShannonVoiceInputPreference) -> Void
    let showInputPicker: () -> Void
    let toggleTextComposer: () -> Void
    let end: () -> Void

    @Environment(\.colorSchemeContrast) private var contrast
    @ScaledMetric(relativeTo: .body) private var controlDiameter: CGFloat = 54
    @ScaledMetric(relativeTo: .body) private var primaryDiameter: CGFloat = 68

    /// 写真 stays in place in 「友人も一緒」 so its absence is explained instead of silent.
    private let controls: [Control] = [.photo, .participant, .microphone, .text, .end]

    var body: some View {
        ViewThatFits(in: .horizontal) {
            row(controls, spacing: ShannonSpacing.small)
            rows(of: 3)
            rows(of: 2)
            VStack(spacing: ShannonSpacing.medium) {
                ForEach(controls, id: \.self) { control($0) }
            }
        }
        .frame(maxWidth: .infinity)
    }

    private func row(_ items: [Control], spacing: CGFloat) -> some View {
        // Labels share one baseline even though マイク has the larger circle.
        HStack(alignment: .lastTextBaseline, spacing: spacing) {
            ForEach(items, id: \.self) { item in
                control(item).frame(maxWidth: .infinity)
            }
        }
    }

    private func rows(of size: Int) -> some View {
        VStack(spacing: ShannonSpacing.medium) {
            ForEach(Array(stride(from: 0, to: controls.count, by: size)), id: \.self) { start in
                row(Array(controls[start..<min(start + size, controls.count)]), spacing: ShannonSpacing.medium)
            }
        }
    }

    @ViewBuilder
    private func control(_ control: Control) -> some View {
        switch control {
        case .photo:
            Button(action: choosePhoto) {
                label("写真", systemImage: participantMode.allowsCameraSharing ? "camera.fill" : "camera",
                      foreground: participantMode.allowsCameraSharing ? nil : palette.textSecondary)
            }
            .buttonStyle(.plain)
            .disabled(isPhotoBusy)
            .accessibilityLabel("写真をシャノンに見せる")
            .accessibilityValue(participantMode.allowsCameraSharing ? "" : "「友人も一緒」では使えません")
            .accessibilityHint(participantMode.allowsCameraSharing ? "" : "理由を表示します")
        case .participant:
            Button(action: chooseParticipant) {
                // The label is the current state, so both people can see who Shannon is talking with.
                label(
                    participantMode.japaneseName,
                    systemImage: participantMode == .owner ? "person.fill" : "person.2.fill",
                    fill: participantMode == .guest ? palette.action.opacity(0.18) : nil,
                    foreground: participantMode == .guest ? palette.action : palette.textPrimary
                )
            }
            .buttonStyle(.plain)
            .accessibilityLabel("会話の相手")
            .accessibilityValue(participantMode.japaneseName)
            .accessibilityHint(participantMode == .owner
                ? "友人も一緒に切り替えます。通話は続きます。" : "本人だけに戻します。通話は続きます。")
        case .microphone:
            microphone
        case .text:
            Button(action: toggleTextComposer) {
                label(
                    "文字",
                    systemImage: showsTextComposer ? "keyboard.chevron.compact.down" : "keyboard",
                    fill: showsTextComposer ? palette.action.opacity(0.18) : nil,
                    foreground: showsTextComposer ? palette.action : palette.textPrimary
                )
            }
            .buttonStyle(.plain)
            .accessibilityLabel("文字で話しかける")
            .accessibilityValue(showsTextComposer ? "入力欄を表示中" : "")
            .accessibilityAddTraits(showsTextComposer ? .isSelected : [])
        case .end:
            Button(role: .destructive, action: end) {
                label(ShannonGeneratedStrings.voiceEnd, systemImage: "phone.down.fill", fill: palette.danger, foreground: palette.onAction)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("音声会話を終了する")
        }
    }

    private var microphone: some View {
        let presentation = ShannonGeminiLiveMicrophoneControl(isMuted: isMuted)
        return Menu {
            ForEach(ShannonVoiceInputPreference.allCases) { preference in
                Button { selectInput(preference) } label: {
                    Label(preference.japaneseLabel, systemImage: preference.systemImage)
                }
                .disabled(!inputState.canSelect(preference))
            }
        } label: {
            label(
                presentation.title,
                systemImage: presentation.systemImage,
                diameter: primaryDiameter,
                fill: isMuted ? nil : palette.action,
                foreground: isMuted ? palette.textPrimary : palette.onAction
            )
        } primaryAction: {
            toggleMute()
        }
        .menuStyle(.button)
        .buttonStyle(.plain)
        .accessibilityLabel("マイク")
        .accessibilityValue(microphoneAccessibilityValue(presentation))
        .accessibilityHint(presentation.accessibilityHint)
        .accessibilityAction(named: "入力マイクを選ぶ", showInputPicker)
    }

    private func microphoneAccessibilityValue(_ presentation: ShannonGeminiLiveMicrophoneControl) -> String {
        guard inputState.activeInputName != nil else { return presentation.accessibilityValue }
        return "\(presentation.accessibilityValue)、\(inputState.activeInputLabel)"
    }

    private func label(
        _ title: String,
        systemImage: String,
        diameter: CGFloat? = nil,
        fill: Color? = nil,
        foreground: Color? = nil
    ) -> some View {
        // Capped so large text keeps room for the eye and status; マイク stays larger.
        let size = min(max(diameter ?? controlDiameter, ShannonTouchTarget.minimum), diameter == nil ? 80 : 96)
        let neutral = fill == nil
        return VStack(spacing: ShannonSpacing.extraSmall) {
            Image(systemName: systemImage)
                .font(.title3.weight(.semibold))
                .foregroundStyle(foreground ?? palette.textPrimary)
                .frame(width: size, height: size)
                .background(fill ?? palette.textPrimary.opacity(0.08), in: Circle())
                .overlay {
                    if neutral || contrast == .increased {
                        Circle().strokeBorder(contrast == .increased ? palette.borderStrong : palette.divider)
                    }
                }
            Text(title)
                .font(.footnote.weight(.medium))
                .foregroundStyle(palette.textPrimary)
                .lineLimit(1)
                .fixedSize()
        }
        .frame(minWidth: ShannonTouchTarget.minimum)
        .contentShape(Rectangle())
    }
}
#endif
