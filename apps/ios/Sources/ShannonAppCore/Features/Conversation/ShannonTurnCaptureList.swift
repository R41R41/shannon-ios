import SwiftUI

/// The quiet lines under a Shannon reply: what she took in from that turn, and
/// for a reminder, what the owner can do about the promise. A reply that
/// captured nothing shows nothing. Shared by iPhone and Mac.
public struct ShannonTurnCaptureList: View {
    let message: ConversationMessage
    let conversation: ShannonConversationModel
    @Bindable var memory: ShannonMemoryModel
    @State private var opened: ShannonTurnCaptureDTO?
    @State private var confirming: ShannonTurnCaptureDTO?
    @State private var failure: String?
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    public init(message: ConversationMessage, conversation: ShannonConversationModel, memory: ShannonMemoryModel) {
        self.message = message
        self.conversation = conversation
        self.memory = memory
    }

    public static func hasContent(_ message: ConversationMessage) -> Bool {
        message.role == .shannon
            && (!message.captures.isEmpty || (message.reminder.map { $0.state != "superseded" } ?? false))
    }

    public var body: some View {
        let palette = ShannonPalette.resolve(colorScheme)
        VStack(alignment: .leading, spacing: ShannonSpacing.extraSmall) {
            ForEach(message.captures) { capture in
                captureRow(capture, palette)
            }
            if let reminder = message.reminder {
                reminderRow(reminder, palette)
            }
            if let failure {
                Label(failure, systemImage: "exclamationmark.triangle")
                    .font(.footnote)
                    .foregroundStyle(palette.danger)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .sheet(item: $opened, onDismiss: { Task { await conversation.refreshCaptures() } }) { capture in
            ShannonTurnCaptureDestination(capture: capture, memory: memory)
        }
        .confirmationDialog(
            confirming.map(ShannonTurnCapturePresentation.undoTitle) ?? "取り消す",
            isPresented: Binding(get: { confirming != nil }, set: { if !$0 { confirming = nil } }),
            titleVisibility: .visible
        ) {
            if let capture = confirming {
                Button(capture.kind == .knowledge ? "忘れる" : "取り消す", role: .destructive) { undo(capture) }
            }
            Button("キャンセル", role: .cancel) { confirming = nil }
        } message: {
            Text(confirming?.kind == .knowledge ? ShannonMemoryWithholdingCopy.captureUndo : "頭の中からいつでも確認できます。")
        }
    }

    private func captureRow(_ capture: ShannonTurnCaptureDTO, _ palette: ShannonPalette) -> some View {
        let pending = conversation.pendingCaptureActionIDs.contains(capture.id)
        let layout = dynamicTypeSize.isAccessibilitySize
            ? AnyLayout(VStackLayout(alignment: .leading, spacing: 0))
            : AnyLayout(HStackLayout(alignment: .firstTextBaseline, spacing: ShannonSpacing.small))
        return layout {
            if capture.kind == .notice || capture.itemId == nil {
                captureLabel(capture, palette)
                    .accessibilityElement(children: .combine)
                    .accessibilityLabel(ShannonTurnCapturePresentation.accessibilityLabel(capture))
            } else {
                Button { opened = capture } label: { captureLabel(capture, palette) }
                    .buttonStyle(.plain)
                    .accessibilityLabel(ShannonTurnCapturePresentation.accessibilityLabel(capture))
                    .accessibilityHint("頭の中で開きます")
            }
            if capture.canUndo {
                Button("取り消す") {
                    if capture.kind == .knowledge { confirming = capture } else { undo(capture) }
                }
                .buttonStyle(.borderless)
                .font(.footnote)
                .tint(palette.action)
                .frame(minWidth: ShannonTurnCaptureMetrics.minimumTarget, minHeight: ShannonTurnCaptureMetrics.minimumTarget)
                .contentShape(Rectangle())
                .disabled(pending)
                .accessibilityLabel(ShannonTurnCapturePresentation.undoTitle(capture))
            }
        }
    }

    private func captureLabel(_ capture: ShannonTurnCaptureDTO, _ palette: ShannonPalette) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: ShannonSpacing.extraSmall) {
            Image(systemName: ShannonTurnCapturePresentation.symbol(capture))
                .foregroundStyle(palette.textSecondary)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(ShannonTurnCapturePresentation.line(capture))
                    .foregroundStyle(palette.textSecondary)
                if let note = capture.note {
                    Text(note).foregroundStyle(palette.textSecondary)
                }
            }
            .multilineTextAlignment(.leading)
            .fixedSize(horizontal: false, vertical: true)
        }
        .font(.footnote)
        .frame(maxWidth: .infinity, minHeight: ShannonTurnCaptureMetrics.minimumTarget, alignment: .leading)
        .contentShape(Rectangle())
    }

    @ViewBuilder
    private func reminderRow(_ reminder: ShannonReminderDTO, _ palette: ShannonPalette) -> some View {
        let pending = conversation.pendingCaptureActionIDs.contains(reminder.commitmentId)
        if reminder.offersActions {
            let layout = dynamicTypeSize.isAccessibilitySize
                ? AnyLayout(VStackLayout(alignment: .leading, spacing: ShannonSpacing.small))
                : AnyLayout(HStackLayout(spacing: ShannonSpacing.small))
            layout {
                Button {
                    act { await conversation.completeReminder(reminder) }
                } label: {
                    Label("完了にする", systemImage: "checkmark")
                        .frame(minHeight: ShannonTurnCaptureMetrics.minimumTarget - 12)
                }
                .buttonStyle(.borderedProminent)
                .tint(palette.action)
                .accessibilityHint("この約束「\(reminder.text)」を完了にします")
                Button {
                    act { await conversation.snoozeReminder(reminder) }
                } label: {
                    Label("あとで", systemImage: "clock")
                        .frame(minHeight: ShannonTurnCaptureMetrics.minimumTarget - 12)
                }
                .buttonStyle(.bordered)
                .accessibilityHint("あとでもう一度だけ声をかけます。時刻は選べません")
            }
            .font(.subheadline)
            .disabled(pending)
        } else if let status = Self.reminderStatus(reminder) {
            Label(status.text, systemImage: status.symbol)
                .font(.footnote)
                .foregroundStyle(palette.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
                .frame(minHeight: 28, alignment: .leading)
        }
    }

    static func reminderStatus(_ reminder: ShannonReminderDTO) -> (text: String, symbol: String)? {
        switch reminder.state {
        case "completed": ("この約束は完了にしました", "checkmark.circle")
        case "snoozed": ("あとでもう一度声をかけます。声かけは1日1回の枠の中で届きます", "clock")
        case "dismissed": ("この約束は取り消し済みです", "xmark.circle")
        default: nil
        }
    }

    private func undo(_ capture: ShannonTurnCaptureDTO) {
        confirming = nil
        act { await conversation.undoCapture(capture) }
    }

    private func act(_ operation: @escaping () async -> Bool) {
        failure = nil
        Task {
            if await operation() {
                await memory.reload()
            } else {
                failure = conversation.captureActionError
            }
        }
    }
}

enum ShannonTurnCaptureMetrics {
#if os(iOS)
    static let minimumTarget: CGFloat = 44
#else
    static let minimumTarget: CGFloat = 28
#endif
}

/// Opens the captured item where it lives in 頭の中, with the existing controls.
struct ShannonTurnCaptureDestination: View {
    let capture: ShannonTurnCaptureDTO
    @Bindable var memory: ShannonMemoryModel
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Group {
                if capture.kind == .intent {
                    ShannonCognitionView(model: memory)
                } else if let itemID = capture.itemId {
                    if memory.dashboard?.items.contains(where: { $0.id == itemID }) == true {
                        ShannonMemoryDetailView(model: memory, memoryID: itemID)
                    } else if memory.isLoading || memory.dashboard == nil && memory.errorMessage == nil {
                        ProgressView("頭の中を開いています…")
                    } else {
                        ContentUnavailableView(
                            "この項目を開けませんでした",
                            systemImage: "tray",
                            description: Text(memory.errorMessage ?? "すでに取り消したか、忘れた項目です。")
                        )
                    }
                }
            }
            .navigationTitle(ShannonTurnCapturePresentation.title(capture))
#if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
#endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("閉じる") { dismiss() }
                }
            }
        }
#if os(macOS)
        .frame(minWidth: 520, minHeight: 560)
#endif
        .task { await memory.reload() }
    }
}
