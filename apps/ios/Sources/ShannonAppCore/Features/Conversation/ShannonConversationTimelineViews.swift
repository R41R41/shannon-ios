import SwiftUI
#if canImport(UIKit)
import UIKit
#elseif canImport(AppKit)
import AppKit
#endif

struct ShannonEmptyConversation: View {
    @State private var waterlightReaction = 0
    @AppStorage(ShannonPersonaPreset.storageKey) private var presetRawValue = ShannonPersonaPreset.initialRawValue
    @AppStorage(ShannonForm.storageKey) private var formRawValue = ShannonForm.waterlight.rawValue
    @Environment(ShannonBodyModel.self) private var bodyModel: ShannonBodyModel?
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        let palette = ShannonPalette.resolve(colorScheme)
        VStack(spacing: ShannonSpacing.medium) {
            hero
            VStack(spacing: ShannonSpacing.extraSmall) {
                Text("おかえり")
                    .font(.shannon(.title3).weight(.semibold))
                    .foregroundStyle(palette.textPrimary)
                Text("今日はどこから始める？")
                    .font(.shannon(.subheadline))
                    .foregroundStyle(palette.textSecondary)
            }
            .multilineTextAlignment(.center)
            .accessibilityElement(children: .combine)
        }
        .frame(maxWidth: .infinity)
        .padding(.horizontal, ShannonSpacing.extraLarge)
        .containerRelativeFrame(.vertical, alignment: .center) { length, _ in
            length * 0.8
        }
    }

    @ViewBuilder
    private var hero: some View {
#if os(iOS)
        if ShannonConversationFeatureFlags.waterlightHero {
            // In the Live2D form the small figure is the way to the dialogue display, where she can be touched.
            let opensDialogue = ShannonPersonaPreset.form(legacy: formRawValue, preset: presetRawValue) == .live2d && bodyModel != nil
            Button {
                if opensDialogue { bodyModel?.requestDialogue() } else { waterlightReaction &+= 1 }
            } label: {
                ShannonBodyView(
                    expression: .curious,
                    size: 96,
                    reactionTrigger: waterlightReaction,
                    allowsTouch: false,
                    showsLine: false,
                    priority: .hero
                )
            }
            .buttonStyle(.plain)
            .accessibilityLabel("シャノン")
            .accessibilityHint(opensDialogue ? ShannonBodyCopy.heroHint : "触れると表情が変わります")
        } else {
            ShannonAvatarView(expression: .curious, size: 96)
                .accessibilityLabel("シャノン")
        }
#else
        ShannonAvatarView(expression: .curious, size: 96)
            .accessibilityLabel("シャノン")
#endif
    }
}

private enum ShannonConversationFeatureFlags {
    static let waterlightHero = true
}

struct ShannonConversationDayDivider: View {
    let day: Date
    @Environment(\.colorScheme) var colorScheme

    var body: some View {
        let palette = ShannonPalette.resolve(colorScheme)
        HStack(spacing: ShannonSpacing.medium) {
            Rectangle().fill(palette.divider.opacity(0.52)).frame(height: 0.5)
            Text(label)
                .font(.shannon(.caption2).weight(.medium))
                .foregroundStyle(palette.textSecondary)
                .fixedSize()
            Rectangle().fill(palette.divider.opacity(0.52)).frame(height: 0.5)
        }
        .padding(.vertical, ShannonSpacing.small)
        .accessibilityLabel(label)
    }

    var label: String {
        let calendar = Calendar.current
        if calendar.isDateInToday(day) { return "今日" }
        if calendar.isDateInYesterday(day) { return "昨日" }
        return day.formatted(.dateTime.year().month(.abbreviated).day().weekday(.abbreviated))
    }
}

struct ShannonMessageRow: View {
    let message: ConversationMessage
    let isSendingToAether: Bool
    let wasSentToAether: Bool
    let sendToAether: () -> Void
    /// Rich chat: the quick reactions at the top of the long-press menu.
    var reactionMenu: ShannonReactionMenuItems? = nil

    @Environment(\.colorScheme) var colorScheme
    @State var didCopy = false

    var body: some View {
        let palette = ShannonPalette.resolve(colorScheme)

        Group {
            if message.role == .shannon {
                shannonReply(palette)
            } else {
                userMessage(palette)
            }
        }
        .accessibilityElement(children: containsInteractiveContent ? .contain : .combine)
        .accessibilityLabel(accessibilityLabel)
        .sensoryFeedback(.success, trigger: didCopy)
        .contextMenu {
            if let reactionMenu { reactionMenu }
            Button(action: copyMessage) {
                Label("コピー", systemImage: "doc.on.doc")
            }
            if message.role == .shannon {
                Button(action: sendToAether) {
                    Label(
                        wasSentToAether ? "Aetherへ送信済み" : isSendingToAether ? "送信中…" : "Aetherへ提案として送る",
                        systemImage: wasSentToAether ? "checkmark.circle" : "square.and.arrow.up"
                    )
                }
                .disabled(isSendingToAether || wasSentToAether)
            }
        }
    }

    /// Her face as this reply felt, a small round face to the left of the reply (Syzygy ADR-0013 D17, owner choice A).
    static let avatarSize: CGFloat = 36

    func shannonReply(_ palette: ShannonPalette) -> some View {
        HStack(alignment: .top, spacing: ShannonSpacing.small) {
            ShannonMessageAvatarView(emotion: message.emotionSnapshot, size: Self.avatarSize)
            shannonReplyContent(palette)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    func shannonReplyContent(_ palette: ShannonPalette) -> some View {
        VStack(alignment: .leading, spacing: ShannonSpacing.extraSmall) {
            HStack(alignment: .center, spacing: ShannonSpacing.extraSmall) {
                Text("シャノン")
                    .font(.shannon(.callout).weight(.semibold))
                    .foregroundStyle(palette.textPrimary)

                // A reply with a presentation id shows its face without a name (option A); an older one keeps its name.
                if let face = message.emotionSnapshot?.face, message.emotionSnapshot?.presentationId == nil {
                    Text("· \(face.japaneseName)")
                }
                Text("· \(message.sentAt.formatted(date: .omitted, time: .shortened))")
                    .lineLimit(1)

                Spacer(minLength: 0)

                Button(action: copyMessage) {
                    Image(systemName: didCopy ? "checkmark" : "doc.on.doc")
                        .font(.shannon(.caption).weight(.semibold))
                        .frame(width: 34, height: 34)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .foregroundStyle(palette.textSecondary)
                .accessibilityLabel(didCopy ? "コピーしました" : "シャノンの回答をコピー")
            }
            .font(.shannon(.caption2))
            .foregroundStyle(palette.textSecondary)

            if ShannonVoiceCallSummaryNote.isNote(message.text) {
                // A record of a 「友人も一緒」 call the owner chose to keep, not something Shannon said in Talk.
                Label(ShannonVoiceCallSummaryNote.label, systemImage: "person.2.fill")
                    .font(.shannon(.caption).weight(.semibold))
                    .foregroundStyle(palette.textSecondary)
                    .padding(.horizontal, ShannonSpacing.small)
                    .padding(.vertical, 4)
                    .background(palette.subtleSurface, in: Capsule())
                    .accessibilityLabel("友人も一緒の通話の要約。会話そのものではなく、残すと選んだ記録です。")
            }

            ShannonRichMarkdownText(source: ShannonVoiceCallSummaryNote.body(of: message.text), palette: palette)
                .textSelection(.enabled)
                .tint(palette.action)
                .frame(maxWidth: .infinity, alignment: .leading)

            if !message.places.isEmpty {
                ShannonPlaceMapCard(places: message.places)
            }

            ForEach(Array(message.artifacts.enumerated()), id: \.offset) { _, artifact in
                ShannonGeneratedArtifactCard(artifact: artifact, palette: palette)
            }

            if let studyPiece = message.studyPiece {
                ShannonStudyPieceLinkCard(link: studyPiece)
            }

            if let attribution = message.sourceAttribution,
               let sourceURL = safeSourceURL(attribution.url) {
                Link(destination: sourceURL) {
                    HStack(alignment: .top, spacing: ShannonSpacing.small) {
                        Image(systemName: "link")
                            .font(.shannon(.caption).weight(.semibold))
                            .foregroundStyle(palette.action)
                            .frame(width: 22, height: 22)
                        VStack(alignment: .leading, spacing: 3) {
                            Text("出典 · \(attribution.title)")
                                .font(.shannon(.caption).weight(.semibold))
                                .foregroundStyle(palette.textPrimary)
                            Text("選んだ理由: \(attribution.reason)")
                                .font(.shannon(.caption2))
                                .foregroundStyle(palette.textSecondary)
                        }
                        Spacer(minLength: 0)
                        Image(systemName: "arrow.up.right")
                            .font(.shannon(.caption2).weight(.semibold))
                            .foregroundStyle(palette.textSecondary)
                    }
                    .padding(.horizontal, ShannonSpacing.medium)
                    .padding(.vertical, ShannonSpacing.small)
                    .background(
                        palette.subtleSurface,
                        in: RoundedRectangle(cornerRadius: ShannonShape.medium, style: .continuous)
                    )
                }
                .buttonStyle(.plain)
                .accessibilityLabel("出典 \(attribution.title)。選んだ理由 \(attribution.reason)")
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    func safeSourceURL(_ raw: String) -> URL? {
        guard let url = URL(string: raw), url.scheme == "https" || url.scheme == "http" else { return nil }
        return url
    }

    func userMessage(_ palette: ShannonPalette) -> some View {
        HStack(alignment: .bottom, spacing: ShannonSpacing.small) {
            Spacer(minLength: 64)

            VStack(alignment: .trailing, spacing: 5) {
                Text(ShannonMessageMarkdown.render(message.text))
                    .font(.shannon(.body))
                    .lineSpacing(3)
                    .textSelection(.enabled)
                    .foregroundStyle(palette.onUserMessage)
                    .tint(palette.action)
                    .padding(.horizontal, ShannonSpacing.large)
                    .padding(.vertical, ShannonSpacing.small + 2)
                    .background(
                        palette.userMessage,
                        in: RoundedRectangle(cornerRadius: ShannonShape.large, style: .continuous)
                    )

                HStack(spacing: 5) {
                    Text(message.sentAt.formatted(date: .omitted, time: .shortened))
                    deliveryIcon(palette)
                }
                .font(.shannon(.caption2))
                .foregroundStyle(message.deliveryState == .failed ? palette.danger : palette.textSecondary)
                .padding(.horizontal, ShannonSpacing.extraSmall)
            }
        }
        .frame(maxWidth: .infinity, alignment: .trailing)
    }

    func copyMessage() {
#if canImport(UIKit)
        UIPasteboard.general.string = message.text
#elseif canImport(AppKit)
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(message.text, forType: .string)
#endif
        didCopy = true
        Task { @MainActor in
            try? await Task.sleep(for: .seconds(1.2))
            didCopy = false
        }
    }

    @ViewBuilder
    func deliveryIcon(_ palette: ShannonPalette) -> some View {
        switch message.deliveryState {
        case .sending:
            Image(systemName: "clock")
        case .sent:
            Image(systemName: "checkmark")
        case .failed:
            Image(systemName: "exclamationmark.circle.fill")
                .foregroundStyle(palette.danger)
        }
    }

    /// Artifacts and code blocks carry their own controls, so VoiceOver must reach them.
    var containsInteractiveContent: Bool {
        !message.artifacts.isEmpty || (message.role == .shannon && message.text.contains("```"))
    }

    var accessibilityLabel: String {
        // The feeling is read with the speaker, before the body: 「シャノン、得意げ。…」.
        let speaker = message.role == .shannon
            ? message.emotionSnapshot?.face.accessibilityDescription ?? "シャノン"
            : "あなた"
        let delivery = message.deliveryState == .failed ? "。送信失敗" : ""
        return "\(speaker)。\(message.text)\(delivery)"
    }
}
