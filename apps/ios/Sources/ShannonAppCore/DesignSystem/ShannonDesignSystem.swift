import SwiftUI

#if canImport(UIKit)
import UIKit
#elseif canImport(AppKit)
import AppKit
#endif

/// Shared semantic color contract used by Shannon on every Apple platform.
/// Names describe product intent, while concrete values preserve Shannon's visual identity.
/// The values come from the one product spec (`design/tokens.json`, generated into
/// `Generated/ShannonDesignTokens.generated.swift`); the names here stay as the app knows them.
enum ShannonColorTokens {
    fileprivate typealias Generated = ShannonGeneratedTokens.Color

    enum Intelligence {
        static let sky: UInt = Generated.Fixed.intelligenceSky
        static let core: UInt = Generated.Light.intelligence
        static let depth: UInt = Generated.Fixed.intelligenceDepth
        static let ink: UInt = Generated.Fixed.intelligenceInk
    }

    enum Light {
        static let brandPresence: UInt = Generated.Light.intelligence
        static let action: UInt = Generated.Light.action
        static let onAction: UInt = Generated.Light.onAction
        static let canvas: UInt = Generated.Light.canvas
        static let readingSurface: UInt = Generated.Light.readingSurface
        static let subtleSurface: UInt = Generated.Light.subtleSurface
        static let elevatedSurface: UInt = Generated.Light.elevatedSurface
        static let userMessage: UInt = Generated.Light.userMessage
        static let intelligenceSoft: UInt = Generated.Light.intelligenceSoft
        static let textPrimary: UInt = Generated.Light.textPrimary
        static let textSecondary: UInt = Generated.Light.textSecondary
        static let borderStrong: UInt = Generated.Light.borderStrong
        static let divider: UInt = Generated.Light.divider
        static let creation: UInt = Generated.Light.creation
        static let creationText: UInt = Generated.Light.onCreation
        static let creationTint: UInt = Generated.Light.creationTint
        static let success: UInt = Generated.Light.success
        static let successTint: UInt = Generated.Light.successTint
        static let successTintText: UInt = Generated.Light.onSuccessTint
        static let attention: UInt = Generated.Light.attention
        static let attentionTint: UInt = Generated.Light.attentionTint
        static let attentionTintText: UInt = Generated.Light.onAttentionTint
        static let danger: UInt = Generated.Light.danger
        static let dangerTint: UInt = Generated.Light.dangerTint
        static let dangerTintText: UInt = Generated.Light.onDangerTint
        static let characterBlush: UInt = Generated.Light.characterBlush
    }

    enum Dark {
        static let brandPresence: UInt = Generated.Dark.intelligence
        static let action: UInt = Generated.Dark.action
        static let onAction: UInt = Generated.Dark.onAction
        static let canvas: UInt = Generated.Dark.canvas
        static let readingSurface: UInt = Generated.Dark.readingSurface
        static let subtleSurface: UInt = Generated.Dark.subtleSurface
        static let elevatedSurface: UInt = Generated.Dark.elevatedSurface
        static let userMessage: UInt = Generated.Dark.userMessage
        static let intelligenceSoft: UInt = Generated.Dark.intelligenceSoft
        static let textPrimary: UInt = Generated.Dark.textPrimary
        static let textSecondary: UInt = Generated.Dark.textSecondary
        static let borderStrong: UInt = Generated.Dark.borderStrong
        static let divider: UInt = Generated.Dark.divider
        static let creation: UInt = Generated.Dark.creation
        static let creationText: UInt = Generated.Dark.onCreation
        static let creationTint: UInt = Generated.Dark.creationTint
        static let success: UInt = Generated.Dark.success
        static let successTint: UInt = Generated.Dark.successTint
        static let successTintText: UInt = Generated.Dark.onSuccessTint
        static let attention: UInt = Generated.Dark.attention
        static let attentionTint: UInt = Generated.Dark.attentionTint
        static let attentionTintText: UInt = Generated.Dark.onAttentionTint
        static let danger: UInt = Generated.Dark.danger
        static let dangerTint: UInt = Generated.Dark.dangerTint
        static let dangerTintText: UInt = Generated.Dark.onDangerTint
        static let characterBlush: UInt = Generated.Dark.characterBlush
    }
}

struct ShannonPalette {
    let brandPresence: Color
    let intelligenceSky: Color
    let intelligenceDepth: Color
    let intelligenceInk: Color
    let intelligenceSoft: Color
    let action: Color
    let onAction: Color
    let userMessage: Color
    let onUserMessage: Color
    let textSecondary: Color
    let subtleSurface: Color
    let textPrimary: Color
    let creation: Color
    let onCreation: Color
    let creationTint: Color
    let canvas: Color
    let readingSurface: Color
    let elevatedSurface: Color
    let borderStrong: Color
    let divider: Color
    let danger: Color
    let dangerTint: Color
    let onDangerTint: Color
    let success: Color
    let successTint: Color
    let onSuccessTint: Color
    let attention: Color
    let attentionTint: Color
    let onAttentionTint: Color
    let characterBlush: Color

    var intelligenceGradient: LinearGradient {
        LinearGradient(
            colors: [intelligenceSky, brandPresence, intelligenceDepth],
            startPoint: .topLeading,
            endPoint: .bottomTrailing
        )
    }

    static let light = ShannonPalette(
        brandPresence: Color(hex: ShannonColorTokens.Light.brandPresence),
        intelligenceSky: Color(hex: ShannonColorTokens.Intelligence.sky),
        intelligenceDepth: Color(hex: ShannonColorTokens.Intelligence.depth),
        intelligenceInk: Color(hex: ShannonColorTokens.Intelligence.ink),
        intelligenceSoft: Color(hex: ShannonColorTokens.Light.intelligenceSoft),
        action: Color(hex: ShannonColorTokens.Light.action),
        onAction: Color(hex: ShannonColorTokens.Light.onAction),
        userMessage: Color(hex: ShannonColorTokens.Light.userMessage),
        onUserMessage: Color(hex: ShannonColorTokens.Light.textPrimary),
        textSecondary: Color(hex: ShannonColorTokens.Light.textSecondary),
        subtleSurface: Color(hex: ShannonColorTokens.Light.subtleSurface),
        textPrimary: Color(hex: ShannonColorTokens.Light.textPrimary),
        creation: Color(hex: ShannonColorTokens.Light.creation),
        onCreation: Color(hex: ShannonColorTokens.Light.creationText),
        creationTint: Color(hex: ShannonColorTokens.Light.creationTint),
        canvas: Color(hex: ShannonColorTokens.Light.canvas),
        readingSurface: Color(hex: ShannonColorTokens.Light.readingSurface),
        elevatedSurface: Color(hex: ShannonColorTokens.Light.elevatedSurface),
        borderStrong: Color(hex: ShannonColorTokens.Light.borderStrong),
        divider: Color(hex: ShannonColorTokens.Light.divider),
        danger: Color(hex: ShannonColorTokens.Light.danger),
        dangerTint: Color(hex: ShannonColorTokens.Light.dangerTint),
        onDangerTint: Color(hex: ShannonColorTokens.Light.dangerTintText),
        success: Color(hex: ShannonColorTokens.Light.success),
        successTint: Color(hex: ShannonColorTokens.Light.successTint),
        onSuccessTint: Color(hex: ShannonColorTokens.Light.successTintText),
        attention: Color(hex: ShannonColorTokens.Light.attention),
        attentionTint: Color(hex: ShannonColorTokens.Light.attentionTint),
        onAttentionTint: Color(hex: ShannonColorTokens.Light.attentionTintText),
        characterBlush: Color(hex: ShannonColorTokens.Light.characterBlush)
    )

    static let dark = ShannonPalette(
        brandPresence: Color(hex: ShannonColorTokens.Dark.brandPresence),
        intelligenceSky: Color(hex: ShannonColorTokens.Intelligence.sky),
        intelligenceDepth: Color(hex: ShannonColorTokens.Intelligence.depth),
        intelligenceInk: Color(hex: ShannonColorTokens.Intelligence.ink),
        intelligenceSoft: Color(hex: ShannonColorTokens.Dark.intelligenceSoft),
        action: Color(hex: ShannonColorTokens.Dark.action),
        onAction: Color(hex: ShannonColorTokens.Dark.onAction),
        userMessage: Color(hex: ShannonColorTokens.Dark.userMessage),
        onUserMessage: Color(hex: ShannonColorTokens.Dark.textPrimary),
        textSecondary: Color(hex: ShannonColorTokens.Dark.textSecondary),
        subtleSurface: Color(hex: ShannonColorTokens.Dark.subtleSurface),
        textPrimary: Color(hex: ShannonColorTokens.Dark.textPrimary),
        creation: Color(hex: ShannonColorTokens.Dark.creation),
        onCreation: Color(hex: ShannonColorTokens.Dark.creationText),
        creationTint: Color(hex: ShannonColorTokens.Dark.creationTint),
        canvas: Color(hex: ShannonColorTokens.Dark.canvas),
        readingSurface: Color(hex: ShannonColorTokens.Dark.readingSurface),
        elevatedSurface: Color(hex: ShannonColorTokens.Dark.elevatedSurface),
        borderStrong: Color(hex: ShannonColorTokens.Dark.borderStrong),
        divider: Color(hex: ShannonColorTokens.Dark.divider),
        danger: Color(hex: ShannonColorTokens.Dark.danger),
        dangerTint: Color(hex: ShannonColorTokens.Dark.dangerTint),
        onDangerTint: Color(hex: ShannonColorTokens.Dark.dangerTintText),
        success: Color(hex: ShannonColorTokens.Dark.success),
        successTint: Color(hex: ShannonColorTokens.Dark.successTint),
        onSuccessTint: Color(hex: ShannonColorTokens.Dark.successTintText),
        attention: Color(hex: ShannonColorTokens.Dark.attention),
        attentionTint: Color(hex: ShannonColorTokens.Dark.attentionTint),
        onAttentionTint: Color(hex: ShannonColorTokens.Dark.attentionTintText),
        characterBlush: Color(hex: ShannonColorTokens.Dark.characterBlush)
    )

    static func resolve(_ colorScheme: ColorScheme) -> ShannonPalette {
        colorScheme == .dark ? .dark : .light
    }
}

enum ShannonSpacing {
    static let extraSmall: CGFloat = ShannonGeneratedTokens.Spacing.extraSmall
    static let small: CGFloat = ShannonGeneratedTokens.Spacing.small
    static let medium: CGFloat = ShannonGeneratedTokens.Spacing.medium
    static let large: CGFloat = ShannonGeneratedTokens.Spacing.large
    static let extraLarge: CGFloat = ShannonGeneratedTokens.Spacing.extraLarge
    static let huge: CGFloat = ShannonGeneratedTokens.Spacing.huge
}

enum ShannonShape {
    static let small: CGFloat = ShannonGeneratedTokens.Radius.small
    static let medium: CGFloat = ShannonGeneratedTokens.Radius.medium
    static let large: CGFloat = ShannonGeneratedTokens.Radius.large
    static let extraLarge: CGFloat = ShannonGeneratedTokens.Radius.extraLarge
    static let full: CGFloat = ShannonGeneratedTokens.Radius.full
}

enum ShannonTouchTarget {
    static let minimum: CGFloat = ShannonGeneratedTokens.Size.touchTargetMinimum
}

extension Color {
    public static func shannonAction(for colorScheme: ColorScheme) -> Color {
        Color(hex: colorScheme == .dark ? ShannonColorTokens.Dark.action : ShannonColorTokens.Light.action)
    }

    /// The action blue where no colour scheme is at hand (instead of the system accent colour, which
    /// on iPhone is the same blue and on the Mac follows the system setting).
    public static let shannonActionColor = adaptive(
        light: ShannonColorTokens.Light.action,
        dark: ShannonColorTokens.Dark.action
    )
    public static let shannonSuccess = adaptive(
        light: ShannonColorTokens.Light.success,
        dark: ShannonColorTokens.Dark.success
    )
    public static let shannonAttention = adaptive(
        light: ShannonColorTokens.Light.attention,
        dark: ShannonColorTokens.Dark.attention
    )
    public static let shannonDanger = adaptive(
        light: ShannonColorTokens.Light.danger,
        dark: ShannonColorTokens.Dark.danger
    )

    static func adaptive(light: UInt, dark: UInt) -> Color {
#if canImport(UIKit)
        Color(UIColor { traits in
            UIColor(shannonHex: traits.userInterfaceStyle == .dark ? dark : light)
        })
#elseif canImport(AppKit)
        Color(NSColor(name: nil) { appearance in
            let match = appearance.bestMatch(from: [.darkAqua, .aqua])
            return NSColor(shannonHex: match == .darkAqua ? dark : light)
        })
#else
        Color(hex: light)
#endif
    }

    init(hex: UInt, alpha: Double = 1) {
        self.init(
            .sRGB,
            red: Double((hex >> 16) & 0xFF) / 255,
            green: Double((hex >> 8) & 0xFF) / 255,
            blue: Double(hex & 0xFF) / 255,
            opacity: alpha
        )
    }
}

#if canImport(UIKit)
private extension UIColor {
    convenience init(shannonHex: UInt) {
        self.init(
            red: CGFloat((shannonHex >> 16) & 0xFF) / 255,
            green: CGFloat((shannonHex >> 8) & 0xFF) / 255,
            blue: CGFloat(shannonHex & 0xFF) / 255,
            alpha: 1
        )
    }
}
#elseif canImport(AppKit)
private extension NSColor {
    convenience init(shannonHex: UInt) {
        self.init(
            calibratedRed: CGFloat((shannonHex >> 16) & 0xFF) / 255,
            green: CGFloat((shannonHex >> 8) & 0xFF) / 255,
            blue: CGFloat(shannonHex & 0xFF) / 255,
            alpha: 1
        )
    }
}
#endif
