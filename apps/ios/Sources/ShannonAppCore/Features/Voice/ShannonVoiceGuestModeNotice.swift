import SwiftUI

/// What 「友人も一緒」 keeps and does not keep, in words both people at the table can read.
enum ShannonVoiceGuestModeCopy {
    static let name = ShannonVoiceParticipantMode.guest.japaneseName
    static let lines = [
        "この通話の中の会話だけを覚えています。本人の記憶・予定・ノートは使いません。",
        "会話は保存しません。終了時に本人が選んだ時だけ、短い要約が残ります。",
        "声は文字にするため外部のサービスへ送られます。録音は残しません。",
    ]
    static let switchToGuestTitle = "友人も一緒にしますか？"
    static let switchToGuestMessage = "通話はそのまま続きます。切り替えた後は、この通話の中の会話だけを覚え、本人の記憶・予定・ノートは使いません。会話は保存しません。"
    static let switchToOwnerTitle = "本人だけに戻しますか？"
    static let switchToOwnerMessage = "通話はそのまま続きます。「友人も一緒」の間の会話は引き継がれません。ここからの会話はトークに保存されます。"
    static let photoUnavailableTitle = "「友人も一緒」では写真を共有できません"
    static let photoUnavailableMessage = "写真の説明に本人のトークの内容を使うためです。「本人だけ」に戻すと共有できます。"
}

/// Shown for the whole 「友人も一緒」 period, not only at the moment of switching.
struct ShannonVoiceGuestModeNotice: View {
    let palette: ShannonPalette

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Label(ShannonVoiceGuestModeCopy.name, systemImage: "person.2.fill")
                .font(.callout.weight(.semibold))
                .foregroundStyle(palette.textPrimary)
                .labelStyle(.titleAndIcon)
            ForEach(ShannonVoiceGuestModeCopy.lines, id: \.self) { line in
                Text(line)
                    .font(.footnote)
                    .foregroundStyle(palette.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(ShannonSpacing.medium)
        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: ShannonShape.large, style: .continuous))
        .accessibilityElement(children: .combine)
    }
}
