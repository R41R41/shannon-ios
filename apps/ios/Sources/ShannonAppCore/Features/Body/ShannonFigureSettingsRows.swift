import SwiftUI

/// The rows of her figure in 設定, by the part of 設定 they belong to (the owner's choice 2026-10-26, plan A: by what
/// he wants to do). `figure` (in 「シャノン」): her form, her body in the Live2D form (人の姿／目だけ), 映し方, 位置を戻す and
/// 「トークで姿を見る」. `touch` (in 「見る・知る」): 「体に起きたことをシャノンに伝える」 with what became of the last touch.
/// `replyMode` (in 「声を出す場面」): 「触れたときの返事」. The switches that change what leaves the device are in 設定 only,
/// not in Talk, so that they are not changed by mistake mid-conversation. Rows only: each part of 設定 makes its section.
public struct ShannonFigureSettingsRows: View {
    public enum Part: Sendable { case figure, touch, replyMode }

    let part: Part
    let showInTalk: () -> Void

    /// `showInTalk`: the iPhone opens Talk's dialogue display; the Mac opens the 「すがた」 panel beside Talk (A15).
    public init(_ part: Part, showInTalk: @escaping () -> Void = {}) {
        self.part = part
        self.showInTalk = showInTalk
    }

    @AppStorage(ShannonPersonaPreset.storageKey) private var presetRawValue = ShannonPersonaPreset.initialRawValue
    @AppStorage(ShannonForm.storageKey) private var formRawValue = ShannonForm.waterlight.rawValue
    @AppStorage(ShannonBodyPreference.reportsTouchKey) private var reportsTouch = false
    @AppStorage(ShannonLive2DBody.storageKey) private var bodyRawValue = ShannonLive2DBody.human.rawValue
    @AppStorage(ShannonBodyPreference.layoutModeKey) private var layoutModeRawValue = ShannonLive2DLayout.Mode.full.rawValue
    @AppStorage(ShannonBodyReplyMode.storageKey) private var replyModeRawValue = ShannonBodyReplyMode.text.rawValue
    @Environment(ShannonBodyModel.self) private var bodyModel: ShannonBodyModel?
    @Environment(\.colorScheme) private var colorScheme

    private var usesLive2D: Bool { ShannonPersonaPreset.form(legacy: formRawValue, preset: presetRawValue) == .live2d && ShannonLive2DStage.isAvailable }
    private var chosenBody: ShannonLive2DBody { .displayed(rawValue: ShannonPersonaPreset.body(legacy: bodyRawValue, preset: presetRawValue).rawValue) }
    /// 映し方 frames the character; her eyes alone are only sized and moved.
    private var offersLayoutMode: Bool { usesLive2D && chosenBody.hasCharacterRig }

    public var body: some View {
        switch part {
        case .figure: figureRows
        case .touch: touchRow
        case .replyMode: replyModeRow
        }
    }

    @ViewBuilder
    private var figureRows: some View {
        let palette = ShannonPalette.resolve(colorScheme)
        Picker(selection: ShannonPersonaPreset.formSelection($formRawValue)) {
            ForEach(ShannonForm.allCases) { form in
                Text(form.japaneseName).tag(form.rawValue)
            }
        } label: {
            Label(ShannonBodyCopy.formTitle, systemImage: "figure.stand")
        }
        .accessibilityHint(ShannonBodyCopy.formHint)
        .accessibilityIdentifier("settings-body-form")

        // Kept in place for both forms so that switching never moves the list.
        Picker(selection: ShannonLive2DBody.selection(ShannonPersonaPreset.bodySelection($bodyRawValue))) {
            ForEach(ShannonLive2DBody.allCases) { body in
                Text(body.japaneseName).tag(body.rawValue)
            }
        } label: {
            Label {
                VStack(alignment: .leading, spacing: 2) {
                    Text(ShannonBodyCopy.bodyTitle)
                    if usesLive2D, let explanation = chosenBody.explanation {
                        Text(explanation)
                            .font(.shannon(.footnote))
                            .foregroundStyle(palette.textSecondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            } icon: {
                Image(systemName: chosenBody == .eyes ? "eyes" : "person")
            }
        }
        .disabled(ShannonBodyCopy.bodyUnavailableReason(usesLive2D: usesLive2D) != nil)
        .accessibilityHint(ShannonBodyCopy.bodyUnavailableReason(usesLive2D: usesLive2D) ?? "")
        .accessibilityIdentifier("settings-body-kind")

        // The iPhone's Talk frames her itself (上半身 while she talks, her face in the corner while he reads;
        // option C, owner pick 2026-10-13): 映し方 has nothing to change there.
#if !os(iOS)
        Picker(selection: $layoutModeRawValue) {
            Text(ShannonBodyCopy.layoutFull).tag(ShannonLive2DLayout.Mode.full.rawValue)
            Text(ShannonBodyCopy.layoutBust).tag(ShannonLive2DLayout.Mode.bust.rawValue)
        } label: {
            Label(ShannonBodyCopy.layoutTitle, systemImage: "rectangle.portrait.and.arrow.right")
        }
        .disabled(!offersLayoutMode)
        .accessibilityHint(!usesLive2D ? ShannonBodyCopy.layoutOnlyLive2D : offersLayoutMode ? "" : ShannonBodyCopy.layoutOnlyHuman)
        .accessibilityIdentifier("settings-body-layout")
#endif

        Button {
            bodyModel?.figureAdjustment = ShannonLive2DLayout()
        } label: {
            Label(ShannonBodyCopy.resetLayout, systemImage: "arrow.uturn.backward")
                .frame(minHeight: ShannonTouchTarget.minimum)
        }
        .disabled(!usesLive2D || !(bodyModel?.figureAdjustment.isMoved ?? false))
        .accessibilityIdentifier("settings-body-reset-layout")

        Button(action: showInTalk) {
            Label(ShannonBodyCopy.showInTalk, systemImage: "person.crop.rectangle")
                .frame(minHeight: ShannonTouchTarget.minimum)
        }
        .accessibilityHint(ShannonBodyCopy.showInTalkHint)
        .accessibilityIdentifier("settings-body-show-in-talk")
    }

    private var touchRow: some View {
        let palette = ShannonPalette.resolve(colorScheme)
        return Toggle(isOn: $reportsTouch) {
            Label {
                VStack(alignment: .leading, spacing: 2) {
                    Text(ShannonBodyCopy.reportsTouchTitle)
                    Text(touchStatus)
                        .font(.shannon(.footnote))
                        .foregroundStyle(palette.textSecondary)
                        .accessibilityIdentifier("body-touch-status")
                }
            } icon: {
                Image(systemName: "hand.tap")
            }
        }
        .frame(minHeight: ShannonTouchTarget.minimum)
        .accessibilityHint(ShannonBodyCopy.reportsTouchHint)
        .accessibilityIdentifier("settings-body-reports-touch")
    }

    @ViewBuilder
    private var replyModeRow: some View {
        // How she answers a touch. Only where her voice can be heard (the conversation's model); kept in place for
        // both forms, with a meaning only while touches reach her.
        if bodyModel?.voice != nil {
            Picker(selection: $replyModeRawValue) {
                ForEach(ShannonBodyReplyMode.allCases) { mode in
                    Text(mode.japaneseName).tag(mode.rawValue)
                }
            } label: {
                Label(ShannonBodyCopy.replyModeTitle, systemImage: "text.bubble")
            }
            .disabled(!reportsTouch || !usesLive2D)
            .accessibilityIdentifier("body-reply-mode")
        }
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

/// The footer of 「シャノン」 under her figure's rows: what her form and body are, for the body chosen now.
public struct ShannonFigureSettingsFooter: View {
    @AppStorage(ShannonPersonaPreset.storageKey) private var presetRawValue = ShannonPersonaPreset.initialRawValue
    @AppStorage(ShannonForm.storageKey) private var formRawValue = ShannonForm.waterlight.rawValue
    @AppStorage(ShannonLive2DBody.storageKey) private var bodyRawValue = ShannonLive2DBody.human.rawValue

    public init() {}

    public var body: some View {
        let usesLive2D = ShannonPersonaPreset.form(legacy: formRawValue, preset: presetRawValue) == .live2d && ShannonLive2DStage.isAvailable
        let chosen = ShannonLive2DBody.displayed(rawValue: ShannonPersonaPreset.body(legacy: bodyRawValue, preset: presetRawValue).rawValue)
        Text(ShannonBodyCopy.settingsExplanation(body: usesLive2D ? chosen : .human))
    }
}
