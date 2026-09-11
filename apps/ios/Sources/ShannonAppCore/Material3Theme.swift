import SwiftUI

enum ShannonColorTokens {
    enum Intelligence {
        static let sky: UInt = 0x78D9FF
        static let core: UInt = 0x5865F2
        static let depth: UInt = 0x3039A8
    }

    enum Light {
        static let brandPresence: UInt = Intelligence.core
        static let actionPrimary: UInt = 0x0088FF
        static let canvas: UInt = 0xFFFFFF
        static let surface: UInt = 0xFFFFFF
        static let surfaceTint: UInt = 0xF2F2F7
        static let surfaceElevated: UInt = 0xFFFFFF
        static let userMessage: UInt = 0xE5F3FF
        static let intelligenceSoft: UInt = 0xE0E3FF
        static let textPrimary: UInt = 0x111114
        static let textSecondary: UInt = 0x66666D
        static let outline: UInt = 0x8E8E93
        static let outlineVariant: UInt = 0xD1D1D6
        static let create: UInt = 0xFFCC00
        static let success: UInt = 0x34C759
        static let warning: UInt = 0xFF8D28
        static let danger: UInt = 0xFF383C
    }

    enum Dark {
        static let brandPresence: UInt = Intelligence.core
        static let actionPrimary: UInt = 0x0091FF
        static let onActionPrimary: UInt = 0xFFFFFF
        static let canvas: UInt = 0x000000
        static let surface: UInt = 0x1C1C1E
        static let surfaceTint: UInt = 0x1C1C1E
        static let surfaceElevated: UInt = 0x2C2C2E
        static let userMessage: UInt = 0x0D3151
        static let intelligenceSoft: UInt = 0x292C4D
        static let textPrimary: UInt = 0xF5F5F7
        static let textSecondary: UInt = 0xAEAEB2
        static let outline: UInt = 0x8E8E93
        static let outlineVariant: UInt = 0x38383A
        static let create: UInt = 0xFFD600
        static let success: UInt = 0x30D158
        static let warning: UInt = 0xFF9230
        static let danger: UInt = 0xFF4245
    }
}

struct M3Palette {
    let brandPresence: Color
    let intelligenceSky: Color
    let intelligenceDepth: Color
    let intelligenceSoft: Color
    let primary: Color
    let onPrimary: Color
    let primaryContainer: Color
    let onPrimaryContainer: Color
    let secondary: Color
    let secondaryContainer: Color
    let onSecondaryContainer: Color
    let tertiary: Color
    let onTertiary: Color
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

    var intelligenceGradient: LinearGradient {
        LinearGradient(
            colors: [intelligenceSky, brandPresence, intelligenceDepth],
            startPoint: .topLeading,
            endPoint: .bottomTrailing
        )
    }

    static let light = M3Palette(
        brandPresence: Color(hex: ShannonColorTokens.Light.brandPresence),
        intelligenceSky: Color(hex: ShannonColorTokens.Intelligence.sky),
        intelligenceDepth: Color(hex: ShannonColorTokens.Intelligence.depth),
        intelligenceSoft: Color(hex: ShannonColorTokens.Light.intelligenceSoft),
        primary: Color(hex: ShannonColorTokens.Light.actionPrimary),
        onPrimary: .white,
        primaryContainer: Color(hex: ShannonColorTokens.Light.userMessage),
        onPrimaryContainer: Color(hex: ShannonColorTokens.Light.textPrimary),
        secondary: Color(hex: ShannonColorTokens.Light.textSecondary),
        secondaryContainer: Color(hex: ShannonColorTokens.Light.surfaceTint),
        onSecondaryContainer: Color(hex: ShannonColorTokens.Light.textPrimary),
        tertiary: Color(hex: ShannonColorTokens.Light.create),
        onTertiary: Color(hex: 0x3A2C00),
        tertiaryContainer: Color(hex: 0xFFF5CC),
        surface: Color(hex: ShannonColorTokens.Light.canvas),
        surfaceContainerLow: Color(hex: ShannonColorTokens.Light.surface),
        surfaceContainer: Color(hex: ShannonColorTokens.Light.surfaceTint),
        surfaceContainerHigh: Color(hex: ShannonColorTokens.Light.surfaceElevated),
        onSurface: Color(hex: ShannonColorTokens.Light.textPrimary),
        onSurfaceVariant: Color(hex: ShannonColorTokens.Light.textSecondary),
        outline: Color(hex: ShannonColorTokens.Light.outline),
        outlineVariant: Color(hex: ShannonColorTokens.Light.outlineVariant),
        error: Color(hex: ShannonColorTokens.Light.danger),
        errorContainer: Color(hex: 0xFFE5E6),
        onErrorContainer: Color(hex: 0x5F0004),
        success: Color(hex: ShannonColorTokens.Light.success),
        warning: Color(hex: ShannonColorTokens.Light.warning)
    )

    static let dark = M3Palette(
        brandPresence: Color(hex: ShannonColorTokens.Dark.brandPresence),
        intelligenceSky: Color(hex: ShannonColorTokens.Intelligence.sky),
        intelligenceDepth: Color(hex: ShannonColorTokens.Intelligence.depth),
        intelligenceSoft: Color(hex: ShannonColorTokens.Dark.intelligenceSoft),
        primary: Color(hex: ShannonColorTokens.Dark.actionPrimary),
        onPrimary: Color(hex: ShannonColorTokens.Dark.onActionPrimary),
        primaryContainer: Color(hex: ShannonColorTokens.Dark.userMessage),
        onPrimaryContainer: Color(hex: ShannonColorTokens.Dark.textPrimary),
        secondary: Color(hex: ShannonColorTokens.Dark.textSecondary),
        secondaryContainer: Color(hex: ShannonColorTokens.Dark.surfaceTint),
        onSecondaryContainer: Color(hex: ShannonColorTokens.Dark.textPrimary),
        tertiary: Color(hex: ShannonColorTokens.Dark.create),
        onTertiary: Color(hex: 0x2B2100),
        tertiaryContainer: Color(hex: 0x3D3300),
        surface: Color(hex: ShannonColorTokens.Dark.canvas),
        surfaceContainerLow: Color(hex: ShannonColorTokens.Dark.surface),
        surfaceContainer: Color(hex: ShannonColorTokens.Dark.surfaceTint),
        surfaceContainerHigh: Color(hex: ShannonColorTokens.Dark.surfaceElevated),
        onSurface: Color(hex: ShannonColorTokens.Dark.textPrimary),
        onSurfaceVariant: Color(hex: ShannonColorTokens.Dark.textSecondary),
        outline: Color(hex: ShannonColorTokens.Dark.outline),
        outlineVariant: Color(hex: ShannonColorTokens.Dark.outlineVariant),
        error: Color(hex: ShannonColorTokens.Dark.danger),
        errorContainer: Color(hex: 0x4A1517),
        onErrorContainer: Color(hex: 0xFFE5E6),
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
    public static func shannonAction(for colorScheme: ColorScheme) -> Color {
        Color(hex: colorScheme == .dark
            ? ShannonColorTokens.Dark.actionPrimary
            : ShannonColorTokens.Light.actionPrimary)
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
