import SwiftUI

/// 「設定 › すがた」 on the iPhone (docs/product/information-architecture.md, 3): her form, her body in the
/// Live2D form (人の姿／目だけ, as 設定 › すがた › 体 on the desktop; 8, 2026-10-05), 映し方 and 位置を戻す, 「体に起きたことをシャノンに伝える」 with what became of the last touch, and
/// 「触れたときの返事」. The switches that change what leaves the device are here only, not in Talk,
/// so that they are not changed by mistake mid-conversation. 「トークで姿を見る」 opens Talk's
/// dialogue display, where her figure is and where she is touched.
struct ShannonFigureSettingsSection: View {
    let showInTalk: () -> Void

    @AppStorage(ShannonForm.storageKey) private var formRawValue = ShannonForm.waterlight.rawValue
    @AppStorage(ShannonBodyPreference.reportsTouchKey) private var reportsTouch = false
    @AppStorage(ShannonLive2DBody.storageKey) private var bodyRawValue = ShannonLive2DBody.human.rawValue
    @AppStorage(ShannonBodyPreference.layoutModeKey) private var layoutModeRawValue = ShannonLive2DLayout.Mode.full.rawValue
    @AppStorage(ShannonBodyReplyMode.storageKey) private var replyModeRawValue = ShannonBodyReplyMode.text.rawValue
    @Environment(ShannonBodyModel.self) private var bodyModel: ShannonBodyModel?
    @Environment(\.colorScheme) private var colorScheme

    private var usesLive2D: Bool { formRawValue == ShannonForm.live2d.rawValue && ShannonLive2DStage.isAvailable }
    private var chosenBody: ShannonLive2DBody { .displayed(rawValue: bodyRawValue) }
    /// 映し方 frames the character; her eyes alone are only sized and moved.
    private var offersLayoutMode: Bool { usesLive2D && chosenBody.hasCharacterRig }

    var body: some View {
        let palette = ShannonPalette.resolve(colorScheme)
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

            // Kept in place for both forms so that switching never moves the list.
            Picker(selection: ShannonLive2DBody.selection($bodyRawValue)) {
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

            Picker(selection: $layoutModeRawValue) {
                Text(ShannonBodyCopy.layoutFull).tag(ShannonLive2DLayout.Mode.full.rawValue)
                Text(ShannonBodyCopy.layoutBust).tag(ShannonLive2DLayout.Mode.bust.rawValue)
            } label: {
                Label(ShannonBodyCopy.layoutTitle, systemImage: "rectangle.portrait.and.arrow.right")
            }
            .disabled(!offersLayoutMode)
            .accessibilityHint(!usesLive2D ? ShannonBodyCopy.layoutOnlyLive2D : offersLayoutMode ? "" : ShannonBodyCopy.layoutOnlyHuman)
            .accessibilityIdentifier("settings-body-layout")

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

            Toggle(isOn: $reportsTouch) {
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
        } header: {
            Text(ShannonBodyCopy.sectionTitle)
        } footer: {
            VStack(alignment: .leading, spacing: ShannonSpacing.small) {
                Text(ShannonBodyCopy.settingsExplanation(body: usesLive2D ? chosenBody : .human))
                if bodyModel?.voice != nil { Text(ShannonBodyCopy.replyModeExplanation) }
            }
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
