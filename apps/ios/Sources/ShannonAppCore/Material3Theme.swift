import SwiftUI

enum ShannonColorTokens {
    enum Light {
        static let brandPresence: UInt = 0x0E92EF
        static let actionPrimary: UInt = 0x006AA6
        static let canvas: UInt = 0xF8FBFD
        static let surface: UInt = 0xFFFFFF
        static let surfaceTint: UInt = 0xEEF7FC
        static let userMessage: UInt = 0xE7F4FC
        static let textPrimary: UInt = 0x10212B
        static let textSecondary: UInt = 0x536B78
        static let outline: UInt = 0x6B808B
        static let outlineVariant: UInt = 0xD8E8F1
        static let emotionWarm: UInt = 0xE78173
        static let success: UInt = 0x16845B
        static let warning: UInt = 0xA55D00
    }

    enum Dark {
        static let brandPresence: UInt = 0x46B9FF
        static let actionPrimary: UInt = 0x56C0FF
        static let onActionPrimary: UInt = 0x062133
        static let canvas: UInt = 0x08131B
        static let surface: UInt = 0x0F202B
        static let surfaceTint: UInt = 0x142B39
        static let userMessage: UInt = 0x153246
        static let textPrimary: UInt = 0xF1F7FA
        static let textSecondary: UInt = 0x9DB5C2
        static let outline: UInt = 0x6F8793
        static let outlineVariant: UInt = 0x29424F
        static let emotionWarm: UInt = 0xFF9B88
        static let success: UInt = 0x54D39A
        static let warning: UInt = 0xF0B45A
    }
}

struct M3Palette {
    let brandPresence: Color
    let primary: Color
    let onPrimary: Color
    let primaryContainer: Color
    let onPrimaryContainer: Color
    let secondary: Color
    let secondaryContainer: Color
    let onSecondaryContainer: Color
    let tertiary: Color
    let tertiaryContainer: Color
    let surface: Color
    let surfaceContainerLow: Color
    let surfaceContainer: Color
    let surfaceContainerHigh: Color
    let onSurface: Color
    let onSurfaceVariant: Color
    let outline: Color
    let outlineVariant: Color
    let error: Color
    let errorContainer: Color
    let onErrorContainer: Color
    let success: Color
    let warning: Color

    static let light = M3Palette(
        brandPresence: Color(hex: ShannonColorTokens.Light.brandPresence),
        primary: Color(hex: ShannonColorTokens.Light.actionPrimary),
        onPrimary: .white,
        primaryContainer: Color(hex: ShannonColorTokens.Light.userMessage),
        onPrimaryContainer: Color(hex: ShannonColorTokens.Light.textPrimary),
        secondary: Color(hex: ShannonColorTokens.Light.textSecondary),
        secondaryContainer: Color(hex: ShannonColorTokens.Light.surfaceTint),
        onSecondaryContainer: Color(hex: ShannonColorTokens.Light.textPrimary),
        tertiary: Color(hex: ShannonColorTokens.Light.emotionWarm),
        tertiaryContainer: Color(hex: 0xFBE8E4),
        surface: Color(hex: ShannonColorTokens.Light.canvas),
        surfaceContainerLow: Color(hex: ShannonColorTokens.Light.surface),
        surfaceContainer: Color(hex: ShannonColorTokens.Light.surfaceTint),
        surfaceContainerHigh: Color(hex: 0xE2F0F7),
        onSurface: Color(hex: ShannonColorTokens.Light.textPrimary),
        onSurfaceVariant: Color(hex: ShannonColorTokens.Light.textSecondary),
        outline: Color(hex: ShannonColorTokens.Light.outline),
        outlineVariant: Color(hex: ShannonColorTokens.Light.outlineVariant),
        error: Color(hex: 0xB3261E),
        errorContainer: Color(hex: 0xF9DEDC),
        onErrorContainer: Color(hex: 0x410E0B),
        success: Color(hex: ShannonColorTokens.Light.success),
        warning: Color(hex: ShannonColorTokens.Light.warning)
    )

    static let dark = M3Palette(
        brandPresence: Color(hex: ShannonColorTokens.Dark.brandPresence),
        primary: Color(hex: ShannonColorTokens.Dark.actionPrimary),
        onPrimary: Color(hex: ShannonColorTokens.Dark.onActionPrimary),
        primaryContainer: Color(hex: ShannonColorTokens.Dark.userMessage),
        onPrimaryContainer: Color(hex: ShannonColorTokens.Dark.textPrimary),
        secondary: Color(hex: ShannonColorTokens.Dark.textSecondary),
        secondaryContainer: Color(hex: ShannonColorTokens.Dark.surfaceTint),
        onSecondaryContainer: Color(hex: ShannonColorTokens.Dark.textPrimary),
        tertiary: Color(hex: ShannonColorTokens.Dark.emotionWarm),
        tertiaryContainer: Color(hex: 0x4C2B2A),
        surface: Color(hex: ShannonColorTokens.Dark.canvas),
        surfaceContainerLow: Color(hex: ShannonColorTokens.Dark.surface),
        surfaceContainer: Color(hex: ShannonColorTokens.Dark.surfaceTint),
        surfaceContainerHigh: Color(hex: 0x1B3543),
        onSurface: Color(hex: ShannonColorTokens.Dark.textPrimary),
        onSurfaceVariant: Color(hex: ShannonColorTokens.Dark.textSecondary),
        outline: Color(hex: ShannonColorTokens.Dark.outline),
        outlineVariant: Color(hex: ShannonColorTokens.Dark.outlineVariant),
        error: Color(hex: 0xF2B8B5),
        errorContainer: Color(hex: 0x8C1D18),
        onErrorContainer: Color(hex: 0xF9DEDC),
        success: Color(hex: ShannonColorTokens.Dark.success),
        warning: Color(hex: ShannonColorTokens.Dark.warning)
    )

    static func resolve(_ colorScheme: ColorScheme) -> M3Palette {
        colorScheme == .dark ? .dark : .light
    }
}

enum M3Spacing {
    static let extraSmall: CGFloat = 4
    static let small: CGFloat = 8
    static let medium: CGFloat = 12
    static let large: CGFloat = 16
    static let extraLarge: CGFloat = 24
    static let huge: CGFloat = 32
}

enum M3Shape {
    static let small: CGFloat = 8
    static let medium: CGFloat = 12
    static let large: CGFloat = 16
    static let extraLarge: CGFloat = 28
    static let full: CGFloat = 999
}

enum M3TouchTarget {
    static let minimum: CGFloat = 48
}

extension Color {
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
