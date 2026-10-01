import AppKit
import ShannonAppCore
import SwiftUI
import UniformTypeIdentifiers

struct DesktopComposer: View {
    @Bindable var model: ShannonConversationModel
    @State var attachments: [ShannonChatAttachmentDTO] = []
    @State var isImporting = false
    @State var attachmentError: String?
    @State var usesWebSearch = false

    init(model: ShannonConversationModel) {
        self.model = model
#if DEBUG
        _attachments = State(initialValue: model.isDesignPreview ? [
            ShannonChatAttachmentDTO(
                name: "shannon-interface-plan.md",
                mimeType: "text/markdown",
                text: "# Shannon Desk\n会話と作業を一つの流れにする。"
            )
        ] : [])
        _usesWebSearch = State(initialValue: model.isDesignPreview)
#endif
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if !attachments.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(Array(attachments.enumerated()), id: \.offset) { index, attachment in
                            HStack(spacing: 7) {
                                Image(systemName: "doc.text")
                                    .foregroundStyle(.secondary)
                                VStack(alignment: .leading, spacing: 1) {
                                    Text(attachment.name)
                                        .font(.caption.weight(.medium))
                                        .lineLimit(1)
                                    Text(ByteCountFormatter.string(
                                        fromByteCount: Int64(attachment.text.utf8.count),
                                        countStyle: .file
                                    ))
                                    .font(.caption2)
                                    .foregroundStyle(.secondary)
                                }
                                Button {
                                    attachments.remove(at: index)
                                    attachmentError = nil
                                } label: {
                                    Image(systemName: "xmark.circle.fill")
                                        .foregroundStyle(.tertiary)
                                }
                                .buttonStyle(.plain)
                                .help("添付を外す")
                            }
                            .padding(.leading, 10)
                            .padding(.trailing, 7)
                            .padding(.vertical, 7)
                            .background(Color.primary.opacity(0.055), in: RoundedRectangle(cornerRadius: 10))
                        }
                    }
                }
            }

            if let attachmentError {
                Label(attachmentError, systemImage: "exclamationmark.triangle")
                    .font(.caption)
                    .foregroundStyle(Color.shannonAttention)
            }

            if usesWebSearch {
                HStack(spacing: 7) {
                    Image(systemName: "globe")
                    Text("Webで調べる")
                        .font(.caption.weight(.medium))
                    Button {
                        usesWebSearch = false
                    } label: {
                        Image(systemName: "xmark.circle.fill")
                            .foregroundStyle(.tertiary)
                    }
                    .buttonStyle(.plain)
                    .help("Web検索を外す")
                }
                .foregroundStyle(Color.accentColor)
                .padding(.horizontal, 10)
                .padding(.vertical, 7)
                .background(Color.accentColor.opacity(0.10), in: Capsule())
            }

            TextField("シャノンに話す", text: $model.draft, axis: .vertical)
                .textFieldStyle(.plain)
                .lineLimit(1...8)
                .font(.body)

            HStack {
                Menu {
                    Button("ファイルを追加", systemImage: "paperclip") {
                        isImporting = true
                    }
                    Button(
                        usesWebSearch ? "Web検索を外す" : "Webで調べる",
                        systemImage: usesWebSearch ? "checkmark.circle" : "globe"
                    ) {
                        usesWebSearch.toggle()
                    }
                    Divider()
                    Text("テキスト・Markdown・コードを4件まで")
                    Text("Web検索は明示的に選んだ送信だけで使用")
                } label: {
                    Image(systemName: "paperclip")
                }
                .menuStyle(.borderlessButton)
                .help("添付とツール")

                Spacer()
                Text("⌘↩︎で送信")
                    .font(.caption)
                    .foregroundStyle(.tertiary)
                Button {
                    let selectedAttachments = attachments
                    let selectedWebSearch = usesWebSearch
                    attachments = []
                    usesWebSearch = false
                    attachmentError = nil
                    Task {
                        await model.sendDraft(
                            attachments: selectedAttachments,
                            webSearch: selectedWebSearch
                        )
                    }
                } label: {
                    Image(systemName: "arrow.up")
                        .font(.system(size: 13, weight: .bold))
                        .frame(width: 26, height: 26)
                }
                .buttonStyle(.borderedProminent)
                .buttonBorderShape(.circle)
                .disabled(!model.canSendDraft(attachmentCount: attachments.count))
                .keyboardShortcut(.return, modifiers: .command)
            }
        }
        .padding(12)
        .frame(maxWidth: 780)
        .frame(maxWidth: .infinity)
        .fileImporter(
            isPresented: $isImporting,
            allowedContentTypes: [.plainText, .sourceCode, .json, .commaSeparatedText],
            allowsMultipleSelection: true
        ) { result in
            do {
                attachments = try ShannonDesktopAttachmentLoader.load(
                    urls: result.get(),
                    existing: attachments
                )
                attachmentError = nil
            } catch {
                attachmentError = (error as? LocalizedError)?.errorDescription
                    ?? "ファイルを追加できませんでした。"
            }
        }
        .onChange(of: model.selectedThreadId) {
            attachments = []
            usesWebSearch = false
            attachmentError = nil
        }
    }
}

struct DesktopTaskSection: View {
    let title: String
    let subtitle: String
    let tasks: [ShannonAgentTask]
    let threads: [ChatThreadDTO]
    let selectedTaskID: UUID?
    let select: (ShannonAgentTask) -> Void

    var body: some View {
        if !tasks.isEmpty {
            VStack(alignment: .leading, spacing: 10) {
                HStack(alignment: .firstTextBaseline) {
                    Text(title).font(.title2.weight(.semibold))
                    Text(subtitle).font(.callout).foregroundStyle(.secondary)
                }
                VStack(spacing: 0) {
                    ForEach(tasks) { task in
                        Button { select(task) } label: {
                            HStack(spacing: 14) {
                                Image(systemName: task.status.symbolName)
                                    .foregroundStyle(task.status == .waitingApproval ? Color.shannonAttention : .secondary)
                                    .frame(width: 20)
                                VStack(alignment: .leading, spacing: 3) {
                                    HStack {
                                        Text(task.title).font(.headline)
                                        Text(task.stateName)
                                            .font(.caption)
                                            .foregroundStyle(.secondary)
                                    }
                                    Text(task.currentAction ?? task.summary)
                                        .font(.callout)
                                        .foregroundStyle(.secondary)
                                        .lineLimit(2)
                                    Label(
                                        ShannonDesktopConversationContext(task: task).title(in: threads),
                                        systemImage: "bubble.left"
                                    )
                                    .font(.caption)
                                    .foregroundStyle(.tertiary)
                                    .lineLimit(1)
                                }
                                Spacer()
                                if let progress = task.progressFraction {
                                    ProgressView(value: progress)
                                        .frame(width: 90)
                                }
                                Image(systemName: "chevron.right")
                                    .foregroundStyle(.tertiary)
                            }
                            .padding(.horizontal, 14)
                            .padding(.vertical, 12)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .background(selectedTaskID == task.id ? Color.accentColor.opacity(0.08) : .clear)
                        if task.id != tasks.last?.id { Divider().padding(.leading, 48) }
                    }
                }
                .background(Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: 12))
            }
        }
    }
}

struct DesktopInspectorSection<Content: View>: View {
    let title: String
    @ViewBuilder let content: Content

    init(title: String, @ViewBuilder content: () -> Content) {
        self.title = title
        self.content = content()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            Text(title)
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
                .textCase(.uppercase)
            content
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .background(Color.primary.opacity(0.035), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .stroke(Color.primary.opacity(0.055), lineWidth: 0.75)
        }
    }
}

struct DesktopExpandableText: View {
    let value: String
    let collapsedLineLimit: Int
    @State private var isExpanded = false

    init(_ value: String, collapsedLineLimit: Int) {
        self.value = value
        self.collapsedLineLimit = collapsedLineLimit
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(value)
                .lineLimit(isExpanded ? nil : collapsedLineLimit)
                .textSelection(.enabled)
            if value.count > 180 {
                Button(isExpanded ? "折りたたむ" : "全文を表示") {
                    withAnimation(.easeOut(duration: 0.16)) {
                        isExpanded.toggle()
                    }
                }
                .buttonStyle(.link)
                .font(.caption)
            }
        }
    }
}

struct DesktopTaskStageRail: View {
    let progress: [ShannonAgentTaskStageProgress]

    var body: some View {
        HStack(spacing: 5) {
            ForEach(progress) { item in
                VStack(spacing: 4) {
                    Image(systemName: symbolName(for: item))
                        .foregroundStyle(color(for: item))
                    Text(item.stage.japaneseName)
                        .font(.caption2)
                        .foregroundStyle(item.state == .current ? .primary : .secondary)
                        .lineLimit(1)
                }
                .frame(maxWidth: .infinity)
                .accessibilityElement(children: .combine)
            }
        }
        .padding(.vertical, 8)
        .padding(.horizontal, 6)
        .background(Color.primary.opacity(0.025), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
    }

    private func symbolName(for item: ShannonAgentTaskStageProgress) -> String {
        switch item.state {
        case .pending: "circle"
        case .current: "circle.inset.filled"
        case .completed: "checkmark.circle.fill"
        }
    }

    private func color(for item: ShannonAgentTaskStageProgress) -> Color {
        switch item.state {
        case .pending: .secondary
        case .current: .accentColor
        case .completed: .shannonSuccess
        }
    }
}

extension ShannonAgentEventTone {
    var desktopSymbolName: String {
        switch self {
        case .neutral: "circle"
        case .progress: "arrow.right.circle.fill"
        case .success: "checkmark.circle.fill"
        case .warning: "exclamationmark.circle.fill"
        case .error: "xmark.octagon.fill"
        }
    }

    var desktopColor: Color {
        switch self {
        case .neutral: .secondary
        case .progress: .accentColor
        case .success: Color.shannonSuccess
        case .warning: Color.shannonAttention
        case .error: Color.shannonDanger
        }
    }
}

extension ShannonAgentTestStatus {
    var desktopSymbolName: String {
        switch self {
        case .pending: "clock"
        case .passed: "checkmark.circle.fill"
        case .failed: "xmark.circle.fill"
        }
    }

    var desktopColor: Color {
        switch self {
        case .pending: .secondary
        case .passed: Color.shannonSuccess
        case .failed: Color.shannonDanger
        }
    }
}
