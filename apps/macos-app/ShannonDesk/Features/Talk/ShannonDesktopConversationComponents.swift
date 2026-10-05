import AppKit
import ShannonAppCore
import SwiftUI
import UniformTypeIdentifiers

struct DesktopMessageView: View {
    let message: ConversationMessage
    let retry: (() -> Void)?

    var body: some View {
        if message.role == .user {
            HStack {
                Spacer(minLength: 100)
                VStack(alignment: .trailing, spacing: 5) {
                    Text(message.text)
                        .textSelection(.enabled)
                        .padding(.horizontal, ShannonDesktopSpacing.large)
                        .padding(.vertical, ShannonDesktopSpacing.medium)
                        .background(Color.primary.opacity(0.07), in: RoundedRectangle(cornerRadius: ShannonDesktopRadius.large, style: .continuous))

                    HStack(spacing: 5) {
                        Text(message.sentAt.formatted(date: .omitted, time: .shortened))
                        deliveryStatus
                        if let retry {
                            Button("再送", action: retry)
                                .buttonStyle(.borderless)
                        }
                    }
                    .font(.shannonDesktop(.caption2))
                    .foregroundStyle(message.deliveryState == .failed ? Color.shannonDanger : .secondary)
                    .padding(.horizontal, ShannonDesktopSpacing.extraSmall)
                }
            }
            .modifier(DesktopConversationOutlineAnchorModifier(
                id: ShannonDesktopConversationOutline.requestAnchorID(messageID: message.id)
            ))
        } else {
            VStack(alignment: .leading, spacing: 9) {
                HStack(spacing: ShannonDesktopSpacing.small) {
                    ShannonAvatarView(expression: message.emotionSnapshot?.expression ?? .neutral, size: 28)
                    Text("シャノン")
                        .font(.shannonDesktop(.callout).weight(.semibold))
                    Text((message.emotionSnapshot?.face ?? ShannonFace(expression: .neutral)).japaneseName)
                        .font(.shannonDesktop(.caption))
                        .foregroundStyle(.secondary)
                    Text("· \(message.sentAt.formatted(date: .omitted, time: .shortened))")
                        .font(.shannonDesktop(.caption))
                        .foregroundStyle(.secondary)
                    Spacer()
                    Button {
                        NSPasteboard.general.clearContents()
                        NSPasteboard.general.setString(message.text, forType: .string)
                    } label: {
                        Image(systemName: "doc.on.doc")
                    }
                    .buttonStyle(.borderless)
                    .help("返答をコピー")
                }
                DesktopMarkdownView(source: message.text, messageID: message.id)
                if !message.artifacts.isEmpty {
                    VStack(spacing: ShannonDesktopSpacing.small) {
                        ForEach(Array(message.artifacts.enumerated()), id: \.offset) { _, artifact in
                            DesktopArtifactCard(artifact: artifact)
                        }
                    }
                    .padding(.top, 2)
                }
                if let studyPiece = message.studyPiece {
                    ShannonStudyPieceLinkCard(link: studyPiece)
                }
                if let attribution = message.sourceAttribution,
                   let sourceURL = safeSourceURL(attribution.url) {
                    Link(destination: sourceURL) {
                        HStack(alignment: .top, spacing: ShannonDesktopSpacing.small) {
                            Image(systemName: "link")
                                .foregroundStyle(Color.shannonActionColor)
                            VStack(alignment: .leading, spacing: 2) {
                                Text("出典 · \(attribution.title)")
                                    .font(.shannonDesktop(.caption).weight(.semibold))
                                Text("選んだ理由: \(attribution.reason)")
                                    .font(.shannonDesktop(.caption2))
                                    .foregroundStyle(.secondary)
                            }
                            Spacer(minLength: 0)
                            Image(systemName: "arrow.up.right")
                                .font(.shannonDesktop(.caption2))
                                .foregroundStyle(.secondary)
                        }
                        .padding(ShannonDesktopSpacing.medium)
                        .background(Color.primary.opacity(0.04), in: RoundedRectangle(cornerRadius: ShannonDesktopRadius.medium))
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("出典 \(attribution.title)。選んだ理由 \(attribution.reason)")
                }
            }
        }
    }

    @ViewBuilder
    private var deliveryStatus: some View {
        switch message.deliveryState {
        case .sending:
            Label("送信中", systemImage: "clock")
                .labelStyle(.iconOnly)
                .accessibilityLabel("送信中")
        case .sent:
            Label("送信済み", systemImage: "checkmark")
                .labelStyle(.iconOnly)
                .accessibilityLabel("送信済み")
        case .failed:
            Label("送信失敗", systemImage: "exclamationmark.circle.fill")
                .labelStyle(.iconOnly)
                .accessibilityLabel("送信失敗")
        }
    }

    private func safeSourceURL(_ raw: String) -> URL? {
        guard let url = URL(string: raw), url.scheme == "https" || url.scheme == "http" else { return nil }
        return url
    }
}
