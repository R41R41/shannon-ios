import SwiftUI

public struct ShannonPersonaPresetPicker: View {
    @AppStorage(ShannonPersonaPreset.storageKey) private var preset = ShannonPersonaPreset.initialRawValue
    let activeProvider: ShannonSpeechProvider?
    public init(activeProvider: ShannonSpeechProvider? = nil) { self.activeProvider = activeProvider }
    public var body: some View {
        VStack(alignment: .leading, spacing: ShannonSpacing.small) {
            Text("シャノンのモード").font(.shannon(.subheadline).weight(.medium))
            HStack {
                ForEach(ShannonPersonaPreset.allCases) { mode in
                    Button { preset = mode.rawValue } label: {
                        Label(mode.title, systemImage: preset == mode.rawValue ? "checkmark.circle.fill" : "circle")
                            .frame(maxWidth: .infinity, minHeight: 44)
                    }.buttonStyle(.bordered).accessibilityIdentifier("persona-preset-\(mode.rawValue)")
                        .accessibilityValue(preset == mode.rawValue ? "選択中" : "")
                }
            }
            if let selected = ShannonPersonaPreset(rawValue: preset) {
                Text(selected.explanation).font(.shannon(.footnote)).foregroundStyle(.secondary)
            } else { Text("現在の個別設定を保っています。モードを選ぶと、姿・アイコン・声が一緒に切り替わります。")
                    .font(.shannon(.footnote)).foregroundStyle(.secondary) }
            if let activeProvider {
                Text("通話中：\(activeProvider.japaneseName) ／ 次の通話：\(ShannonSpeechProvider.current().japaneseName)")
                    .font(.shannon(.footnote)).foregroundStyle(.secondary)
            }
            Text("通話中の声は続きます。声の変更は次の通話から反映されます。")
                .font(.shannon(.caption)).foregroundStyle(.secondary)
        }.accessibilityElement(children: .contain)
    }
}

extension ShannonPersonaPreset {
    @MainActor public static func formSelection(_ legacy: Binding<String>) -> Binding<String> {
        Binding(get: { current()?.form.rawValue ?? legacy.wrappedValue }, set: { selectIndividual(key: ShannonForm.storageKey, value: $0); legacy.wrappedValue = $0 })
    }
    @MainActor public static func bodySelection(_ legacy: Binding<String>) -> Binding<String> {
        Binding(get: { current()?.live2DBody.rawValue ?? legacy.wrappedValue }, set: { selectIndividual(key: ShannonLive2DBody.storageKey, value: $0); legacy.wrappedValue = $0 })
    }
    @MainActor public static func voiceSelection(_ legacy: Binding<String>) -> Binding<String> {
        Binding(get: { current()?.speechProvider.rawValue ?? legacy.wrappedValue }, set: { selectIndividual(key: ShannonSpeechProvider.storageKey, value: $0); legacy.wrappedValue = $0 })
    }
    @MainActor public static func avatarSelection(_ legacy: Binding<String>) -> Binding<String> {
        Binding(get: { current()?.avatarStyle.rawValue ?? legacy.wrappedValue }, set: { selectIndividual(key: ShannonChatAvatarStyle.storageKey, value: $0); legacy.wrappedValue = $0 })
    }
}
