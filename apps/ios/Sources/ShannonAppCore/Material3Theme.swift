import SwiftUI

struct M3Palette {
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

    static let light = M3Palette(
        primary: Color(hex: 0x6750A4),
        onPrimary: .white,
        primaryContainer: Color(hex: 0xEADDFF),
        onPrimaryContainer: Color(hex: 0x21005D),
        secondary: Color(hex: 0x625B71),
        secondaryContainer: Color(hex: 0xE8DEF8),
        onSecondaryContainer: Color(hex: 0x1D192B),
        tertiary: Color(hex: 0x7D5260),
        tertiaryContainer: Color(hex: 0xFFD8E4),
        surface: Color(hex: 0xFFFBFE),
        surfaceContainerLow: Color(hex: 0xF7F2FA),
        surfaceContainer: Color(hex: 0xF3EDF7),
        surfaceContainerHigh: Color(hex: 0xECE6F0),
        onSurface: Color(hex: 0x1D1B20),
        onSurfaceVariant: Color(hex: 0x49454F),
        outline: Color(hex: 0x79747E),
        outlineVariant: Color(hex: 0xCAC4D0),
        error: Color(hex: 0xB3261E),
        errorContainer: Color(hex: 0xF9DEDC),
        onErrorContainer: Color(hex: 0x410E0B)
    )

    static let dark = M3Palette(
        primary: Color(hex: 0xD0BCFF),
        onPrimary: Color(hex: 0x381E72),
        primaryContainer: Color(hex: 0x4F378B),
        onPrimaryContainer: Color(hex: 0xEADDFF),
        secondary: Color(hex: 0xCCC2DC),
        secondaryContainer: Color(hex: 0x4A4458),
        onSecondaryContainer: Color(hex: 0xE8DEF8),
        tertiary: Color(hex: 0xEFB8C8),
        tertiaryContainer: Color(hex: 0x633B48),
        surface: Color(hex: 0x141218),
        surfaceContainerLow: Color(hex: 0x1D1B20),
        surfaceContainer: Color(hex: 0x211F26),
        surfaceContainerHigh: Color(hex: 0x2B2930),
        onSurface: Color(hex: 0xE6E0E9),
        onSurfaceVariant: Color(hex: 0xCAC4D0),
        outline: Color(hex: 0x938F99),
        outlineVariant: Color(hex: 0x49454F),
        error: Color(hex: 0xF2B8B5),
        errorContainer: Color(hex: 0x8C1D18),
        onErrorContainer: Color(hex: 0xF9DEDC)
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

