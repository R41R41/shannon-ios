// Adapted from Swift Pieces "Permission Sheet" (registry/swift/sheets/PermissionSheet.swift, v2.0.0)
// by Saivion Hayes — https://github.com/Saivion/SwiftPieces
// MIT + Commons Clause License Condition v1.0. See THIRD_PARTY_NOTICES.md.
// Rewritten for Shannon: semantic palette, native buttons, and an owner-controlled
// state machine so the real system request still runs on the user's tap.

import SwiftUI
#if canImport(UIKit)
import UIKit
#endif

/// What a pre-permission explanation says before the system asks.
struct ShannonPermissionPrimerContent: Equatable {
    struct Benefit: Equatable {
        let symbol: String
        let text: String
    }

    let symbol: String
    let title: String
    let message: String
    let benefits: [Benefit]
    let allowTitle: String
    let deniedTitle: String
    let deniedMessage: String
}

/// `explain` waits for the user's tap, `requesting` covers the system alert, and
/// `denied` routes the same sheet to Settings.
public enum ShannonPermissionPrimerPhase: Equatable, Sendable {
    case explain
    case requesting
    case denied
}

/// Authorization state as the primer needs it, independent of the framework that owns it.
public enum ShannonMediaPermission: Equatable, Sendable {
    case undetermined
    case granted
    case denied
}

#if os(iOS)
struct ShannonPermissionPrimerSheet: View {
    let content: ShannonPermissionPrimerContent
    let phase: ShannonPermissionPrimerPhase
    let allow: () -> Void
    let notNow: () -> Void

    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.openURL) private var openURL
    @State private var revealed = false

    var body: some View {
        let palette = ShannonPalette.resolve(colorScheme)
        let isDenied = phase == .denied

        ScrollView {
            VStack(alignment: .leading, spacing: ShannonSpacing.extraLarge) {
                Image(systemName: isDenied ? "gearshape.fill" : content.symbol)
                    .font(.system(size: 28, weight: .semibold))
                    .foregroundStyle(isDenied ? palette.onAttentionTint : palette.brandPresence)
                    .contentTransition(reduceMotion ? .identity : .symbolEffect(.replace))
                    .frame(width: 68, height: 68)
                    .background(
                        isDenied ? palette.attentionTint : palette.intelligenceSoft,
                        in: RoundedRectangle(cornerRadius: ShannonShape.extraLarge - 6, style: .continuous)
                    )
                    .accessibilityHidden(true)

                VStack(alignment: .leading, spacing: ShannonSpacing.small) {
                    Text(isDenied ? content.deniedTitle : content.title)
                        .font(.title2.weight(.bold))
                        .foregroundStyle(palette.textPrimary)
                        .accessibilityAddTraits(.isHeader)
                    Text(isDenied ? content.deniedMessage : content.message)
                        .font(.body)
                        .foregroundStyle(palette.textSecondary)
                }
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
                .animation(reduceMotion ? nil : .smooth(duration: 0.3), value: phase)

                if !isDenied {
                    VStack(alignment: .leading, spacing: ShannonSpacing.medium) {
                        ForEach(Array(content.benefits.enumerated()), id: \.offset) { index, benefit in
                            benefitRow(benefit, palette: palette)
                                .opacity(revealed || reduceMotion ? 1 : 0)
                                .offset(y: revealed || reduceMotion ? 0 : 10)
                                .animation(
                                    reduceMotion ? nil : .spring(duration: 0.45, bounce: 0).delay(0.1 + 0.07 * Double(index)),
                                    value: revealed
                                )
                        }
                    }
                }
            }
            .padding(ShannonSpacing.extraLarge)
        }
        .scrollBounceBehavior(.basedOnSize)
        .safeAreaInset(edge: .bottom, spacing: 0) {
            actions(palette, isDenied: isDenied)
        }
        .background(palette.canvas)
        .interactiveDismissDisabled(phase == .requesting)
        .onAppear { revealed = true }
    }

    private func actions(_ palette: ShannonPalette, isDenied: Bool) -> some View {
        VStack(spacing: ShannonSpacing.extraSmall) {
            Button {
                if isDenied {
                    if let url = URL(string: UIApplication.openSettingsURLString) { openURL(url) }
                } else {
                    allow()
                }
            } label: {
                HStack(spacing: ShannonSpacing.small) {
                    if phase == .requesting { ProgressView().tint(palette.onAction) }
                    Text(isDenied ? "設定を開く" : (phase == .requesting ? "確認しています…" : content.allowTitle))
                }
                .frame(maxWidth: .infinity, minHeight: 36)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
            .tint(palette.action)
            .disabled(phase == .requesting)

            Button(isDenied ? "閉じる" : "今はしない", action: notNow)
                .font(.body.weight(.medium))
                .foregroundStyle(palette.textSecondary)
                .frame(maxWidth: .infinity, minHeight: ShannonTouchTarget.minimum)
                .disabled(phase == .requesting)
        }
        .padding(.horizontal, ShannonSpacing.extraLarge)
        .padding(.top, ShannonSpacing.small)
        .padding(.bottom, ShannonSpacing.small)
        .background(.bar)
    }

    private func benefitRow(_ benefit: ShannonPermissionPrimerContent.Benefit, palette: ShannonPalette) -> some View {
        HStack(alignment: .top, spacing: ShannonSpacing.medium) {
            Image(systemName: benefit.symbol)
                .font(.body.weight(.semibold))
                .foregroundStyle(palette.action)
                .frame(width: 40, height: 40)
                .background(palette.action.opacity(0.12), in: RoundedRectangle(cornerRadius: ShannonShape.medium, style: .continuous))
                .accessibilityHidden(true)
            Text(benefit.text)
                .font(.body)
                .foregroundStyle(palette.textPrimary)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.top, ShannonSpacing.small)
        }
        .accessibilityElement(children: .combine)
    }
}
#endif
