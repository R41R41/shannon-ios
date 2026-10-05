import AppKit
import PhotosUI
import ShannonAppCore
import SwiftUI
import UniformTypeIdentifiers

struct DesktopComposer: View {
    @Bindable var model: ShannonConversationModel
    /// The voice conversation (A16): started from here, and while it is on, what is typed here goes into it.
    let voiceCall: ShannonDesktopVoiceCall
    let startCall: () -> Void
    @State var attachments: [ShannonChatAttachmentDTO] = []
    @State var isImporting = false
    @State var attachmentError: String?
    @State var usesWebSearch = false
    /// One photo, as on the iPhone: from Photos or an image file, prepared in memory (A14).
    @State var photo: ShannonChatPhoto?
    @State var photoPreview: NSImage?
    @State var isPickingPhoto = false
    @State var photoPickerItem: PhotosPickerItem?
    @State var isPreparingPhoto = false

    init(model: ShannonConversationModel, voiceCall: ShannonDesktopVoiceCall, startCall: @escaping () -> Void) {
        self.model = model
        self.voiceCall = voiceCall
        self.startCall = startCall
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
        VStack(alignment: .leading, spacing: ShannonDesktopSpacing.small) {
            photoContext
            if !attachments.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: ShannonDesktopSpacing.small) {
                        ForEach(Array(attachments.enumerated()), id: \.offset) { index, attachment in
                            HStack(spacing: 7) {
                                Image(systemName: "doc.text")
                                    .foregroundStyle(.secondary)
                                VStack(alignment: .leading, spacing: 1) {
                                    Text(attachment.name)
                                        .font(.shannonDesktop(.caption).weight(.medium))
                                        .lineLimit(1)
                                    Text(ByteCountFormatter.string(
                                        fromByteCount: Int64(attachment.text.utf8.count),
                                        countStyle: .file
                                    ))
                                    .font(.shannonDesktop(.caption2))
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
                            .padding(.leading, ShannonDesktopSpacing.medium)
                            .padding(.trailing, 7)
                            .padding(.vertical, 7)
                            .background(Color.primary.opacity(0.055), in: RoundedRectangle(cornerRadius: ShannonDesktopRadius.medium))
                        }
                    }
                }
            }

            if let attachmentError {
                Label(attachmentError, systemImage: "exclamationmark.triangle")
                    .font(.shannonDesktop(.caption))
                    .foregroundStyle(Color.shannonAttention)
            }
            dictationNotice

            if usesWebSearch {
                HStack(spacing: 7) {
                    Image(systemName: "globe")
                    Text("Webで調べる")
                        .font(.shannonDesktop(.caption).weight(.medium))
                    Button {
                        usesWebSearch = false
                    } label: {
                        Image(systemName: "xmark.circle.fill")
                            .foregroundStyle(.tertiary)
                    }
                    .buttonStyle(.plain)
                    .help("Web検索を外す")
                }
                .foregroundStyle(Color.shannonActionColor)
                .padding(.horizontal, ShannonDesktopSpacing.medium)
                .padding(.vertical, 7)
                .background(Color.shannonActionColor.opacity(0.10), in: Capsule())
            }

            TextField("シャノンに話す", text: $model.draft, axis: .vertical)
                .textFieldStyle(.plain)
                .lineLimit(1...8)
                .font(.shannonDesktop(.body))

            HStack {
                Menu {
                    Button("写真ライブラリから追加", systemImage: "photo.on.rectangle") {
                        isPickingPhoto = true
                    }
                    .disabled(attachmentCount >= ShannonChatAttachmentLimits.maximumCount)
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
                    Text("写真とファイルを合わせて4件まで")
                    Text("Web検索は明示的に選んだ送信だけで使用")
                } label: {
                    Image(systemName: "paperclip")
                }
                .menuStyle(.borderlessButton)
                .help("添付とツール")
                // During a call a photo is shown to her through the call's own 写真.
                .disabled(inCall)

                Spacer()
                Text(inCall ? ShannonGeneratedStrings.voiceMacSendInCall : "⌘↩︎で送信")
                    .font(.shannonDesktop(.caption))
                    .foregroundStyle(.tertiary)
                dictationButton
                if !voiceCall.isShown { callButton }
                Button {
                    if inCall {
                        sendIntoCall()
                        return
                    }
                    let selectedAttachments = attachments
                    let selectedWebSearch = usesWebSearch
                    let selectedPhoto = photo?.jpegData
                    attachments = []
                    usesWebSearch = false
                    attachmentError = nil
                    clearPhoto()
                    Task {
                        await model.sendDraft(
                            attachments: selectedAttachments,
                            webSearch: selectedWebSearch,
                            photoJPEGData: selectedPhoto
                        )
                    }
                } label: {
                    Image(systemName: "arrow.up")
                        .font(.system(size: 13, weight: .bold))
                        .frame(width: 26, height: 26)
                }
                .buttonStyle(.borderedProminent)
                .buttonBorderShape(.circle)
                .disabled(inCall ? !canSendIntoCall : isPreparingPhoto || !model.canSendDraft(attachmentCount: attachmentCount))
                .keyboardShortcut(.return, modifiers: .command)
            }
        }
        .padding(ShannonDesktopSpacing.medium)
        .frame(maxWidth: 780)
        .frame(maxWidth: .infinity)
        .fileImporter(
            isPresented: $isImporting,
            allowedContentTypes: [.plainText, .sourceCode, .json, .commaSeparatedText, .image],
            allowsMultipleSelection: true
        ) { result in
            importFiles(result)
        }
        .photosPicker(isPresented: $isPickingPhoto, selection: $photoPickerItem, matching: .images)
        .shannonCoversFigure(isImporting || isPickingPhoto)
        .onChange(of: photoPickerItem) {
            guard let photoPickerItem else { return }
            Task { await loadPickedPhoto(photoPickerItem) }
        }
        // Owner text that failed to go into the call is cleared from the draft when a friend joins (A16).
        .onChange(of: model.draft) { voiceCall.draftChanged(model.draft) }
        .onChange(of: model.selectedThreadId) {
            attachments = []
            usesWebSearch = false
            attachmentError = nil
            clearPhoto()
        }
    }
}

/// The composer's voice (roadmap A16): 音声会話を開始 (the waveform, as the iPhone's empty composer shows it),
/// 音声入力 (the microphone: the words go into the draft and nothing is sent until the owner sends it), and,
/// while a call is on, text sent into the call (`voice.text-in-call`).
extension DesktopComposer {
    /// A call holds the microphone: ⌘↩︎ sends the draft into it, attachments wait.
    var inCall: Bool { voiceCall.holdsMicrophone }

    var canSendIntoCall: Bool {
        !model.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !voiceCall.session.textSendState.isSending
    }

    func sendIntoCall() {
        if voiceCall.sendText(model.draft) { model.draft = "" }
    }

    var callButton: some View {
        Button(action: startCall) {
            Image(systemName: "waveform")
                .font(.system(size: 13, weight: .semibold))
                .frame(width: 26, height: 26)
        }
        .buttonStyle(.bordered)
        .buttonBorderShape(.circle)
        // A finished dictation is written into the draft first (the microphone button), never dropped by a call.
        .disabled(voiceCall.dictationBlocksCall)
        .help(voiceCall.dictationBlocksCall ? ShannonGeneratedStrings.voiceMacCallWaitsForDictation : ShannonGeneratedStrings.voiceStart)
        .accessibilityLabel(ShannonGeneratedStrings.voiceStart)
        .accessibilityHint(voiceCall.dictationBlocksCall ? ShannonGeneratedStrings.voiceMacCallWaitsForDictation : "")
        .accessibilityIdentifier("talk-voice-start")
    }

    var dictationButton: some View {
        let phase = voiceCall.dictation.phase
        let listening = phase == .listening || phase == .ready
        let busy = [.requestingPermission, .transcribing, .thinking].contains(phase)
        return Button {
            voiceCall.dictationPrimaryAction { words in
                let draft = model.draft.trimmingCharacters(in: .whitespacesAndNewlines)
                model.draft = draft.isEmpty ? words : "\(draft) \(words)"
            }
        } label: {
            Group {
                if busy {
                    ProgressView().controlSize(.small)
                } else {
                    Image(systemName: listening ? "stop.fill" : "mic")
                        .font(.system(size: 13, weight: .semibold))
                }
            }
            .frame(width: 26, height: 26)
        }
        .buttonStyle(.bordered)
        .buttonBorderShape(.circle)
        .tint(listening ? Color.shannonActionColor : nil)
        .disabled(model.isSending || busy || voiceCall.dictationWaitsForCall)
        .help(dictationHelp(listening: listening))
        .accessibilityLabel(listening ? ShannonGeneratedStrings.voiceMacDictationStop : ShannonGeneratedStrings.voiceMacDictation)
        .accessibilityHint(voiceCall.dictationWaitsForCall ? ShannonGeneratedStrings.talkDictationWaitsForCall : "")
        .accessibilityIdentifier("talk-dictation")
    }

    private func dictationHelp(listening: Bool) -> String {
        if voiceCall.dictationWaitsForCall { return ShannonGeneratedStrings.talkDictationWaitsForCall }
        if let error = voiceCall.dictation.errorMessage, [.failed, .denied].contains(voiceCall.dictation.phase) { return error }
        return listening ? ShannonGeneratedStrings.voiceMacDictationStop : ShannonGeneratedStrings.voiceMacDictation
    }

    /// Dictation that could not start or could not be written out says why, under the field.
    @ViewBuilder
    var dictationNotice: some View {
        if [.failed, .denied].contains(voiceCall.dictation.phase), let error = voiceCall.dictation.errorMessage {
            Label(error, systemImage: "mic.slash")
                .font(.shannonDesktop(.caption))
                .foregroundStyle(Color.shannonAttention)
        }
    }
}
