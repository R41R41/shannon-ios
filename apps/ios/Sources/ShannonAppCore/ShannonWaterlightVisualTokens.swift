import SwiftUI

/// Exact app-owned constants from the approved Waterlight motion study.
/// Keep these separate from the suite-wide intelligence palette: the character's
/// face is a specific visual asset, while the shared palette serves interface roles.
enum ShannonWaterlightVisualTokens {
    static let faceTop: UInt = 0x11243B
    static let faceMiddle: UInt = 0x081522
    static let faceBottom: UInt = 0x03070C
    static let faceGlow: UInt = 0x214F77
    static let border: UInt = 0x8EEAFF
    static let scanline: UInt = 0x9BDFF0
    static let glassSheen: UInt = 0xB8F5FF
    static let eyeTop: UInt = 0xC4FBFF
    static let eyeMiddle: UInt = 0x76E7FF
    static let eyeBottom: UInt = 0x6397FF
    static let eyeSheen: UInt = 0xE4FDFF
    static let blush: UInt = 0xF8C4CD

    static let bodyRadiusRatio: CGFloat = 68.0 / 160.0
    static let cornerRadiusRatio: CGFloat = 43.0 / 160.0
    static let borderInsetRatio: CGFloat = 1.2 / 160.0
    static let borderCornerRadiusRatio: CGFloat = 41.8 / 160.0
    static let borderWidthRatio: CGFloat = 1.45 / 160.0
    static let scanlineSpacingRatio: CGFloat = 4.0 / 160.0
    static let scanlineWidthRatio: CGFloat = 0.45 / 160.0

    static var eyeGradient: [Color] {
        [Color(hex: eyeTop), Color(hex: eyeMiddle), Color(hex: eyeBottom)]
    }
}
