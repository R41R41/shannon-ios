import AppKit
import ShannonAppCore
import SwiftUI
import UniformTypeIdentifiers

struct DesktopMessageView: View {
    let message: ConversationMessage

    var body: some View {
        if message.role == .user {
            HStack {
                Spacer(minLength: 100)
                Text(message.text)
                    .textSelection(.enabled)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 10)
                    .background(Color.primary.opacity(0.07), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
            }
        } else {
            VStack(alignment: .leading, spacing: 9) {
                HStack(spacing: 8) {
                    ShannonAvatarView(expression: message.emotionSnapshot?.expression ?? .neutral, size: 28)
                    Text("シャノン")
                        .font(.callout.weight(.semibold))
                    Text(DesktopExpressionLabel.label(for: message.emotionSnapshot?.expression ?? .neutral))
                        .font(.caption)
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
                DesktopMarkdownView(source: message.text)
                if !message.artifacts.isEmpty {
                    VStack(spacing: 8) {
                        ForEach(Array(message.artifacts.enumerated()), id: \.offset) { _, artifact in
                            DesktopArtifactCard(artifact: artifact)
                        }
                    }
                    .padding(.top, 2)
                }
            }
        }
    }
}
