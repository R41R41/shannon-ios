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
        primary: Color(hex: 0x00658A),
        onPrimary: .white,
        primaryContainer: Color(hex: 0xC3E8FF),
        onPrimaryContainer: Color(hex: 0x001E2C),
        secondary: Color(hex: 0x4E616D),
        secondaryContainer: Color(hex: 0xD1E5F2),
        onSecondaryContainer: Color(hex: 0x0A1E28),
        tertiary: Color(hex: 0x5C5B7D),
        tertiaryContainer: Color(hex: 0xE3DFFF),
        surface: Color(hex: 0xF8FCFF),
        surfaceContainerLow: Color(hex: 0xF0F8FC),
        surfaceContainer: Color(hex: 0xEAF4F9),
        surfaceContainerHigh: Color(hex: 0xE3EEF4),
        onSurface: Color(hex: 0x171C1F),
        onSurfaceVariant: Color(hex: 0x40484D),
        outline: Color(hex: 0x70787D),
        outlineVariant: Color(hex: 0xC0C8CD),
        error: Color(hex: 0xB3261E),
        errorContainer: Color(hex: 0xF9DEDC),
        onErrorContainer: Color(hex: 0x410E0B)
    )

    static let dark = M3Palette(
        primary: Color(hex: 0x80D1FF),
        onPrimary: Color(hex: 0x00344A),
        primaryContainer: Color(hex: 0x004C68),
        onPrimaryContainer: Color(hex: 0xC3E8FF),
        secondary: Color(hex: 0xB5C9D5),
        secondaryContainer: Color(hex: 0x354A55),
        onSecondaryContainer: Color(hex: 0xD1E5F2),
        tertiary: Color(hex: 0xC6C2EA),
        tertiaryContainer: Color(hex: 0x444365),
        surface: Color(hex: 0x101417),
        surfaceContainerLow: Color(hex: 0x171C1F),
        surfaceContainer: Color(hex: 0x1B2023),
        surfaceContainerHigh: Color(hex: 0x252B2E),
        onSurface: Color(hex: 0xDFE3E6),
        onSurfaceVariant: Color(hex: 0xC0C8CD),
        outline: Color(hex: 0x8A9297),
        outlineVariant: Color(hex: 0x40484D),
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
