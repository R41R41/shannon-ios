import SwiftUI
#if canImport(UIKit)
import UIKit
#elseif canImport(AppKit)
import AppKit
#endif
extension ShannonConversationView {
    /// Talk shows no title: its controls float over the conversation (owner feedback, TestFlight 243). The other
    /// pages keep their names.
    var workspaceNavigationTitle: String {
        guard selectedPage == .talk else { return selectedPage.title }
        return ""
    }

    @ToolbarContentBuilder
    var workspaceToolbar: some ToolbarContent {
        ToolbarItem(placement: .navigation) {
            Button(action: openThreadList) {
                Image(systemName: "sidebar.left")
                    .modifier(ShannonFloatingToolbarGlyph())
            }
            .accessibilityLabel("トークと画面を開く")
            .accessibilityValue(ShannonEntryMarks.accessibilityValue(
                unread: model.totalBadgeCount,
                waiting: ShannonEntryMarks.waitingNotUnread(
                    yousu.now.waiting(approvals: yousuApprovals), unreadTaskIDs: model.unreadAgentTaskIDs),
                opsAttention: yousu.ops.attentionReason()
            ))
            .overlay(alignment: .topTrailing) {
                if model.totalBadgeCount > 0 || shannonWaitingCount > 0 {
                    Circle()
                        .fill(ShannonPalette.resolve(resolvedColorScheme).danger)
                        .frame(width: 8, height: 8)
                        .accessibilityHidden(true)
                }
            }
            .overlay(alignment: .bottomTrailing) {
                if yousu.needsAttention {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .font(.shannon(.caption2).weight(.bold))
                        .foregroundStyle(ShannonPalette.resolve(resolvedColorScheme).attention)
                        .offset(x: 4, y: 3)
                        .accessibilityHidden(true)
                }
            }
        }

        if selectedPage == .talk {
            ToolbarItemGroup(placement: .primaryAction) {
                // One tap switches the display, as before; a long press offers her figure's options
                // (her form, and in the Live2D form 映し方 and 位置を戻す). 設定 › すがた has the same.
                Menu {
                    Button(action: toggleDisplayMode) {
                        Label("\(displayMode.switchActionTitle)表示へ切り替える", systemImage: displayMode.switchActionSymbolName)
                    }
                    figureDisplayOptions
                } label: {
                    Image(systemName: displayMode.switchActionSymbolName)
                        .modifier(ShannonFloatingToolbarGlyph())
                } primaryAction: {
                    toggleDisplayMode()
                }
                .accessibilityLabel("\(displayMode.switchActionTitle)表示へ切り替える")
                .accessibilityHint(ShannonBodyCopy.displayMenuHint)
                .accessibilityIdentifier("talk-display-menu")

                Button(action: createThreadFromHeader) {
                    Image(systemName: "square.and.pencil")
                        .modifier(ShannonFloatingToolbarGlyph())
                }
                .accessibilityLabel(ShannonGeneratedStrings.talkNewThread)
            }
        }
    }

    /// Her form, and in the Live2D form her body (人の姿／目だけ), 映し方 (the character only) and 位置を戻す:
    /// Talk's display options (the long press of the display button).
    @ViewBuilder
    var figureDisplayOptions: some View {
        Picker(ShannonBodyCopy.formTitle, selection: ShannonPersonaPreset.formSelection($formRawValue)) {
            ForEach(ShannonForm.allCases) { form in
                Text(form.japaneseName).tag(form.rawValue)
            }
        }
        .pickerStyle(.menu)
        if ShannonPersonaPreset.form(legacy: formRawValue, preset: presetRawValue) == .live2d, ShannonLive2DStage.isAvailable {
            if ShannonLive2DStage.shared.offersEyes {
                Picker(ShannonBodyCopy.bodyTitle, selection: ShannonLive2DBody.selection(ShannonPersonaPreset.bodySelection($figureBodyRawValue))) {
                    ForEach(ShannonLive2DBody.allCases) { body in
                        Text(body.japaneseName).tag(body.rawValue)
                    }
                }
                .pickerStyle(.menu)
            }
            // Her eyes alone are not framed: the page sizes and places them only.
            // The iPhone's Talk frames her itself (上半身, option C of 2026-10-13): 映し方 is the Mac's.
#if !os(iOS)
            if ShannonLive2DBody.displayed(rawValue: ShannonPersonaPreset.body(legacy: figureBodyRawValue, preset: presetRawValue).rawValue).hasCharacterRig {
                Picker(ShannonBodyCopy.layoutTitle, selection: $figureLayoutRawValue) {
                    Text(ShannonBodyCopy.layoutFull).tag(ShannonLive2DLayout.Mode.full.rawValue)
                    Text(ShannonBodyCopy.layoutBust).tag(ShannonLive2DLayout.Mode.bust.rawValue)
                }
                .pickerStyle(.menu)
            }
#endif
            Button {
                bodyModel.figureAdjustment = ShannonLive2DLayout()
            } label: {
                Label(ShannonBodyCopy.resetLayout, systemImage: "arrow.uturn.backward")
            }
            .disabled(!bodyModel.figureAdjustment.isMoved)
        }
    }

    /// What waits for the owner: her stories, proposals and budget request, and work tasks that wait for a
    /// permission. The same list as the 「シャノン」 card and its tile (`ShannonNowModel.waiting(approvals:)`).
    var shannonWaitingCount: Int { yousu.now.waiting(approvals: yousuApprovals).count }

    func workspaceContent(_ palette: ShannonPalette) -> some View {
        Group {
            switch selectedPage {
            case .talk:
                talkPage(palette)
            case .work:
            ShannonAgentTaskOverviewView(model: model, openTask: openAgentTask)
            case .shannon:
                shannonHub
            }
        }
    }

    func talkPage(_ palette: ShannonPalette) -> some View {
        ZStack {
            Group {
                switch displayMode {
                case .scroll:
                    messageList(palette)
                case .dialogue:
#if os(iOS)
                    dialogueStage(palette)
#else
                    messageList(palette)
#endif
                }
            }

        }
        .safeAreaInset(edge: .top, spacing: 0) {
            VStack(spacing: 0) {
                // In the Live2D dialogue display 裏の作業 is part of the one line over the composer (option C).
                if !usesGirlDialogue {
                    ShannonActionThreadsCapsule(model: actionThreads)
                }
                if let task = model.latestAgentTaskNotice {
                    ShannonAgentTaskCapsule(
                        task: task,
                        actionError: model.agentTaskActionError(task.id),
                        open: { openAgentTask(task.id) },
                        approveOnce: { [requestID = task.pendingApproval?.externalRequestID] in
                            Task { await model.resolveAgentApproval(task.id, accepted: true, requestID: requestID) }
                        }
                    )
                    .padding(.bottom, ShannonSpacing.extraSmall)
                    .transition(.move(edge: .top).combined(with: .opacity))
                }
            }
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            VStack(spacing: ShannonSpacing.small) {
                if let statusMessage = model.statusMessage {
                    ShannonSnackbar(
                        message: statusMessage,
                        symbolName: "info.circle",
                        showsRetry: false,
                        retry: {},
                        dismiss: model.dismissStatus
                    )
                    .padding(.horizontal, ShannonSpacing.large)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
                }
                if let errorMessage = model.errorMessage {
                    ShannonSnackbar(
                        message: errorMessage,
                        showsRetry: model.hasFailedMessage,
                        retry: { Task { await model.retryLastFailed() } },
                        dismiss: model.dismissError
                    )
                    .padding(.horizontal, ShannonSpacing.large)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
                }
                if voiceModel.phase != .idle {
                    ShannonVoiceStatusBar(
                        model: voiceModel,
                        primaryAction: performTranscriptionPrimaryAction,
                        cancel: voiceModel.cancel
                    )
                    .padding(.horizontal, ShannonSpacing.medium)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
                }
#if os(iOS)
                if showsPromptSuggestions {
                    ShannonPromptSuggestionList(suggestions: promptSuggestions, palette: palette) { suggestion in
                        model.draft = suggestion.text
                        composerIsFocused = true
                    }
                    .transition(.opacity)
                }
#endif
#if os(iOS)
                if usesGirlDialogue {
                    // Option C (owner pick 2026-10-13): one line of work in progress over the composer, and in a
                    // call the call's controls in place of the composer.
                    let stage = dialogueStageNow
                    if stage.showsActivityLine {
                        ShannonDialogueActivityLine(now: now, threads: actionThreads)
                            .transition(.opacity)
                    }
                    if stage.showsComposer {
                        composer(palette)
                            .transition(.opacity)
                    } else {
                        dialogueCallControls(palette)
                            .transition(.move(edge: .bottom).combined(with: .opacity))
                    }
                } else {
                    composer(palette)
                }
#else
                composer(palette)
#endif
            }
#if os(iOS)
            .animation(dialogueStageAnimation, value: usesGirlDialogue ? dialogueStageNow : .talk)
#endif
            // No panel behind the composer: the conversation stays visible under it, and the composer floats.
        }
        .modifier(ShannonFloatingTalkChrome())
        .background(palette.canvas)
        .animation(reduceMotion ? nil : .easeOut(duration: 0.22), value: model.errorMessage)
        .animation(reduceMotion ? nil : .easeOut(duration: 0.22), value: model.latestAgentTaskNotice?.id)
        .animation(reduceMotion ? nil : .easeOut(duration: 0.22), value: model.latestAgentTaskNotice?.attention?.key)
    }

    /// Talk's dialogue display in the Live2D form, where she is large, reads back from the corner and fills the
    /// screen in a call (`ShannonDialogueStage`, iPhone).
    var usesGirlDialogue: Bool {
#if os(iOS)
        selectedPage == .talk && displayMode == .dialogue && dialogueShowsLive2D
#else
        false
#endif
    }

    /// Empty scroll-mode conversation with nothing typed yet.
    var showsPromptSuggestions: Bool {
        displayMode == .scroll
            && !model.isLoadingHistory
            && model.messages.isEmpty
            && model.unattachedSelectedThreadOrganizeSessions.isEmpty
            && model.draft.isEmpty
    }

    var promptSuggestions: [ShannonPromptSuggestions.Suggestion] {
        ShannonPromptSuggestions.make(
            dailyMindTopic: memoryModel.dashboard?.dailyMind?.topic,
            activeTaskTitles: model.agentTasks
                .filter { $0.status.isActive && !$0.isArchived }
                .sorted { $0.updatedAt > $1.updatedAt }
                .map(\.title),
            interests: model.state?.interests ?? []
        )
    }
}

/// Talk's bars have no background: the conversation scrolls visibly under the status bar, the header's
/// buttons and the composer, which float over it (owner feedback, TestFlight 243).
struct ShannonFloatingTalkChrome: ViewModifier {
    func body(content: Content) -> some View {
#if os(iOS)
        if #available(iOS 26.0, *) {
            content
                .toolbarBackgroundVisibility(.hidden, for: .navigationBar)
                .scrollEdgeEffectHidden(true, for: [.top, .bottom])
        } else if #available(iOS 18.0, *) {
            content.toolbarBackgroundVisibility(.hidden, for: .navigationBar)
        } else {
            content.toolbarBackground(.hidden, for: .navigationBar)
        }
#else
        content
#endif
    }
}

/// A header button over the conversation stays legible: iOS 26 draws its own glass around toolbar items;
/// earlier systems get a small material circle.
struct ShannonFloatingToolbarGlyph: ViewModifier {
    func body(content: Content) -> some View {
#if os(iOS)
        if #available(iOS 26.0, *) {
            content
        } else {
            content
                .frame(width: 34, height: 34)
                .background(.regularMaterial, in: Circle())
        }
#else
        content
#endif
    }
}
