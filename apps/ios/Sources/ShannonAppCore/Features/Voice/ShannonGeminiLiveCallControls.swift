#if os(iOS)
import SwiftUI

/// The call screen's bottom control bar: 写真, 人物, マイク, 文字, 終了.
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

    private var controls: [Control] {
        participantMode.allowsCameraSharing
            ? [.photo, .participant, .microphone, .text, .end]
            : [.participant, .microphone, .text, .end]
    }

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
        HStack(alignment: .top, spacing: spacing) {
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
                label("写真", systemImage: "camera.fill")
            }
            .buttonStyle(.plain)
            .disabled(isPhotoBusy)
            .accessibilityLabel("写真をシャノンに見せる")
        case .participant:
            Button(action: chooseParticipant) {
                label("人物", systemImage: participantMode == .owner ? "person.fill" : "person.2.fill")
            }
            .buttonStyle(.plain)
            .accessibilityLabel("音声の参加者")
            .accessibilityValue(participantMode.japaneseName)
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
                label("終了", systemImage: "phone.down.fill", fill: palette.danger, foreground: palette.onAction)
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
        let size = min(max(diameter ?? controlDiameter, ShannonTouchTarget.minimum), 104)
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
