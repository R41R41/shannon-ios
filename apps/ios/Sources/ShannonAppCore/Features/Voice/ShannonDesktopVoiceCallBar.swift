#if os(macOS)
import AppKit
import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

/// The Mac's voice conversation in Talk (roadmap A16; docs/product/information-architecture.md 2: 「入力欄から
///始める。姿は会話の横」). It sits over the composer while a call is on: one status line that is the authority
/// on the call's state, the last words of each side, and the labelled controls of the iPhone's call screen
/// (マイク, 入力マイク, 写真, 本人だけ／友人も一緒, 終了). Her figure and its phases are in the 「すがた」 panel beside
/// the conversation; text typed into the composer goes into the call. After a call with a 「友人も一緒」 period it
/// gives its place to the card that says what was remembered and offers 「今回は残さない」.
public struct ShannonDesktopVoiceCallBar: View {
    private let call: ShannonDesktopVoiceCall
    private let conversation: ShannonConversationModel
    private let openTask: (UUID) -> Void
    @State private var confirmsParticipant = false
    @State private var showsPhotoUnavailable = false
    @State private var importsPhotoFile = false
    @Environment(\.openURL) private var openURL
    @Environment(\.colorScheme) private var colorScheme

    public init(call: ShannonDesktopVoiceCall, conversation: ShannonConversationModel, openTask: @escaping (UUID) -> Void) {
        self.call = call
        self.conversation = conversation
        self.openTask = openTask
    }

    private var session: ShannonGeminiLiveSessionModel { call.session }
    private var workspace: ShannonVoiceWorkspaceState { call.workspace }

    public var body: some View {
        if call.isShown {
            live
        } else if let memory = workspace.callMemory {
            ShannonVoiceCallMemoryCard(
                state: memory,
                retry: { workspace.retryCallMemory(using: conversation) },
                discard: { workspace.discardCallMemory(using: conversation) },
                close: { workspace.callMemory = nil }
            )
        } else if let notice = call.notice {
            HStack(spacing: ShannonDesktopSpacing.small) {
                Image(systemName: "phone.down").foregroundStyle(.secondary)
                Text(notice).font(.shannonDesktop(.callout))
                Spacer()
                Button(ShannonGeneratedStrings.commonClose) { call.notice = nil }
                    .buttonStyle(.borderless)
            }
            .padding(.horizontal, ShannonDesktopSpacing.large)
            .padding(.vertical, ShannonDesktopSpacing.small)
            .background(.regularMaterial, in: RoundedRectangle(cornerRadius: ShannonDesktopRadius.medium, style: .continuous))
        }
    }

    private var live: some View {
        let palette = ShannonPalette.resolve(colorScheme)
        return VStack(alignment: .leading, spacing: ShannonDesktopSpacing.small) {
            if session.participantMode == .guest {
                ShannonVoiceGuestModeNotice(palette: palette)
            }
            header(palette)
            subtitles
            if session.phase == .failed { recovery }
            ShannonDesktopVoicePhotoRow(call: call)
            if case let .failed(text, message) = session.textSendState { textRetry(text: text, message: message) }
            if let task = voiceTask { taskRow(task) }
            ShannonDesktopVoiceCallControls(
                call: call,
                choosePhoto: { source in choosePhoto(source) },
                chooseParticipant: { confirmsParticipant = true }
            )
        }
        .padding(ShannonDesktopSpacing.medium)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: ShannonDesktopRadius.large, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: ShannonDesktopRadius.large, style: .continuous)
                .stroke(Color.shannonIntelligenceColor.opacity(0.35), lineWidth: 0.75)
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(ShannonGeneratedStrings.voiceName)
        .accessibilityIdentifier("voice-call-bar")
        .confirmationDialog(
            session.participantMode == .owner ? ShannonVoiceGuestModeCopy.switchToGuestTitle : ShannonVoiceGuestModeCopy.switchToOwnerTitle,
            isPresented: $confirmsParticipant, titleVisibility: .visible
        ) {
            if session.participantMode == .owner {
                Button(ShannonVoiceGuestModeCopy.switchToGuestAction) { call.switchParticipant(to: .guest) }
            } else {
                Button(ShannonVoiceGuestModeCopy.switchToOwnerAction) { call.switchParticipant(to: .owner) }
            }
            Button(ShannonGeneratedStrings.voiceMacCancel, role: .cancel) {}
        } message: {
            Text(session.participantMode == .owner ? ShannonVoiceGuestModeCopy.switchToGuestMessage : ShannonVoiceGuestModeCopy.switchToOwnerMessage)
        }
        .alert(ShannonVoiceGuestModeCopy.photoUnavailableTitle, isPresented: $showsPhotoUnavailable) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(ShannonVoiceGuestModeCopy.photoUnavailableMessage)
        }
        .sheet(isPresented: workspaceBinding(\.showsCamera)) {
            ShannonDesktopVoiceCameraSheet(take: call.receiveCameraFrame, cancel: { workspace.showsCamera = false })
        }
        .photosPicker(isPresented: workspaceBinding(\.showsPhotoLibrary), selection: workspaceBinding(\.selectedLibraryPhoto), matching: .images)
        .fileImporter(isPresented: $importsPhotoFile, allowedContentTypes: [.image], allowsMultipleSelection: false) { result in
            call.receivePhotoFile(result)
        }
        .onChange(of: workspace.selectedLibraryPhoto) {
            guard let item = workspace.selectedLibraryPhoto else { return }
            Task { await call.receiveLibraryPhoto(item) }
        }
        // A spoken switch to 「友人も一緒」 happens in the session: an unshared photo is cleared here too.
        .onChange(of: session.participantMode) { workspace.clearPhoto() }
        // Her figure is not what the owner sees while one of these is over the window.
        .shannonCoversFigure(workspace.showsCamera || workspace.showsPhotoLibrary || importsPhotoFile || confirmsParticipant)
    }

    private func header(_ palette: ShannonPalette) -> some View {
        let presentation = ShannonGeminiLiveStatusPresentation(
            phase: session.phase, failureRecovery: session.failureRecovery, errorMessage: session.errorMessage,
            isMuted: session.isMicrophoneMuted, hasConversation: !session.userTranscript.isEmpty || !session.shannonTranscript.isEmpty
        )
        return VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: ShannonDesktopSpacing.small) {
                Image(systemName: "waveform")
                    .foregroundStyle(Color.shannonIntelligenceColor)
                    .accessibilityHidden(true)
                Text(ShannonGeneratedStrings.voiceName)
                    .font(.shannonDesktop(.headline))
                if let started = session.callStartedAt {
                    TimelineView(.periodic(from: started, by: 1)) { context in
                        let seconds = Int(context.date.timeIntervalSince(started))
                        Text(ShannonVoiceCallDuration.text(seconds: seconds))
                            .font(.shannonDesktop(.caption).monospacedDigit())
                            .foregroundStyle(.secondary)
                            .accessibilityLabel(ShannonVoiceCallDuration.accessibilityText(seconds: seconds))
                    }
                }
                Spacer(minLength: ShannonDesktopSpacing.small)
                switch presentation.inputIndicator {
                case .level:
                    ShannonGeminiLiveLevelBar(level: session.audioLevel, phase: session.phase, palette: palette)
                case .muted:
                    Image(systemName: "mic.slash.fill").foregroundStyle(.secondary).accessibilityHidden(true)
                case .none:
                    EmptyView()
                }
                Text(presentation.title)
                    .font(.shannonDesktop(.callout).weight(.semibold))
                    .accessibilityIdentifier("voice-call-status")
            }
            if let detail = presentation.detail {
                Text(detail)
                    .font(.shannonDesktop(.caption))
                    .foregroundStyle(detailColor(presentation.detailTone, palette))
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityHint(ShannonGeminiLiveStatusPresentation.diagnosticsHint(
            provider: session.speechProvider.japaneseName, model: session.model, voice: session.voice))
        .help(ShannonGeneratedStrings.voiceMacEndsWithWindow)
    }

    @ViewBuilder
    private var subtitles: some View {
        let lines = ShannonGeminiLiveSubtitles(
            speakerName: session.participantMode.transcriptSpeakerName,
            userTranscript: session.userTranscript, shannonTranscript: session.shannonTranscript
        )
        if !lines.isEmpty {
            VStack(alignment: .leading, spacing: 2) {
                if let user = lines.user {
                    Text(user).font(.shannonDesktop(.callout)).foregroundStyle(.secondary).lineLimit(2).truncationMode(.head)
                }
                if let shannon = lines.shannon {
                    Text("\(ShannonGeneratedStrings.appName)：\(shannon)").font(.shannonDesktop(.body)).lineLimit(2).truncationMode(.head)
                }
            }
            .textSelection(.enabled)
        }
    }

    @ViewBuilder
    private var recovery: some View {
        HStack(spacing: ShannonDesktopSpacing.small) {
            switch session.failureRecovery {
            case .openSettings:
                Button(ShannonGeneratedStrings.voiceMacOpenSystemSettings) {
                    if let url = Self.microphonePrivacySettingsURL { openURL(url) }
                }
                .buttonStyle(.borderedProminent)
            case .updateRequired:
                EmptyView()
            case .reconnect, .none:
                Button(ShannonGeneratedStrings.voiceMacRetry) { Task { await session.retry() } }
                    .buttonStyle(.borderedProminent)
                    .help(ShannonGeneratedStrings.voiceMacRetryHint)
            }
        }
    }

    static let microphonePrivacySettingsURL = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone")

    private func textRetry(text: String, message: String) -> some View {
        VStack(alignment: .leading, spacing: ShannonDesktopSpacing.extraSmall) {
            Label(message, systemImage: "arrow.counterclockwise.circle")
                .font(.shannonDesktop(.callout))
                .foregroundStyle(Color.shannonAttention)
            Text(text).font(.shannonDesktop(.callout)).textSelection(.enabled)
            Button(ShannonGeneratedStrings.voiceMacTextResend) { _ = session.retryText() }
                .disabled(session.textSendState.isSending)
        }
    }

    /// Work asked for in this call, in its Talk: a proposal to look at, or the work going on.
    private var voiceTask: ShannonAgentTask? {
        guard session.participantMode == .owner, let threadID = call.threadID else { return nil }
        return conversation.agentTasks.first { $0.conversationThreadID == threadID && !$0.status.isTerminal }
    }

    private func taskRow(_ task: ShannonAgentTask) -> some View {
        Button { openTask(task.id) } label: {
            HStack(spacing: ShannonDesktopSpacing.small) {
                Image(systemName: task.status.symbolName)
                VStack(alignment: .leading, spacing: 1) {
                    Text(task.status == .proposed ? ShannonGeneratedStrings.voiceMacTaskProposed : task.stateName)
                        .font(.shannonDesktop(.caption).weight(.semibold))
                    Text(task.title).font(.shannonDesktop(.callout)).lineLimit(1)
                }
                Spacer(minLength: ShannonDesktopSpacing.small)
                Text(task.status == .proposed ? ShannonGeneratedStrings.voiceMacTaskReview : ShannonGeneratedStrings.voiceMacTaskOpen)
                    .font(.shannonDesktop(.caption))
                Image(systemName: "arrow.right").accessibilityHidden(true)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.bordered)
        .help(ShannonGeneratedStrings.voiceMacTaskHint)
    }

    private func workspaceBinding<Value>(_ path: ReferenceWritableKeyPath<ShannonVoiceWorkspaceState, Value>) -> Binding<Value> {
        let workspace = workspace
        return Binding(get: { workspace[keyPath: path] }, set: { workspace[keyPath: path] = $0 })
    }

    private func choosePhoto(_ source: ShannonDesktopVoicePhotoSource) {
        guard call.canSharePhoto else {
            showsPhotoUnavailable = true
            return
        }
        switch source {
        case .camera: call.requestCamera()
        case .library: workspace.showsPhotoLibrary = true
        case .file: importsPhotoFile = true
        }
    }

    private func detailColor(_ tone: ShannonGeminiLiveStatusPresentation.DetailTone, _ palette: ShannonPalette) -> Color {
        switch tone {
        case .secondary: palette.textSecondary
        case .attention: palette.onAttentionTint
        case .danger: palette.onDangerTint
        }
    }
}

enum ShannonDesktopVoicePhotoSource {
    case camera, library, file
}

/// The photo waiting to be shared, with 共有, 撮り直す／選び直す and 外す, or what went wrong with it.
struct ShannonDesktopVoicePhotoRow: View {
    let call: ShannonDesktopVoiceCall

    var body: some View {
        let workspace = call.workspace
        if let image = workspace.pendingCameraImage, workspace.pendingCameraData != nil {
            HStack(spacing: ShannonDesktopSpacing.medium) {
                Image(nsImage: image)
                    .resizable()
                    .scaledToFill()
                    .frame(width: 64, height: 64)
                    .clipShape(RoundedRectangle(cornerRadius: ShannonDesktopRadius.small))
                    .accessibilityLabel(ShannonGeneratedStrings.voiceMacPhotoPending)
                VStack(alignment: .leading, spacing: 2) {
                    Text(ShannonGeneratedStrings.voiceMacPhotoOnlyThis).font(.shannonDesktop(.callout))
                    Text(ShannonGeneratedStrings.voiceMacPhotoBack).font(.shannonDesktop(.caption)).foregroundStyle(.secondary)
                }
                Spacer(minLength: ShannonDesktopSpacing.small)
                Button(ShannonGeneratedStrings.voiceMacPhotoRemove, action: call.clearPendingPhoto)
                Button(workspace.pendingPhotoFromLibrary ? ShannonGeneratedStrings.voiceMacPhotoChooseAgain
                       : ShannonGeneratedStrings.voiceMacPhotoTakeAgain, action: call.choosePhotoAgain)
                Button(action: call.sharePendingPhoto) {
                    if workspace.isSharingCameraSnapshot { ProgressView().controlSize(.small) } else { Text(ShannonGeneratedStrings.voiceMacPhotoShare) }
                }
                .buttonStyle(.borderedProminent)
                .disabled(workspace.isSharingCameraSnapshot)
            }
        } else if workspace.isLoadingLibraryPhoto {
            ProgressView(ShannonGeneratedStrings.voiceMacPhotoPreparing).controlSize(.small)
        }
        if let message = workspace.cameraErrorMessage {
            Label(message, systemImage: "photo.badge.exclamationmark")
                .font(.shannonDesktop(.callout))
                .foregroundStyle(Color.shannonDanger)
        }
    }
}
#endif
