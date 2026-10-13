import SwiftUI
// The iPhone's dialogue display. The Mac shows its own Talk, and this stage pins frames with a GeometryReader
// around the Live2D host, which the Mac must not do (scripts/check-architecture.mjs), so it is iPhone-only.
#if os(iOS)
import UIKit

extension ShannonConversationView {
    /// The dialogue display is where her figure lives (decision 2026-10-03: からだ is a display of Talk).
    /// The Live2D form: her figure on top, large and touchable in place, the line of what she feels and
    /// does under her, then the last words. The Waterlight form keeps the stage as it was.
    var dialogueShowsLive2D: Bool { ShannonPersonaPreset.form(legacy: formRawValue, preset: presetRawValue) == .live2d }

    func dialogueStage(_ palette: ShannonPalette) -> some View {
        GeometryReader { stage in
            ZStack(alignment: .top) {
                dialogueBackground(palette, size: stage.size)
                if dialogueShowsLive2D {
                    live2DDialogue(palette, stage: stage)
                } else {
                    VStack(spacing: 0) {
                        // The camera's state, always there over the dialogue display (A7): 切／見てよい／いま見ています.
                        HStack {
                            Spacer(minLength: 0)
                            ShannonAppLookStateBadge(coordinator: model.appLook, othersPresent: cameraOthersPresent)
                        }
                        .padding(.horizontal, ShannonSpacing.large)
                        .padding(.top, ShannonSpacing.extraSmall)
                        // A song she chose, while it plays (docs/device-actions-contract.md).
                        ShannonNowPlayingCard()
                            .padding(.horizontal, ShannonSpacing.large)
                        GeometryReader { geometry in
                            waterlightDialogue(palette, geometry: geometry)
                                .contentShape(Rectangle())
                                .onTapGesture { composerIsFocused = false }
                        }
                    }
                }
            }
        }
        .onAppear { dialogueActivity = model.isSending ? .thinking : .idle }
        .onChange(of: model.isSending) { _, isSending in
            if isSending {
                dialogueActivity = .thinking
                // He sent something: she answers large (option C).
                setDialogueReads(after: .ownerSent)
            } else {
                dialogueActivity = model.errorMessage == nil ? .speaking : .failed
            }
        }
        .task(id: dialogueActivity) {
            guard dialogueActivity == .speaking else { return }
            try? await Task.sleep(for: .seconds(1.8))
            guard !Task.isCancelled, !model.isSending else { return }
            dialogueActivity = .idle
        }
        .onChange(of: model.messages.count) { dialogueIsExpanded = false }
        .onChange(of: model.selectedThreadId) { setDialogueReads(after: .threadChanged) }
        .onChange(of: dialogueCallIsLive) { setDialogueReads(after: .callChanged) }
#if DEBUG
        .onAppear { if ProcessInfo.processInfo.arguments.contains("-ShannonPreviewDialogueRead") { dialogueReads = true } }
#endif
    }

    private func dialogueBackground(_ palette: ShannonPalette, size: CGSize) -> some View {
        ZStack {
            LinearGradient(
                colors: [
                    palette.canvas,
                    palette.intelligenceSoft.opacity(colorScheme == .dark ? 0.42 : 0.56),
                    palette.canvas
                ],
                startPoint: .top,
                endPoint: .bottom
            )
            .ignoresSafeArea()

            Circle()
                .fill(palette.intelligenceGradient)
                .opacity(colorScheme == .dark ? 0.18 : 0.12)
                .frame(width: size.width * 1.28, height: size.width * 1.28)
                .blur(radius: 42)
                .position(x: size.width / 2, y: size.height * 0.50)
        }
        // Taps on the empty stage put the keyboard away; a finger on her figure stays hers.
        .contentShape(Rectangle())
        .onTapGesture { composerIsFocused = false }
    }

    // MARK: The Live2D form (option C, owner pick 2026-10-13)

    /// A voice conversation runs (also the few seconds she listens after her line for a touch).
    var dialogueCallIsLive: Bool { geminiLiveVoiceModel.phase != .idle }

    /// Talk, read or call: see `ShannonDialogueStage`.
    var dialogueStageNow: ShannonDialogueStage {
        ShannonDialogueStage.resolve(callIsLive: dialogueCallIsLive, reads: dialogueReads)
    }

    /// Size changes are animated without a bounce; Reduce Motion only cross-fades.
    var dialogueStageAnimation: Animation {
        reduceMotion ? .easeOut(duration: 0.15) : .spring(duration: 0.45, bounce: 0)
    }

    func setDialogueReads(after event: ShannonDialogueStage.Event) {
        let reads = ShannonDialogueStage.reads(after: event)
        guard reads != dialogueReads else { return }
        if reads { composerIsFocused = false }
        withAnimation(dialogueStageAnimation) { dialogueReads = reads }
    }

    private func live2DDialogue(_ palette: ShannonPalette, stage: GeometryProxy) -> some View {
        let current = dialogueStageNow
        // Her figure reaches up under the floating header: the stage's height counts the top safe area too.
        let topInset = stage.safeAreaInsets.top
        let figureHeight = (stage.size.height + topInset) * current.figureShare
        return ZStack(alignment: .top) {
            if current.drawsLive2D {
                // One figure for talk and call: only its frame changes, so the Live2D host stays the same.
                dialogueFigureLayer(height: figureHeight, topInset: topInset, stage: current)
                    .transition(reduceMotion ? AnyTransition.opacity : AnyTransition.scale(scale: 0.12, anchor: .topTrailing).combined(with: .opacity))
            }
            switch current {
            case .talk:
                dialogueTalkWords(palette, stage: stage, figureBottom: max(0, figureHeight - topInset))
                    .transition(.opacity)
            case .read:
                messageList(palette)
                    .contentMargins(.top, ShannonDialogueStage.cornerFaceSize + ShannonSpacing.medium, for: .scrollContent)
                    .transition(.opacity)
                dialogueCornerFace
                    .transition(reduceMotion ? AnyTransition.opacity : AnyTransition.scale(scale: 3, anchor: .topTrailing).combined(with: .opacity))
            case .call:
                dialogueCallSubtitles(palette)
                    .transition(.opacity)
            }
            if current.drawsLive2D {
                // The camera's state as a small eye on her, under the header (切／見てよい／いま見ています).
                ShannonAppLookEyeBadge(coordinator: model.appLook, othersPresent: cameraOthersPresent)
                    .frame(maxWidth: .infinity, alignment: .trailing)
                    .padding(.trailing, ShannonSpacing.large)
                    .padding(.top, ShannonSpacing.small)
                    .transition(.opacity)
            }
        }
        .animation(dialogueStageAnimation, value: current)
        // What she is doing in her own time, read as the body screen read it while her figure is in front.
        .task(id: scenePhase == .active) {
            guard scenePhase == .active else { return }
            while !Task.isCancelled {
                await memoryModel.autonomy.refreshQuietly()
                await memoryModel.autonomy.study.refreshQuietly()
                try? await Task.sleep(for: .seconds(30))
            }
        }
    }

    /// Her upper body (上半身), large, from the top of the screen under the floating header. Her mood is her
    /// expression (VoiceOver reads it on the figure): no pill.
    private func dialogueFigureLayer(height: CGFloat, topInset: CGFloat, stage: ShannonDialogueStage) -> some View {
        let face = stage == .call ? (geminiLiveVoiceModel.callFace ?? model.currentFace) : model.currentFace
        let activity = stage == .call ? dialogueCallActivity : dialogueActivity
        return ShannonDialogueFigure(face: face, activity: activity, framing: .bust, topInset: topInset)
            .frame(maxWidth: .infinity)
            .frame(height: height)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
            .ignoresSafeArea(.container, edges: .top)
    }

    /// The owner's last line and her reply, under her and over the lower part of her figure. Pulling the words
    /// down (scrolling back) or 「会話全体を読む」 opens the whole conversation.
    private func dialogueTalkWords(_ palette: ShannonPalette, stage: GeometryProxy, figureBottom: CGFloat) -> some View {
        VStack(spacing: ShannonSpacing.small) {
            Spacer(minLength: min(figureBottom * 0.72, stage.size.height * 0.5))
            ShannonNowPlayingCard()
                .padding(.horizontal, ShannonSpacing.large)
            if model.messages.count > 2 {
                Button { setDialogueReads(after: .scrolledBack) } label: {
                    Label("これまでの会話", systemImage: "chevron.up")
                        .font(.shannon(.caption).weight(.medium))
                        .foregroundStyle(palette.textSecondary)
                        .frame(minHeight: ShannonTouchTarget.minimum)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityHint("会話全体を読みます。シャノンは右上の顔になります。")
                .accessibilityIdentifier("dialogue-read-history")
            }
            dialogueUserLine(palette)
            dialogueReply(palette, geometry: stage)
        }
        .padding(.bottom, ShannonSpacing.small)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottom)
        .simultaneousGesture(
            DragGesture(minimumDistance: 24).onEnded { value in
                if ShannonDialogueStage.isScrollBack(translation: value.translation) { setDialogueReads(after: .scrolledBack) }
            }
        )
    }

    /// While he reads: a still close-up of her face (the expression pictures; the Live2D page is not drawn), with
    /// the camera's eye on it. A tap brings her back large.
    private var dialogueCornerFace: some View {
        Button { setDialogueReads(after: .tappedFace) } label: {
            ShannonMessageFaceCloseUp(face: model.currentFace, size: ShannonDialogueStage.cornerFaceSize)
                .overlay { Circle().strokeBorder(ShannonPalette.resolve(colorScheme).intelligenceSky, lineWidth: 2) }
                .shadow(color: .black.opacity(0.18), radius: 8, y: 3)
                .overlay(alignment: .bottomTrailing) {
                    ShannonAppLookEyeBadge(coordinator: model.appLook, othersPresent: cameraOthersPresent, diameter: 22)
                        .offset(x: 4, y: 4)
                }
                .frame(minWidth: ShannonTouchTarget.minimum, minHeight: ShannonTouchTarget.minimum)
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(model.currentFace.accessibilityDescription)
        .accessibilityHint("シャノンを大きく表示します")
        .accessibilityIdentifier("dialogue-corner-face")
        .frame(maxWidth: .infinity, alignment: .trailing)
        .padding(.trailing, ShannonSpacing.large)
        .padding(.top, ShannonSpacing.extraSmall)
    }

    /// Her state in the call, as the call screen reads it.
    var dialogueCallActivity: ShannonDialogueActivity {
        switch geminiLiveVoiceModel.phase {
        case .listening: .listening
        case .thinking, .connecting, .reconnecting: .thinking
        case .speaking: .speaking
        case .idle, .requestingPermission, .failed: .idle
        }
    }

    /// The last words of each side, as the call screen shows them, under her.
    private func dialogueCallSubtitles(_ palette: ShannonPalette) -> some View {
        let lines = ShannonGeminiLiveSubtitles(
            speakerName: geminiLiveVoiceModel.participantMode.transcriptSpeakerName,
            userTranscript: geminiLiveVoiceModel.userTranscript,
            shannonTranscript: geminiLiveVoiceModel.shannonTranscript
        )
        let lineLimit = dynamicTypeSize.isAccessibilitySize ? 4 : 2
        return VStack(spacing: ShannonSpacing.extraSmall) {
            Spacer(minLength: 0)
            if !lines.isEmpty {
                VStack(spacing: ShannonSpacing.extraSmall) {
                    if let user = lines.user {
                        Text(user)
                            .font(.shannon(.callout))
                            .foregroundStyle(palette.textSecondary)
                            .lineLimit(lineLimit)
                            .truncationMode(.head)
                    }
                    if let shannon = lines.shannon {
                        Text(shannon)
                            .font(.shannon(.body))
                            .lineLimit(lineLimit)
                            .truncationMode(.head)
                    }
                }
                .multilineTextAlignment(.center)
                .padding(.horizontal, ShannonSpacing.medium)
                .padding(.vertical, ShannonSpacing.small)
                .frame(maxWidth: 560)
                .modifier(ShannonFloatingComposerSurface(cornerRadius: ShannonShape.extraLarge))
                .padding(.horizontal, ShannonSpacing.large)
                .accessibilityElement(children: .combine)
            }
        }
        .padding(.bottom, ShannonSpacing.small)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottom)
    }

    /// The call's own controls (写真, 本人だけ／友人も一緒, マイク, 文字, 終了) in place of the composer. マイク and 終了
    /// act here; the others open the call screen with that choice, where its sheets and pickers live.
    func dialogueCallControls(_ palette: ShannonPalette) -> some View {
        let voice = geminiLiveVoiceModel
        return ShannonGeminiLiveCallControls(
            isMuted: voice.isMicrophoneMuted,
            inputState: voice.inputState,
            participantMode: voice.participantMode,
            isPhotoBusy: voiceWorkspace.isSharingCameraSnapshot || voiceWorkspace.isLoadingLibraryPhoto,
            showsTextComposer: false,
            palette: palette,
            choosePhoto: {
                if voice.participantMode.allowsCameraSharing { voiceWorkspace.showsPhotoSource = true }
                else { voiceWorkspace.showsPhotoUnavailable = true }
                showsGeminiLiveVoice = true
            },
            chooseParticipant: { voiceWorkspace.showsParticipantModePicker = true; showsGeminiLiveVoice = true },
            toggleMute: voice.toggleMicrophoneMute,
            selectInput: { voice.selectInput($0) },
            showInputPicker: { voiceWorkspace.showsInputPicker = true; showsGeminiLiveVoice = true },
            toggleTextComposer: { voiceWorkspace.showsTextComposer = true; showsGeminiLiveVoice = true },
            end: { voiceWorkspace.endCall(geminiLiveVoiceModel) }
        )
        .padding(.horizontal, ShannonSpacing.large)
        .padding(.vertical, ShannonSpacing.small)
        .accessibilityIdentifier("dialogue-call-controls")
    }

    /// The composer's call button in the Live2D dialogue display starts the conversation here, with her filling the
    /// screen, when the microphone is already allowed; otherwise (the permission explanation, a design preview)
    /// the call screen opens as before. The call itself is the same `beginCall` the call screen uses.
    func startCallInDialogue() -> Bool {
        guard usesGirlDialogue, !model.isDesignPreview,
              ShannonMediaPermission.currentMicrophone() == .granted,
              geminiLiveVoiceModel.phase == .idle || geminiLiveVoiceModel.phase == .failed else { return false }
        let provider = ShannonPersonaPreset.provider(legacy: speechProviderRawValue, preset: presetRawValue)
        _ = voiceWorkspace.beginCall(
            mode: .owner, speechProvider: provider, threadID: model.selectedThreadId,
            conversationModel: model, geminiVoiceModel: geminiLiveVoiceModel
        )
        setDialogueReads(after: .callChanged)
        return true
    }

    // MARK: The Waterlight form

    private func waterlightDialogue(_ palette: ShannonPalette, geometry: GeometryProxy) -> some View {
        let keyboardScale: CGFloat = composerIsFocused ? 0.84 : 1
        let hasReply = model.messages.contains(where: { $0.role == .shannon })
        let faceScale: CGFloat = hasReply ? 0.44 : 0.70
        let faceLimit: CGFloat = hasReply ? 190 : 292
        let faceSize = min(geometry.size.width * faceScale, faceLimit) * keyboardScale

        return ZStack(alignment: .top) {
            ShannonBodyView(
                expression: model.currentExpression,
                activity: dialogueActivity,
                size: faceSize,
                feeling: model.currentFace.feeling
            )
                .shadow(color: palette.brandPresence.opacity(0.14), radius: 28, y: 10)
                .position(
                    x: geometry.size.width / 2,
                    y: geometry.size.height * (composerIsFocused ? 0.70 : 0.74)
                )
                .animation(reduceMotion ? nil : .easeInOut(duration: 0.24), value: composerIsFocused)

            VStack(spacing: ShannonSpacing.small) {
                if !dynamicTypeSize.isAccessibilitySize {
                    HStack(spacing: 6) {
                        Text("シャノン")
                            .font(.shannon(.callout).weight(.semibold))
                        Text("·")
                        Text(model.currentFace.japaneseName)
                    }
                    .foregroundStyle(palette.textSecondary)
                    .padding(.horizontal, ShannonSpacing.medium)
                    .frame(minHeight: 32)
                    .background(.thinMaterial, in: Capsule())
                    .accessibilityElement(children: .combine)
                    .accessibilityLabel(model.currentFace.accessibilityDescription)
                }
                dialogueUserLine(palette)
                dialogueReply(palette, geometry: geometry)
                Spacer(minLength: 0)
            }
            .padding(.top, ShannonSpacing.large)
            .padding(.bottom, ShannonSpacing.large)
        }
    }

    // MARK: The words

    /// The reply's height: the words' own height up to `limit`; the limit until the words are measured.
    func dialogueReplyHeight(limit: CGFloat) -> CGFloat {
        dialogueReplyContentHeight > 0 ? min(dialogueReplyContentHeight, limit) : limit
    }

    @ViewBuilder
    private func dialogueUserLine(_ palette: ShannonPalette) -> some View {
        if !dynamicTypeSize.isAccessibilitySize, let userMessage = latestUserMessage {
            Text("あなた：\(userMessage.text)")
                .font(.shannon(.caption))
                .foregroundStyle(palette.textSecondary)
                .lineLimit(2)
                .padding(.horizontal, ShannonSpacing.medium)
                .frame(maxWidth: 330, minHeight: 30, alignment: .trailing)
                .background(.ultraThinMaterial, in: Capsule())
                .frame(maxWidth: .infinity, alignment: .trailing)
                .padding(.horizontal, ShannonSpacing.large)
        }
    }

    @ViewBuilder
    private func dialogueReply(_ palette: ShannonPalette, geometry: GeometryProxy) -> some View {
        if model.isSending, let streaming = model.visibleStreamingReply {
            ShannonDialogueStreamingBubble(text: streaming.text, palette: palette, maxWidth: min(560, geometry.size.width - 32))
                .transition(.opacity)
        } else if model.isSending {
            ShannonDialogueBubble(palette: palette, isExpanded: false) {
                ShannonThinkingDots()
            }
            .transition(.opacity)
        } else if let reply = model.messages.last(where: { $0.role == .shannon }) {
            let replyLimit = dialogueIsExpanded
                ? min(360, geometry.size.height * 0.48)
                : (dynamicTypeSize.isAccessibilitySize ? 180 : 156)
            let replyOverflows = dialogueReplyContentHeight > (dynamicTypeSize.isAccessibilitySize ? 180 : 156) + 1
            ShannonDialogueBubble(
                palette: palette,
                isExpanded: dialogueIsExpanded,
                maxWidth: min(560, geometry.size.width - 32)
            ) {
                VStack(alignment: .leading, spacing: ShannonSpacing.extraSmall) {
                    // The bubble is as tall as the words up to a limit; past it the words scroll inside and fade at
                    // the edge, with 「続きを読む」. A fixed frame around an unscrollable view cut a line in half
                    // and left empty space (owner feedback).
                    ScrollView(.vertical) {
                        VStack(alignment: .leading, spacing: ShannonSpacing.extraSmall) {
                            ShannonRichMarkdownText(source: reply.text, palette: palette)
                                .textSelection(.enabled)
                            if ShannonTurnCaptureList.hasContent(reply) {
                                ShannonTurnCaptureList(message: reply, conversation: model, memory: memoryModel)
                            }
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { height in
                            dialogueReplyContentHeight = height
                        }
                    }
                    .scrollIndicators(dialogueIsExpanded ? .automatic : .hidden)
                    .scrollBounceBehavior(.basedOnSize)
                    .frame(height: dialogueReplyHeight(limit: replyLimit))
                    .mask {
                        LinearGradient(
                            stops: [
                                .init(color: .black, location: 0),
                                .init(color: .black, location: replyOverflows && !dialogueIsExpanded ? 0.82 : 1),
                                .init(color: .black.opacity(replyOverflows && !dialogueIsExpanded ? 0 : 1), location: 1),
                            ],
                            startPoint: .top,
                            endPoint: .bottom
                        )
                    }

                    HStack(spacing: ShannonSpacing.extraSmall) {
                        if replyOverflows || dialogueIsExpanded {
                            Button {
                                withAnimation(reduceMotion ? nil : .snappy(duration: 0.24)) {
                                    dialogueIsExpanded.toggle()
                                }
                            } label: {
                                Label(
                                    dialogueIsExpanded ? "閉じる" : "続きを読む",
                                    systemImage: dialogueIsExpanded ? "chevron.up" : "chevron.down"
                                )
                                .font(.shannon(.caption2).weight(.medium))
                            }
                            .buttonStyle(.plain)
                            .foregroundStyle(palette.textSecondary)
                        }
                        Spacer(minLength: 0)
                        Button {
                            copyDialogueReply(reply.text)
                        } label: {
                            Group {
                                if dynamicTypeSize.isAccessibilitySize {
                                    Image(systemName: dialogueDidCopy ? "checkmark" : "doc.on.doc")
                                } else {
                                    Label(
                                        dialogueDidCopy ? "コピー済み" : "コピー",
                                        systemImage: dialogueDidCopy ? "checkmark" : "doc.on.doc"
                                    )
                                }
                            }
                            .font(.shannon(.caption2).weight(.semibold))
                            .frame(
                                minWidth: ShannonTouchTarget.minimum,
                                minHeight: ShannonTouchTarget.minimum
                            )
                        }
                        .buttonStyle(.plain)
                        .foregroundStyle(palette.textSecondary)
                        .accessibilityLabel(dialogueDidCopy ? "コピーしました" : "シャノンの回答をコピー")
                    }
                    Button {
                        if dialogueShowsLive2D { setDialogueReads(after: .scrolledBack) } else { toggleDisplayMode() }
                    } label: {
                        Label("会話全体を読む", systemImage: "text.bubble")
                            .font(.shannon(.caption).weight(.semibold))
                            .frame(minHeight: ShannonTouchTarget.minimum)
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(palette.action)
                }
            }
            .transition(.opacity.combined(with: .move(edge: .top)))
        }
    }
}
#endif
