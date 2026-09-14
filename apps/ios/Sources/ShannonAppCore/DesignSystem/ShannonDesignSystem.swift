import SwiftUI

#if canImport(UIKit)
import UIKit
#elseif canImport(AppKit)
import AppKit
#endif

/// Shared semantic color contract used by Shannon on every Apple platform.
/// Names describe product intent, while concrete values preserve Shannon's visual identity.
enum ShannonColorTokens {
    enum Intelligence {
        static let sky: UInt = 0x78D9FF
        static let core: UInt = 0x5865F2
        static let depth: UInt = 0x3039A8
        static let ink: UInt = 0x090A0F
    }

    enum Light {
        static let brandPresence: UInt = Intelligence.core
        static let action: UInt = 0x0088FF
        static let onAction: UInt = 0xFFFFFF
        static let canvas: UInt = 0xFFFFFF
        static let readingSurface: UInt = 0xFFFFFF
        static let subtleSurface: UInt = 0xF2F2F7
        static let elevatedSurface: UInt = 0xFFFFFF
        static let userMessage: UInt = 0xE5F3FF
        static let intelligenceSoft: UInt = 0xE0E3FF
        static let textPrimary: UInt = 0x111114
        static let textSecondary: UInt = 0x66666D
        static let borderStrong: UInt = 0x8E8E93
        static let divider: UInt = 0xD1D1D6
        static let creation: UInt = 0xFFCC00
        static let creationText: UInt = 0x3A2C00
        static let creationTint: UInt = 0xFFF5CC
        static let success: UInt = 0x34C759
        static let attention: UInt = 0xFF8D28
        static let danger: UInt = 0xFF383C
        static let dangerTint: UInt = 0xFFE5E6
        static let dangerTintText: UInt = 0x5F0004
        static let characterBlush: UInt = 0xF2A6B8
    }

    enum Dark {
        static let brandPresence: UInt = Intelligence.core
        static let action: UInt = 0x0091FF
        static let onAction: UInt = 0xFFFFFF
        static let canvas: UInt = 0x000000
        static let readingSurface: UInt = 0x1C1C1E
        static let subtleSurface: UInt = 0x1C1C1E
        static let elevatedSurface: UInt = 0x2C2C2E
        static let userMessage: UInt = 0x0D3151
        static let intelligenceSoft: UInt = 0x292C4D
        static let textPrimary: UInt = 0xF5F5F7
        static let textSecondary: UInt = 0xAEAEB2
        static let borderStrong: UInt = 0x8E8E93
        static let divider: UInt = 0x38383A
        static let creation: UInt = 0xFFD600
        static let creationText: UInt = 0x2B2100
        static let creationTint: UInt = 0x3D3300
        static let success: UInt = 0x30D158
        static let attention: UInt = 0xFF9230
        static let danger: UInt = 0xFF4245
        static let dangerTint: UInt = 0x4A1517
        static let dangerTintText: UInt = 0xFFE5E6
        static let characterBlush: UInt = 0xF5A3B6
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
    let attention: Color
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
        attention: Color(hex: ShannonColorTokens.Light.attention),
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
        attention: Color(hex: ShannonColorTokens.Dark.attention),
        characterBlush: Color(hex: ShannonColorTokens.Dark.characterBlush)
    )

    static func resolve(_ colorScheme: ColorScheme) -> ShannonPalette {
        colorScheme == .dark ? .dark : .light
    }
}

enum ShannonSpacing {
    static let extraSmall: CGFloat = 4
    static let small: CGFloat = 8
    static let medium: CGFloat = 12
    static let large: CGFloat = 16
    static let extraLarge: CGFloat = 24
    static let huge: CGFloat = 32
}

enum ShannonShape {
    static let small: CGFloat = 8
    static let medium: CGFloat = 12
    static let large: CGFloat = 16
    static let extraLarge: CGFloat = 28
    static let full: CGFloat = 999
}

enum ShannonTouchTarget {
    static let minimum: CGFloat = 48
}

extension Color {
    public static func shannonAction(for colorScheme: ColorScheme) -> Color {
        Color(hex: colorScheme == .dark ? ShannonColorTokens.Dark.action : ShannonColorTokens.Light.action)
    }

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

    private static func adaptive(light: UInt, dark: UInt) -> Color {
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
