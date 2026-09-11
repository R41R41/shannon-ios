import SwiftUI
#if canImport(UIKit)
import UIKit
#elseif canImport(AppKit)
import AppKit
#endif

struct ShannonEmptyConversation: View {
    var body: some View {
        ShannonAvatarView(expression: .curious, size: 96)
            .frame(maxWidth: .infinity)
            .padding(M3Spacing.extraLarge)
            .accessibilityLabel("シャノン")
    }
}

struct ShannonConversationDayDivider: View {
    let day: Date
    @Environment(\.colorScheme) var colorScheme

    var body: some View {
        let palette = M3Palette.resolve(colorScheme)
        HStack(spacing: M3Spacing.medium) {
            Rectangle().fill(palette.outlineVariant.opacity(0.52)).frame(height: 0.5)
            Text(label)
                .font(.caption2.weight(.medium))
                .foregroundStyle(palette.onSurfaceVariant)
                .fixedSize()
            Rectangle().fill(palette.outlineVariant.opacity(0.52)).frame(height: 0.5)
        }
        .padding(.vertical, M3Spacing.small)
        .accessibilityLabel(label)
    }

    var label: String {
        let calendar = Calendar.current
        if calendar.isDateInToday(day) { return "今日" }
        if calendar.isDateInYesterday(day) { return "昨日" }
        return day.formatted(.dateTime.year().month(.abbreviated).day().weekday(.abbreviated))
    }
}

struct ShannonContextReferenceCard: View {
    let memory: ActiveMemoryDTO
    @Environment(\.colorScheme) var colorScheme

    var body: some View {
        let palette = M3Palette.resolve(colorScheme)
        HStack(alignment: .top, spacing: M3Spacing.small) {
            Image(systemName: "arrow.uturn.backward.circle.fill")
                .foregroundStyle(palette.brandPresence)
            VStack(alignment: .leading, spacing: 3) {
                Text("思い出したこと")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(palette.brandPresence)
                Text(memory.summary)
                    .font(.caption)
                    .foregroundStyle(palette.onSurfaceVariant)
                    .lineLimit(2)
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, M3Spacing.medium)
        .padding(.vertical, M3Spacing.small)
        .background(palette.primaryContainer.opacity(0.42), in: RoundedRectangle(cornerRadius: M3Shape.medium))
        .padding(.leading, 62)
        .accessibilityElement(children: .combine)
    }
}

struct ShannonMessageRow: View {
    let message: ConversationMessage
    let isSendingToAether: Bool
    let wasSentToAether: Bool
    let sendToAether: () -> Void

    @Environment(\.colorScheme) var colorScheme
    @State var didCopy = false

    var body: some View {
        let palette = M3Palette.resolve(colorScheme)

        Group {
            if message.role == .shannon {
                shannonReply(palette)
            } else {
                userMessage(palette)
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(accessibilityLabel)
        .sensoryFeedback(.success, trigger: didCopy)
        .contextMenu {
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

    func shannonReply(_ palette: M3Palette) -> some View {
        VStack(alignment: .leading, spacing: M3Spacing.extraSmall) {
            HStack(alignment: .center, spacing: M3Spacing.extraSmall) {
                ShannonAvatarView(
                    expression: message.emotionSnapshot?.expression ?? .neutral,
                    size: 42
                )

                Text("シャノン")
                    .font(.callout.weight(.semibold))
                    .foregroundStyle(palette.onSurface)

                if let expression = message.emotionSnapshot?.expression {
                    Text("· \(expression.japaneseName)")
                }
                Text("· \(message.sentAt.formatted(date: .omitted, time: .shortened))")
                    .lineLimit(1)

                Spacer(minLength: 0)

                Button(action: copyMessage) {
                    Image(systemName: didCopy ? "checkmark" : "doc.on.doc")
                        .font(.caption.weight(.semibold))
                        .frame(width: 34, height: 34)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .foregroundStyle(palette.onSurfaceVariant)
                .accessibilityLabel(didCopy ? "コピーしました" : "シャノンの回答をコピー")
            }
            .font(.caption2)
            .foregroundStyle(palette.onSurfaceVariant)

            ShannonRichMarkdownText(source: message.text, palette: palette)
                .textSelection(.enabled)
                .tint(palette.primary)
                .frame(maxWidth: .infinity, alignment: .leading)

            if let attribution = message.sourceAttribution,
               let sourceURL = safeSourceURL(attribution.url) {
                Link(destination: sourceURL) {
                    HStack(alignment: .top, spacing: M3Spacing.small) {
                        Image(systemName: "link")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(palette.primary)
                            .frame(width: 22, height: 22)
                        VStack(alignment: .leading, spacing: 3) {
                            Text("出典 · \(attribution.title)")
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(palette.onSurface)
                            Text("選んだ理由: \(attribution.reason)")
                                .font(.caption2)
                                .foregroundStyle(palette.onSurfaceVariant)
                        }
                        Spacer(minLength: 0)
                        Image(systemName: "arrow.up.right")
                            .font(.caption2.weight(.semibold))
                            .foregroundStyle(palette.onSurfaceVariant)
                    }
                    .padding(.horizontal, M3Spacing.medium)
                    .padding(.vertical, M3Spacing.small)
                    .background(
                        palette.surfaceContainer,
                        in: RoundedRectangle(cornerRadius: M3Shape.medium, style: .continuous)
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

    func userMessage(_ palette: M3Palette) -> some View {
        HStack(alignment: .bottom, spacing: M3Spacing.small) {
            Spacer(minLength: 64)

            VStack(alignment: .trailing, spacing: 5) {
                Text(ShannonMessageMarkdown.render(message.text))
                    .font(.body)
                    .lineSpacing(3)
                    .textSelection(.enabled)
                    .foregroundStyle(palette.onPrimaryContainer)
                    .tint(palette.primary)
                    .padding(.horizontal, M3Spacing.large)
                    .padding(.vertical, M3Spacing.small + 2)
                    .background(
                        palette.primaryContainer,
                        in: RoundedRectangle(cornerRadius: M3Shape.large, style: .continuous)
                    )

                HStack(spacing: 5) {
                    Text(message.sentAt.formatted(date: .omitted, time: .shortened))
                    deliveryIcon(palette)
                }
                .font(.caption2)
                .foregroundStyle(message.deliveryState == .failed ? palette.error : palette.onSurfaceVariant)
                .padding(.horizontal, M3Spacing.extraSmall)
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
    func deliveryIcon(_ palette: M3Palette) -> some View {
        switch message.deliveryState {
        case .sending:
            Image(systemName: "clock")
        case .sent:
            Image(systemName: "checkmark")
        case .failed:
            Image(systemName: "exclamationmark.circle.fill")
                .foregroundStyle(palette.error)
        }
    }

    var accessibilityLabel: String {
        let speaker = message.role == .shannon ? "シャノン" : "あなた"
        let emotion = message.emotionSnapshot.map { "。\($0.expression.japaneseName)表情" } ?? ""
        let delivery = message.deliveryState == .failed ? "。送信失敗" : ""
        return "\(speaker)。\(message.text)\(emotion)\(delivery)"
    }
}
