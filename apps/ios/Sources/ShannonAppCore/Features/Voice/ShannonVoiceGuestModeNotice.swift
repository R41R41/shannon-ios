import SwiftUI

/// What 「友人も一緒」 keeps and does not keep, in words both people at the table can read.
enum ShannonVoiceGuestModeCopy {
    static let name = ShannonVoiceParticipantMode.guest.japaneseName
    static let lines = [
        "お名前と、この通話で話したことをシャノンが覚えます。声で人を聞き分けることはしません。",
        "本人の個人的なことは、シャノンが話す前に確かめ、この場の人が知らないことは話さないようにします。内緒と言われたことは使いません。",
        "声は文字にするため外部のサービスへ送られます。録音は残しません。通話の後で「今回は残さない」を選ぶと、この通話の記録は消えます。",
    ]
    static let switchToGuestTitle = "友人も一緒にしますか？"
    static let switchToGuestMessage = "通話はそのまま続きます。切り替えた後は、お友達のお名前とこの通話で話したことをシャノンが覚えます。本人の個人的なことは、シャノンが話す前に確かめます。内緒と言われたことは使いません。通話の後で「今回は残さない」を選べます。"
    static let switchToOwnerTitle = "本人だけに戻しますか？"
    static let switchToOwnerMessage = "通話はそのまま続きます。「友人も一緒」の間に聞いたお名前と会話は、ここまでの分を覚えます。ここからの会話はトークに保存され、本人の個人的なことも確かめずに話します。"
    static let photoUnavailableTitle = "「友人も一緒」では写真を共有できません"
    static let photoUnavailableMessage = "写真の説明に本人のトークの内容を使うためです。「本人だけ」に戻すと共有できます。"
}

/// Shown for the whole 「友人も一緒」 period, not only at the moment of switching.
struct ShannonVoiceGuestModeNotice: View {
    let palette: ShannonPalette

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Label(ShannonVoiceGuestModeCopy.name, systemImage: "person.2.fill")
                .font(.shannon(.callout).weight(.semibold))
                .foregroundStyle(palette.textPrimary)
                .labelStyle(.titleAndIcon)
            ForEach(ShannonVoiceGuestModeCopy.lines, id: \.self) { line in
                Text(line)
                    .font(.shannon(.footnote))
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
