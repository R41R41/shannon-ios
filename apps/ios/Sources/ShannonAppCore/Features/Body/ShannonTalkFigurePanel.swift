#if os(macOS)
import SwiftUI

/// Her figure beside the conversation on a wide screen (docs/product/information-architecture.md 3;
/// roadmap A15): the third auxiliary panel 「すがた」 of the Mac's Talk, switched with 目次 and 現在地.
/// The form the owner chose stands here: the Live2D figure (touchable in place with the pointer,
/// pinch or ⌘-scroll for her size, scroll to move her) or the Waterlight Eye, which also stands in
/// while the page loads. Under her, 「いま：〈気持ち〉・〈していること〉」. Her display options (form,
/// body, 映し方, 位置を戻す) are in the panel's menu, as in the iPhone's display menu, and in 設定 › すがた.
/// During a voice conversation (A16) her figure follows the call: listening, thinking and speaking, with the
/// feeling of each turn, as the iPhone's call screen shows them.
public struct ShannonTalkFigurePanel: View {
    private let conversation: ShannonConversationModel
    private let memory: ShannonMemoryModel
    private let voice: ShannonGeminiLiveSessionModel?

    @AppStorage(ShannonForm.storageKey) private var formRawValue = ShannonForm.waterlight.rawValue
    @AppStorage(ShannonLive2DBody.storageKey) private var bodyRawValue = ShannonLive2DBody.human.rawValue
    @AppStorage(ShannonBodyPreference.layoutModeKey) private var layoutModeRawValue = ShannonLive2DLayout.Mode.full.rawValue
    @State private var activity: ShannonDialogueActivity = .idle
    @State private var waterlightReaction = 0
    /// The figure's size, read beside it: no GeometryReader pins a frame inside the Mac's inspector (DesktopWidthAdaptive).
    @State private var figureSize = CGSize.zero
    @Environment(ShannonBodyModel.self) private var bodyModel: ShannonBodyModel?
    @Environment(\.colorScheme) private var colorScheme

    public init(conversation: ShannonConversationModel, memory: ShannonMemoryModel, voice: ShannonGeminiLiveSessionModel? = nil) {
        self.conversation = conversation
        self.memory = memory
        self.voice = voice
    }

    /// The call's phase while a call is on, otherwise what the text conversation is doing.
    private var shownActivity: ShannonDialogueActivity {
        guard let voice, voice.phase != .idle else { return activity }
        return Self.callActivity(voice.phase)
    }

    /// The same eyes as the iPhone's call screen for each phase of the call.
    static func callActivity(_ phase: ShannonGeminiLivePhase) -> ShannonDialogueActivity {
        switch phase {
        case .listening: .listening
        case .thinking, .connecting, .reconnecting: .thinking
        case .speaking: .speaking
        case .idle, .requestingPermission, .failed: .idle
        }
    }

    private var usesLive2D: Bool { formRawValue == ShannonForm.live2d.rawValue && ShannonLive2DStage.isAvailable }
    private var face: ShannonFace { bodyModel?.face ?? conversation.presentFace }

    public var body: some View {
        let palette = ShannonPalette.resolve(colorScheme)
        VStack(spacing: ShannonSpacing.small) {
            HStack {
                Spacer(minLength: 0)
                Menu {
                    displayOptions
                } label: {
                    Label(ShannonBodyCopy.formTitle, systemImage: "slider.horizontal.3")
                        .labelStyle(.iconOnly)
                }
                .menuStyle(.borderlessButton)
                .fixedSize()
                .help(ShannonGeneratedStrings.talkFigurePanelMenuHint)
                .accessibilityLabel(ShannonBodyCopy.formTitle)
                .accessibilityHint(ShannonGeneratedStrings.talkFigurePanelMenuHint)
                .accessibilityIdentifier("talk-figure-menu")
            }
            .padding(.horizontal, ShannonSpacing.medium)

            figure
                .frame(maxWidth: .infinity, maxHeight: .infinity)

            Text(ShannonBodyCopy.nowLine(face: face, doing: bodyModel?.doingLine))
                .font(.shannon(.callout))
                .foregroundStyle(palette.textSecondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, ShannonSpacing.medium)
                .frame(minHeight: 32)
                .background(.thinMaterial, in: Capsule())
                .padding(.horizontal, ShannonSpacing.large)
                .accessibilityIdentifier("body-now-line")
        }
        .padding(.vertical, ShannonSpacing.medium)
        .background(
            LinearGradient(
                colors: [palette.canvas, palette.intelligenceSoft.opacity(colorScheme == .dark ? 0.42 : 0.56), palette.canvas],
                startPoint: .top, endPoint: .bottom
            )
        )
        .onAppear { activity = conversation.isSending ? .thinking : .idle }
        .onChange(of: conversation.isSending) { _, isSending in
            activity = isSending ? .thinking : (conversation.errorMessage == nil ? .speaking : .failed)
        }
        .task(id: activity) {
            guard activity == .speaking else { return }
            try? await Task.sleep(for: .seconds(1.8))
            guard !Task.isCancelled, !conversation.isSending else { return }
            activity = .idle
        }
        .onChange(of: layoutModeRawValue) { bodyModel?.figureAdjustment = ShannonLive2DLayout() }
        // What she is doing in her own time, read while her figure is shown, as on the iPhone.
        .task {
            while !Task.isCancelled {
                await memory.autonomy.refreshQuietly()
                await memory.autonomy.study.refreshQuietly()
                try? await Task.sleep(for: .seconds(30))
            }
        }
    }

    @ViewBuilder
    private var figure: some View {
        if usesLive2D {
            ShannonDialogueFigure(face: face, activity: shownActivity)
        } else {
            Button {
                waterlightReaction &+= 1
            } label: {
                ShannonWaterlightEyeView(
                    expression: face.expression, activity: shownActivity,
                    size: min(figureSize.width * 0.72, figureSize.height * 0.8, 280),
                    reactionTrigger: waterlightReaction, feeling: face.feeling
                )
            }
            .buttonStyle(.plain)
            .accessibilityLabel(face.accessibilityDescription)
            .accessibilityHint("触れると表情が変わります")
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .onGeometryChange(for: CGSize.self) { $0.size } action: { size in
                if size != figureSize { figureSize = size }
            }
        }
    }

    /// The same options as the iPhone's display menu.
    @ViewBuilder
    private var displayOptions: some View {
        Picker(ShannonBodyCopy.formTitle, selection: $formRawValue) {
            ForEach(ShannonForm.allCases) { form in
                Text(form.japaneseName).tag(form.rawValue)
            }
        }
        .pickerStyle(.inline)
        if usesLive2D {
            if ShannonLive2DStage.shared.offersEyes {
                Picker(ShannonBodyCopy.bodyTitle, selection: ShannonLive2DBody.selection($bodyRawValue)) {
                    ForEach(ShannonLive2DBody.allCases) { body in
                        Text(body.japaneseName).tag(body.rawValue)
                    }
                }
                .pickerStyle(.inline)
            }
            if ShannonLive2DBody.displayed(rawValue: bodyRawValue).hasCharacterRig {
                Picker(ShannonBodyCopy.layoutTitle, selection: $layoutModeRawValue) {
                    Text(ShannonBodyCopy.layoutFull).tag(ShannonLive2DLayout.Mode.full.rawValue)
                    Text(ShannonBodyCopy.layoutBust).tag(ShannonLive2DLayout.Mode.bust.rawValue)
                }
                .pickerStyle(.inline)
            }
            Button {
                bodyModel?.figureAdjustment = ShannonLive2DLayout()
            } label: {
                Label(ShannonBodyCopy.resetLayout, systemImage: "arrow.uturn.backward")
            }
            .disabled(!(bodyModel?.figureAdjustment.isMoved ?? false))
        }
    }
}

public extension View {
    /// Keeps her figure and the body model in step with the conversation and the voice conversation, and lets a
    /// touch reach her (the Mac's window; the iPhone's conversation root attaches the same itself). After her line
    /// for a touch was said aloud, the Mac's call listens for his answer (A16), as the iPhone's does.
    func shannonBodyAttachment(
        _ bodyModel: ShannonBodyModel, conversation: ShannonConversationModel, memory: ShannonMemoryModel,
        voiceCall: ShannonDesktopVoiceCall
    ) -> some View {
        modifier(ShannonBodyAttachment(
            bodyModel: bodyModel, conversation: conversation, memory: memory, voice: voiceCall.session,
            listen: voiceCall.bodyListen(answersInVoice: { [weak bodyModel] in bodyModel?.answersInVoice ?? false })
        ))
    }
}

public extension ShannonBodyModel {
    /// Her figure is what the owner sees now and nothing covers it (the Mac: Talk with the 「すがた」 panel open).
    func setFigureIsInFront(_ inFront: Bool) {
        if dialogueIsInFront != inFront { dialogueIsInFront = inFront }
    }
}
#endif
