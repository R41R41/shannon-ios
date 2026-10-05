import SwiftUI

struct ShannonVoiceInputMenu: View {
    @Bindable var model: ShannonRealtimeVoiceSessionModel

    var body: some View {
        Menu {
            ForEach(ShannonVoiceInputPreference.allCases) { preference in
                Button {
                    model.selectInput(preference)
                } label: {
                    Label(preference.japaneseLabel, systemImage: preference.systemImage)
                }
                .disabled(!model.inputState.canSelect(preference))
            }
        } label: {
            Image(systemName: "mic.badge.plus")
                .font(.shannon(.body).weight(.semibold))
                .frame(width: ShannonTouchTarget.minimum, height: ShannonTouchTarget.minimum)
        }
        .buttonStyle(.bordered)
        .accessibilityLabel("入力マイク、\(model.inputState.preference.japaneseLabel)")
        .accessibilityHint("自動、iPhone、または接続中の外部マイクから選びます")
    }
}
