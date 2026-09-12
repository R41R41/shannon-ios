import SwiftUI
#if canImport(UIKit)
import UIKit
#elseif canImport(AppKit)
import AppKit
#endif

struct ShannonThreadDrawer: View {
    let model: ShannonConversationModel
    let selectedThreadId: String?
    let openTalk: () -> Void
    let openMemory: () -> Void
    let openSettings: () -> Void
    let openAgentTask: (UUID) -> Void
    let close: () -> Void

    @Environment(\.colorScheme) var colorScheme
    @State var creatingTitle = ""
    @State var isCreating = false
    @State var creatingError: String?
    @State var editingThread: ChatThreadDTO?

    var body: some View {
        let palette = ShannonPalette.resolve(colorScheme)

        VStack(spacing: 0) {
            HStack {
                Text("Shannon")
                    .font(.title2.bold())
                Spacer()
                Button {
                    Task {
                        isCreating = true
                        defer { isCreating = false }
                        await model.createThread(title: nil)
                        openTalk()
                    }
                } label: {
                    Image(systemName: isCreating ? "ellipsis" : "square.and.pencil")
                        .frame(width: ShannonTouchTarget.minimum, height: ShannonTouchTarget.minimum)
                }
                .buttonStyle(.plain)
                .disabled(isCreating)
                .accessibilityLabel(isCreating ? "新しいトークを作成中" : "新しいトーク")

                Button(action: close) {
                    Image(systemName: "xmark")
                        .frame(width: ShannonTouchTarget.minimum, height: ShannonTouchTarget.minimum)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("閉じる")
            }
            .padding(.top, 58)
            .padding(.horizontal, ShannonSpacing.large)
            .padding(.bottom, ShannonSpacing.medium)

            ScrollView {
                LazyVStack(spacing: ShannonSpacing.extraSmall) {
                    ForEach(model.threads, id: \.threadId) { thread in
                        HStack(spacing: 0) {
                            Button {
                                Task {
                                    await model.selectThread(thread.threadId)
                                    openTalk()
                                }
                            } label: {
                                HStack(spacing: ShannonSpacing.medium) {
                                    VStack(alignment: .leading, spacing: 3) {
                                        Text(thread.title)
                                            .font(.body.weight(thread.threadId == selectedThreadId ? .semibold : .regular))
                                            .foregroundStyle(palette.textPrimary)
                                            .lineLimit(2)
                                        HStack(spacing: 6) {
                                            Text(threadUpdatedLabel(thread.updatedAt))
                                            Text("·")
                                            Text("\(thread.messageCount)件")
                                        }
                                        .font(.caption)
                                        .foregroundStyle(palette.textSecondary)
                                    }
                                    Spacer()
                                    if model.initiativeThreadIDs.contains(thread.threadId) {
                                        Circle()
                                            .fill(palette.action)
                                            .frame(width: 9, height: 9)
                                            .accessibilityLabel("シャノンからの新しい話")
                                    }
                                    if thread.threadId == selectedThreadId {
                                        Image(systemName: "checkmark")
                                            .foregroundStyle(palette.action)
                                    }
                                }
                                .padding(.leading, ShannonSpacing.medium)
                                .padding(.vertical, ShannonSpacing.extraSmall)
                                .frame(minHeight: 58)
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                            .accessibilityAddTraits(thread.threadId == selectedThreadId ? .isSelected : [])
                            .contextMenu {
                                threadActions(for: thread)
                            }

                            Menu {
                                threadActions(for: thread)
                            } label: {
                                Image(systemName: "ellipsis")
                                    .font(.system(size: 17, weight: .semibold))
                                    .foregroundStyle(palette.textSecondary)
                                    .frame(width: ShannonTouchTarget.minimum, height: 58)
                                    .contentShape(Rectangle())
                            }
                            .accessibilityLabel("\(thread.title)の操作")
                        }
                        .background(
                            thread.threadId == selectedThreadId
                                ? palette.subtleSurface.opacity(0.72)
                                : Color.clear,
                            in: RoundedRectangle(cornerRadius: ShannonShape.medium)
                        )
                    }
                }
                .padding(.horizontal, ShannonSpacing.small)
            }
            .scrollIndicators(.hidden)

            if let creatingError {
                Text(creatingError)
                    .font(.caption)
                    .foregroundStyle(palette.danger)
                    .padding(ShannonSpacing.medium)
            }

            Divider()
                .overlay(palette.divider.opacity(0.6))

            VStack(spacing: ShannonSpacing.extraSmall) {
                Button(action: openMemory) {
                    ShannonDrawerDestinationRow(
                        title: "頭の中",
                        detail: "いま・知識・日記",
                        symbol: "brain.head.profile",
                        badge: nil,
                        palette: palette
                    )
                }
                .buttonStyle(.plain)

                if let task = model.agentTaskNotices.first {
                    Button {
                        openAgentTask(task.id)
                    } label: {
                        ShannonDrawerDestinationRow(
                            title: "作業",
                            detail: task.status.japaneseName,
                            symbol: task.status == .waitingApproval ? "hand.raised" : "hammer",
                            badge: model.agentTaskNotices.count,
                            palette: palette
                        )
                    }
                    .buttonStyle(.plain)
                } else {
                    ShannonDrawerDestinationRow(
                        title: "作業",
                        detail: "進行中の作業はありません",
                        symbol: "hammer",
                        badge: nil,
                        palette: palette
                    )
                    .opacity(0.72)
                }

                Button(action: openSettings) {
                    ShannonDrawerDestinationRow(
                        title: "設定",
                        detail: nil,
                        symbol: "gearshape",
                        badge: nil,
                        palette: palette
                    )
                }
                .buttonStyle(.plain)
            }
            .padding(.horizontal, ShannonSpacing.small)
            .padding(.top, ShannonSpacing.small)
            .padding(.bottom, 28)
        }
        .frame(maxHeight: .infinity)
        .background {
            Rectangle()
                .fill(.regularMaterial)
                .ignoresSafeArea(.container, edges: [.top, .bottom])
        }
        .overlay(alignment: .trailing) {
            Rectangle().fill(palette.divider.opacity(0.45)).frame(width: 0.7)
        }
        .shadow(color: .black.opacity(0.16), radius: 20, x: 8)
        .sheet(isPresented: Binding(
            get: { editingThread != nil },
            set: { if !$0 { editingThread = nil } }
        )) {
            if let editingThread {
                ShannonThreadTitleEditor(
                    initialTitle: editingThread.title,
                    save: { title in
                        await model.renameThread(editingThread.threadId, title: title)
                    },
                    cancel: { self.editingThread = nil }
                )
            }
        }
    }

    @ViewBuilder
    func threadActions(for thread: ChatThreadDTO) -> some View {
        Button {
            editingThread = thread
        } label: {
            Label("タイトルを編集", systemImage: "pencil")
        }

        Button(role: .destructive) {
            Task { await model.archiveThread(thread.threadId) }
        } label: {
            Label("アーカイブ", systemImage: "archivebox")
        }
        .disabled(model.threads.count <= 1)
    }
}

struct ShannonDrawerDestinationRow: View {
    let title: String
    let detail: String?
    let symbol: String
    let badge: Int?
    let palette: ShannonPalette

    var body: some View {
        HStack(spacing: ShannonSpacing.medium) {
            Image(systemName: symbol)
                .font(.system(size: 17, weight: .medium))
                .foregroundStyle(palette.brandPresence)
                .frame(width: 28, height: 28)

            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.body.weight(.medium))
                    .foregroundStyle(palette.textPrimary)
                if let detail {
                    Text(detail)
                        .font(.caption)
                        .foregroundStyle(palette.textSecondary)
                        .lineLimit(1)
                }
            }

            Spacer(minLength: 0)

            if let badge, badge > 0 {
                Text(badge > 9 ? "9+" : "\(badge)")
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(palette.onAction)
                    .padding(.horizontal, 6)
                    .frame(minWidth: 20, minHeight: 20)
                    .background(palette.action, in: Capsule())
            }

            Image(systemName: "chevron.right")
                .font(.caption.weight(.semibold))
                .foregroundStyle(palette.textSecondary)
        }
        .padding(.horizontal, ShannonSpacing.medium)
        .frame(minHeight: 52)
        .contentShape(Rectangle())
    }
}

struct ShannonThreadTitleEditor: View {
    let initialTitle: String
    let save: (String) async -> Bool
    let cancel: () -> Void

    @Environment(\.colorScheme) var colorScheme
    @FocusState var isTitleFieldFocused: Bool
    @State var title: String
    @State var isSaving = false

    init(
        initialTitle: String,
        save: @escaping (String) async -> Bool,
        cancel: @escaping () -> Void
    ) {
        self.initialTitle = initialTitle
        self.save = save
        self.cancel = cancel
        _title = State(initialValue: initialTitle)
    }

    var body: some View {
        let palette = ShannonPalette.resolve(colorScheme)
        NavigationStack {
            VStack(alignment: .leading, spacing: ShannonSpacing.medium) {
                Text("トーク一覧に表示する名前を入力してください。")
                    .font(.body)
                    .foregroundStyle(palette.textSecondary)

                TextField("タイトル", text: $title, axis: .vertical)
                    .lineLimit(1...3)
                    .focused($isTitleFieldFocused)
                    .padding(ShannonSpacing.medium)
                    .background(palette.elevatedSurface, in: RoundedRectangle(cornerRadius: ShannonShape.medium))
                    .accessibilityLabel("トークのタイトル")

                Text("\(title.count)/80文字")
                    .font(.caption)
                    .foregroundStyle(title.count > 80 ? palette.danger : palette.textSecondary)

                Spacer()
            }
            .padding(ShannonSpacing.large)
            .navigationTitle("タイトルを編集")
#if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
#endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("キャンセル", action: cancel)
                        .disabled(isSaving)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(isSaving ? "保存中…" : "保存") {
                        Task {
                            isSaving = true
                            let didSave = await save(title)
                            isSaving = false
                            if didSave { cancel() }
                        }
                    }
                    .disabled(!isValidTitle || isSaving)
                }
            }
        }
        .presentationDetents([.medium])
        .task { isTitleFieldFocused = true }
    }

    var isValidTitle: Bool {
        let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
        return !trimmed.isEmpty && trimmed.count <= 80
    }
}


struct ShannonSettingsRow: View {
    let title: String
    let detail: String
    let symbol: String
    @Environment(\.colorScheme) var colorScheme

    var body: some View {
        let palette = ShannonPalette.resolve(colorScheme)

        HStack(spacing: ShannonSpacing.medium) {
            Image(systemName: symbol)
                .font(.system(size: 20, weight: .medium))
                .foregroundStyle(palette.action)
                .frame(width: 44, height: 44)
                .background(palette.subtleSurface, in: Circle())

            VStack(alignment: .leading, spacing: 3) {
                Text(title)
                    .font(.body.weight(.semibold))
                    .foregroundStyle(palette.textPrimary)
                Text(detail)
                    .font(.caption)
                    .foregroundStyle(palette.textSecondary)
            }

            Spacer()
            Image(systemName: "chevron.right")
                .foregroundStyle(palette.textSecondary)
        }
        .padding(ShannonSpacing.large)
        .frame(maxWidth: .infinity, minHeight: 72, alignment: .leading)
        .background(palette.canvas, in: RoundedRectangle(cornerRadius: ShannonShape.large))
        .overlay {
            RoundedRectangle(cornerRadius: ShannonShape.large)
                .stroke(palette.divider.opacity(0.7), lineWidth: 0.7)
        }
    }
}

extension View {
    @ViewBuilder
    func shannonKeyboardDismissMode() -> some View {
#if os(iOS)
        scrollDismissesKeyboard(.interactively)
#else
        self
#endif
    }
}
