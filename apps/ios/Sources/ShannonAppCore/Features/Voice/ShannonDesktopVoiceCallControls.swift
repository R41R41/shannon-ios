#if os(macOS)
import SwiftUI

/// The call's controls, labelled and always visible as on the iPhone: マイク (mute), 入力マイク (the Mac's
/// microphones by name), 写真, 本人だけ／友人も一緒, and 終了. Keyboard and VoiceOver reach each one.
struct ShannonDesktopVoiceCallControls: View {
    let call: ShannonDesktopVoiceCall
    let choosePhoto: (ShannonDesktopVoicePhotoSource) -> Void
    let chooseParticipant: () -> Void

    private var session: ShannonGeminiLiveSessionModel { call.session }

    var body: some View {
        let mute = ShannonGeminiLiveMicrophoneControl(isMuted: session.isMicrophoneMuted)
        let live = call.holdsMicrophone
        HStack(spacing: ShannonDesktopSpacing.small) {
            Button(action: session.toggleMicrophoneMute) {
                Label(mute.title, systemImage: mute.systemImage)
            }
            .disabled(!live)
            .help(session.isMicrophoneMuted ? ShannonGeneratedStrings.voiceMacUnmuteHint : ShannonGeneratedStrings.voiceMacMuteHint)
            .accessibilityValue(mute.accessibilityValue)
            .accessibilityIdentifier("voice-call-mute")

            inputMenu
                .disabled(!live)

            photoControl
                .disabled(!live || call.workspace.isSharingCameraSnapshot || call.workspace.isLoadingLibraryPhoto)

            Button(action: chooseParticipant) {
                Label(session.participantMode.japaneseName,
                      systemImage: session.participantMode == .guest ? "person.2.fill" : "person.fill")
            }
            .disabled(!live)
            .help(ShannonGeneratedStrings.voiceMacParticipantHint)
            .accessibilityIdentifier("voice-call-participant")

            Spacer(minLength: ShannonDesktopSpacing.small)

            Button(role: .destructive, action: call.end) {
                Label(ShannonGeneratedStrings.voiceEnd, systemImage: "phone.down.fill")
            }
            .buttonStyle(.borderedProminent)
            .tint(Color.shannonDanger)
            .accessibilityLabel(ShannonGeneratedStrings.voiceMacEndLabel)
            .accessibilityIdentifier("voice-call-end")
        }
        .controlSize(.regular)
        .labelStyle(.titleAndIcon)
        .fixedSize(horizontal: false, vertical: true)
    }

    private var inputMenu: some View {
        let state = session.inputState
        return Menu {
            Picker(ShannonGeneratedStrings.voiceMacInput, selection: Binding(
                get: { state.selectedDeviceID ?? "" },
                set: { session.selectInputDevice($0.isEmpty ? nil : $0) }
            )) {
                Text(ShannonGeneratedStrings.voiceMacInputAutomatic).tag("")
                ForEach(state.devices) { device in
                    Text(device.name).tag(device.id)
                }
            }
            .pickerStyle(.inline)
            if state.activeInputName != nil {
                Divider()
                Text(state.activeInputLabel)
            }
        } label: {
            Label(ShannonGeneratedStrings.voiceMacInput, systemImage: "mic.badge.plus")
        }
        .fixedSize()
        .onAppear { session.refreshInputDevices() }
        .help(state.activeInputLabel)
        .accessibilityValue(state.activeInputLabel)
        .accessibilityIdentifier("voice-call-input")
    }

    @ViewBuilder
    private var photoControl: some View {
        if call.canSharePhoto {
            Menu {
                Button(ShannonGeneratedStrings.voiceMacPhotoCamera, systemImage: "camera") { choosePhoto(.camera) }
                Button(ShannonGeneratedStrings.voiceMacPhotoLibrary, systemImage: "photo.on.rectangle") { choosePhoto(.library) }
                Button(ShannonGeneratedStrings.voiceMacPhotoFile, systemImage: "folder") { choosePhoto(.file) }
            } label: {
                Label(ShannonGeneratedStrings.voiceMacPhoto, systemImage: "photo")
            }
            .fixedSize()
            .accessibilityIdentifier("voice-call-photo")
        } else {
            // 「友人も一緒」: the control stays where it is and says why a photo cannot be shared.
            Button { choosePhoto(.library) } label: {
                Label(ShannonGeneratedStrings.voiceMacPhoto, systemImage: "photo")
            }
            .accessibilityIdentifier("voice-call-photo")
        }
    }
}
#endif
