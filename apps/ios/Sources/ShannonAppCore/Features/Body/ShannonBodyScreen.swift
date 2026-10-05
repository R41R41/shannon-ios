import SwiftUI

#if os(macOS)
/// The Mac's body sheet 「からだ」 (opened from Settings): her figure large, the switch between her
/// two forms, and her body in the Live2D form (人の姿／目だけ, owner decision 2026-10-05). On the iPhone her figure lives in Talk's dialogue display and its options in 設定 › すがた
/// (decision 2026-10-03, roadmap A6); the Mac gets the same when her figure stands beside the
/// conversation (A15), and this sheet goes then.
public struct ShannonBodyScreen: View {
    let memory: ShannonMemoryModel?
    let showsCloseButton: Bool

    @AppStorage(ShannonForm.storageKey) private var formRawValue = ShannonForm.waterlight.rawValue
    @AppStorage(ShannonLive2DBody.storageKey) private var bodyRawValue = ShannonLive2DBody.human.rawValue
    @AppStorage(ShannonBodyPreference.reportsTouchKey) private var reportsTouch = false
    @AppStorage(ShannonBodyPreference.layoutModeKey) private var layoutModeRawValue = ShannonLive2DLayout.Mode.full.rawValue
    @AppStorage(ShannonBodyReplyMode.storageKey) private var replyModeRawValue = ShannonBodyReplyMode.text.rawValue
    @State private var hostID = UUID()
    @State private var adjustment = ShannonLive2DLayout()
    @State private var waterlightReaction = 0
    @Environment(ShannonBodyModel.self) private var bodyModel: ShannonBodyModel?
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    static let refreshSeconds = 30.0

    public init(memory: ShannonMemoryModel? = nil, showsCloseButton: Bool = true) {
        self.memory = memory
        self.showsCloseButton = showsCloseButton
    }

    private var stage: ShannonLive2DStage { .shared }
    private var form: ShannonForm { ShannonForm(rawValue: formRawValue) ?? .waterlight }
    private var usesLive2D: Bool { form == .live2d && ShannonLive2DStage.isAvailable }
    private var chosenBody: ShannonLive2DBody { ShannonLive2DBody(rawValue: bodyRawValue) ?? .human }
    private var showsLive2D: Bool { usesLive2D && stage.status == .ready && stage.activeHost == hostID }
    private var face: ShannonFace { bodyModel?.face ?? ShannonFace(expression: .calm) }

    private var layout: ShannonLive2DLayout {
        ShannonLive2DLayout(
            mode: ShannonLive2DLayout.Mode(rawValue: layoutModeRawValue) ?? .full,
            scale: adjustment.scale, offsetX: adjustment.offsetX, offsetY: adjustment.offsetY,
            // 上半身 is fitted to the width as well: on a tall screen the height alone would cut her shoulders.
            contained: layoutModeRawValue == ShannonLive2DLayout.Mode.bust.rawValue
        )
    }

    public var body: some View {
        let palette = ShannonPalette.resolve(colorScheme)
        GeometryReader { geometry in
            VStack(spacing: 0) {
                figure(palette, in: geometry.size)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                // Only where something keeps it true (the conversation's driver); the Mac window has none.
                if let bodyModel {
                    Text(ShannonBodyCopy.nowLine(face: face, doing: bodyModel.doingLine))
                        .font(.shannon(.callout))
                        .foregroundStyle(palette.textSecondary)
                        .multilineTextAlignment(.center)
                        .padding(.horizontal, ShannonSpacing.large)
                        .padding(.vertical, ShannonSpacing.small)
                        .accessibilityIdentifier("body-now-line")
                }
                // Never a scroll view around her: a scroll gesture would take the finger away from the page.
                if dynamicTypeSize.isAccessibilitySize {
                    ScrollView { controls(palette) }
                        .frame(height: geometry.size.height * 0.45)
                } else {
                    controls(palette)
                }
            }
        }
        .background(palette.canvas.ignoresSafeArea())
        .navigationTitle(ShannonBodyCopy.screenTitle)
#if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
#endif
        .toolbar {
            if showsCloseButton {
                ToolbarItem(placement: .cancellationAction) {
                    Button("閉じる") { dismiss() }
                }
            }
        }
        .onChange(of: layoutModeRawValue) { adjustment = ShannonLive2DLayout() }
        .task(id: scenePhase) {
            // What she is doing in her own time, read as the owner's app reads it elsewhere.
            guard scenePhase == .active, let memory else { return }
            while !Task.isCancelled {
                await memory.autonomy.refreshQuietly()
                await memory.autonomy.study.refreshQuietly()
                try? await Task.sleep(for: .seconds(Self.refreshSeconds))
            }
        }
#if DEBUG
        .onAppear { if ProcessInfo.processInfo.arguments.contains("-ShannonPreviewBodyStats") { stage.setFrameStats(true) } }
        .onDisappear { stage.setFrameStats(false) }
#endif
    }

    private func figure(_ palette: ShannonPalette, in size: CGSize) -> some View {
        ZStack {
            if !showsLive2D {
                Button {
                    waterlightReaction &+= 1
                } label: {
                    ShannonWaterlightEyeView(
                        expression: face.expression, activity: .idle,
                        size: min(size.width * 0.62, 260), reactionTrigger: waterlightReaction, feeling: face.feeling
                    )
                }
                .buttonStyle(.plain)
                .accessibilityLabel(face.accessibilityDescription)
                .accessibilityHint("触れると表情が変わります")
                .transition(.opacity)
            }
            if usesLive2D {
                ShannonLive2DFigure(
                    hostID: hostID, priority: .bodyScreen, layout: layout, touchEnabled: true, face: face, activity: .idle, isShowing: showsLive2D,
                    onLayoutChange: { adjustment = $0 },
                    directTouch: true,
                    onAdjust: { larger in
                        adjustment = adjustment.adjusted(scaleBy: larger ? 1.25 : 0.8, movedBy: .zero, in: size)
                    }
                )
            }
        }
        .animation(reduceMotion ? nil : .easeInOut(duration: 0.25), value: showsLive2D)
        .overlay(alignment: .top) {
            if showsLive2D {
                ShannonBodyLineBubble(maxWidth: min(340, size.width - 2 * ShannonSpacing.large))
                    .padding(.top, ShannonSpacing.medium)
            }
        }
        .overlay(alignment: .bottom) { status(palette) }
    }

    /// A small, truthful note about the Live2D form; nothing while it simply works.
    @ViewBuilder
    private func status(_ palette: ShannonPalette) -> some View {
        if let text = statusText {
            VStack(spacing: ShannonSpacing.extraSmall) {
                Text(text)
                    .font(.shannon(.footnote))
                    .foregroundStyle(palette.textSecondary)
                    .multilineTextAlignment(.center)
                if form == .live2d, stage.status == .failed {
                    Button(ShannonBodyCopy.retry) { stage.retry() }
                        .font(.shannon(.footnote).weight(.semibold))
                        .frame(minHeight: ShannonTouchTarget.minimum)
                }
            }
            .padding(.horizontal, ShannonSpacing.medium)
            .padding(.vertical, ShannonSpacing.extraSmall)
            .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            .padding(.bottom, ShannonSpacing.small)
            .accessibilityIdentifier("body-live2d-status")
        }
    }

    private var statusText: String? {
        guard form == .live2d else { return nil }
        guard ShannonLive2DStage.isAvailable else { return ShannonBodyCopy.unavailable }
        switch stage.status {
        case .failed: return ShannonBodyCopy.failed
        case .loading, .unloaded: return ShannonBodyCopy.loading(progress: stage.loadProgress)
        case .ready:
            if stage.activeHost != hostID { return ShannonBodyCopy.shownElsewhere }
            if stage.isResting { return stage.lowPower ? ShannonBodyCopy.resting : ShannonBodyCopy.restingReduceMotion }
#if DEBUG
            if let fps = stage.framesPerSecond {
                return "\(fps) fps・読み込み \(String(format: "%.1f", stage.lastLoadSeconds ?? 0)) 秒・\(stage.modelUpdatedAt ?? "")"
            }
#endif
            return nil
        }
    }

    private func controls(_ palette: ShannonPalette) -> some View {
        VStack(alignment: .leading, spacing: ShannonSpacing.medium) {
            Picker(ShannonBodyCopy.formTitle, selection: $formRawValue) {
                ForEach(ShannonForm.allCases) { form in
                    Text(form.japaneseName).tag(form.rawValue)
                }
            }
            .pickerStyle(.segmented)
            .accessibilityHint(ShannonBodyCopy.formHint)
            .accessibilityIdentifier("body-form")

            // Kept in place for both forms so that switching never moves the screen.
            VStack(alignment: .leading, spacing: ShannonSpacing.extraSmall) {
                Picker(ShannonBodyCopy.bodyTitle, selection: $bodyRawValue) {
                    ForEach(ShannonLive2DBody.allCases) { body in
                        Text(body.japaneseName).tag(body.rawValue)
                    }
                }
                .pickerStyle(.segmented)
                .accessibilityIdentifier("body-kind")
                if let explanation = chosenBody.explanation {
                    Text(explanation)
                        .font(.shannon(.footnote))
                        .foregroundStyle(palette.textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .disabled(!usesLive2D)
            .opacity(usesLive2D ? 1 : 0.45)

            HStack(spacing: ShannonSpacing.medium) {
                Picker(ShannonBodyCopy.layoutTitle, selection: $layoutModeRawValue) {
                    Text(ShannonBodyCopy.layoutFull).tag(ShannonLive2DLayout.Mode.full.rawValue)
                    Text(ShannonBodyCopy.layoutBust).tag(ShannonLive2DLayout.Mode.bust.rawValue)
                }
                .pickerStyle(.segmented)
                // Her eyes alone are not framed; only their size counts.
                .disabled(!chosenBody.hasCharacterRig)
                .help(chosenBody.hasCharacterRig ? "" : ShannonBodyCopy.layoutOnlyHuman)
                .accessibilityIdentifier("body-layout")
                Button(ShannonBodyCopy.resetLayout) { adjustment = ShannonLive2DLayout() }
                    .font(.shannon(.footnote).weight(.semibold))
                    .frame(minHeight: ShannonTouchTarget.minimum)
                    .disabled(!adjustment.isMoved)
            }
            .disabled(!usesLive2D)
            .opacity(usesLive2D ? 1 : 0.45)

            // Without the conversation's model (the Mac window) nothing could be sent, so the switch is not offered.
            if let bodyModel {
                Toggle(isOn: $reportsTouch) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(ShannonBodyCopy.reportsTouchTitle)
                        Text(touchStatus)
                            .font(.shannon(.footnote))
                            .foregroundStyle(palette.textSecondary)
                            .accessibilityIdentifier("body-touch-status")
                    }
                }
                .frame(minHeight: ShannonTouchTarget.minimum)
                .accessibilityHint(ShannonBodyCopy.reportsTouchHint)
                .accessibilityIdentifier("body-reports-touch")
                // How she answers a touch here. Kept in place for both forms; it has a meaning only while touches reach her.
                if bodyModel.voice != nil {
                    Picker(ShannonBodyCopy.replyModeTitle, selection: $replyModeRawValue) {
                        ForEach(ShannonBodyReplyMode.allCases) { mode in
                            Text(mode.japaneseName).tag(mode.rawValue)
                        }
                    }
                    .pickerStyle(.segmented)
                    .disabled(!reportsTouch || !usesLive2D)
                    .opacity(reportsTouch && usesLive2D ? 1 : 0.45)
                    .accessibilityIdentifier("body-reply-mode")
                    Text(ShannonBodyCopy.replyModeExplanation)
                        .font(.shannon(.footnote))
                        .foregroundStyle(palette.textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                        .opacity(reportsTouch && usesLive2D ? 1 : 0.45)
                }
            }
        }
        .padding(.horizontal, ShannonSpacing.large)
        .padding(.top, ShannonSpacing.small)
        .padding(.bottom, ShannonSpacing.large)
    }

    private var touchStatus: String {
        guard reportsTouch else { return ShannonBodyCopy.gestureHint }
        switch bodyModel?.touch.delivery ?? .fine {
        case .notConnected: return ShannonBodyCopy.touchNotConnected
        case .failed: return ShannonBodyCopy.touchNotDelivered
        case .unsupported: return ShannonBodyCopy.touchUnsupported
        case .fine: return bodyModel?.audience == .others ? ShannonBodyCopy.touchOthers : ShannonBodyCopy.gestureHint
        }
    }
}

/// 「すがた」 in the Mac's Settings: the form, the way to the body sheet, and the touch switch.
public struct ShannonFormSettingsSection: View {
    let openBody: (() -> Void)?
    let showsTouchSwitch: Bool

    @AppStorage(ShannonForm.storageKey) private var formRawValue = ShannonForm.waterlight.rawValue
    @AppStorage(ShannonLive2DBody.storageKey) private var bodyRawValue = ShannonLive2DBody.human.rawValue
    @AppStorage(ShannonBodyPreference.reportsTouchKey) private var reportsTouch = false
    @Environment(\.colorScheme) private var colorScheme

    private var usesLive2D: Bool { formRawValue == ShannonForm.live2d.rawValue && ShannonLive2DStage.isAvailable }
    private var chosenBody: ShannonLive2DBody { ShannonLive2DBody(rawValue: bodyRawValue) ?? .human }

    public init(openBody: (() -> Void)? = nil, showsTouchSwitch: Bool = true) {
        self.openBody = openBody
        self.showsTouchSwitch = showsTouchSwitch
    }

    public var body: some View {
        Section {
            Picker(selection: $formRawValue) {
                ForEach(ShannonForm.allCases) { form in
                    Text(form.japaneseName).tag(form.rawValue)
                }
            } label: {
                Label(ShannonBodyCopy.formTitle, systemImage: "figure.stand")
            }
            .accessibilityHint(ShannonBodyCopy.formHint)
            .accessibilityIdentifier("settings-body-form")
            // 設定 › すがた › 体, as on the desktop and the iPhone. Kept in place for both forms.
            Picker(selection: $bodyRawValue) {
                ForEach(ShannonLive2DBody.allCases) { body in
                    Text(body.japaneseName).tag(body.rawValue)
                }
            } label: {
                Label(ShannonBodyCopy.bodyTitle, systemImage: chosenBody == .eyes ? "eyes" : "person")
                if usesLive2D, let explanation = chosenBody.explanation {
                    Text(explanation)
                }
            }
            .disabled(!usesLive2D)
            .help(usesLive2D ? "" : ShannonBodyCopy.bodyOnlyLive2D)
            .accessibilityIdentifier("settings-body-kind")
            if let openBody {
                Button(action: openBody) {
                    Label(ShannonBodyCopy.openScreenTitle, systemImage: "arrow.up.forward.square")
                        .frame(minHeight: ShannonTouchTarget.minimum)
                }
                .accessibilityIdentifier("settings-body-open")
            }
            if showsTouchSwitch {
                Toggle(isOn: $reportsTouch) {
                    Label(ShannonBodyCopy.reportsTouchTitle, systemImage: "hand.tap")
                }
                .frame(minHeight: ShannonTouchTarget.minimum)
                .accessibilityHint(ShannonBodyCopy.reportsTouchHint)
                .accessibilityIdentifier("settings-body-reports-touch")
            }
        } header: {
            Text(ShannonBodyCopy.sectionTitle)
        } footer: {
            Text(showsTouchSwitch ? ShannonBodyCopy.settingsExplanation(body: usesLive2D ? chosenBody : .human) : ShannonBodyCopy.macExplanation)
        }
    }
}
#endif
