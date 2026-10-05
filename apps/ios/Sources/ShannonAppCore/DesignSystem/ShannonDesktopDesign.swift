import SwiftUI

/// The shared look for wide screens (the Mac app), taken from the one product spec
/// (`design/tokens.json`): fixed text sizes with body 15 (owner decision 2026-10-03),
/// the spacing and radius scale, and the colour roles. The phone keeps Dynamic Type and
/// the internal `ShannonPalette` / `ShannonSpacing` / `ShannonShape`; the Mac target is a
/// separate module, so it reads these public names instead.
public enum ShannonDesktopTextStyle: CaseIterable, Sendable {
    case largeTitle, title, title2, title3, headline, body, callout, subheadline, footnote, caption, caption2

    public var token: ShannonGeneratedTokens.TextStyle {
        typealias Scale = ShannonGeneratedTokens.DesktopTypography
        switch self {
        case .largeTitle: return Scale.largeTitle
        case .title: return Scale.title
        case .title2: return Scale.title2
        case .title3: return Scale.title3
        case .headline: return Scale.headline
        case .body: return Scale.body
        case .callout: return Scale.callout
        case .subheadline: return Scale.subheadline
        case .footnote: return Scale.footnote
        case .caption: return Scale.caption
        case .caption2: return Scale.caption2
        }
    }
}

extension ShannonDesktopTextStyle {
    /// The phone's font of the same name, exactly as `Font.headline` and so on.
    public var dynamicTypeFont: Font {
        switch self {
        case .largeTitle: .largeTitle
        case .title: .title
        case .title2: .title2
        case .title3: .title3
        case .headline: .headline
        case .body: .body
        case .callout: .callout
        case .subheadline: .subheadline
        case .footnote: .footnote
        case .caption: .caption
        case .caption2: .caption2
        }
    }

    /// The Dynamic Type style of the same name (the phone's scale).
    public var textStyle: Font.TextStyle {
        switch self {
        case .largeTitle: .largeTitle
        case .title: .title
        case .title2: .title2
        case .title3: .title3
        case .headline: .headline
        case .body: .body
        case .callout: .callout
        case .subheadline: .subheadline
        case .footnote: .footnote
        case .caption: .caption
        case .caption2: .caption2
        }
    }
}

extension Font {
    /// A text style of the shared views: on the phone exactly the Dynamic Type style
    /// (`.headline` and so on), on the Mac the same step of the fixed desktop scale, so that
    /// headings stay above the body text of 15 there (owner decision 2026-10-03).
    public static func shannon(_ style: ShannonDesktopTextStyle) -> Font {
#if os(macOS)
        shannonDesktop(style)
#else
        style.dynamicTypeFont
#endif
    }

    /// The same with a design (for example monospaced code).
    public static func shannon(_ style: ShannonDesktopTextStyle, design: Font.Design) -> Font {
#if os(macOS)
        .system(size: style.token.size, weight: Font.Weight(shannonTokenWeight: style.token.weight), design: design)
#else
        .system(style.textStyle, design: design)
#endif
    }

    /// A wide-screen text style at its fixed size and weight (`typography.desktop`).
    public static func shannonDesktop(_ style: ShannonDesktopTextStyle) -> Font {
        let token = style.token
        return .system(size: token.size, weight: Font.Weight(shannonTokenWeight: token.weight))
    }
}

extension Font.Weight {
    init(shannonTokenWeight weight: Int) {
        switch weight {
        case ..<350: self = .light
        case ..<450: self = .regular
        case ..<550: self = .medium
        case ..<650: self = .semibold
        default: self = .bold
        }
    }
}

/// Spacing of the shared scale (4, 8, 12, 16, 24, 32).
public typealias ShannonDesktopSpacing = ShannonGeneratedTokens.Spacing
/// Corner radius of the shared scale (8, 12, 16, 28, full).
public typealias ShannonDesktopRadius = ShannonGeneratedTokens.Radius

public enum ShannonDesktopMetrics {
    /// The height of a sidebar or list row on wide screens.
    public static let rowHeight: CGFloat = ShannonGeneratedTokens.Size.desktopRowHeight
}

extension Color {
    /// Shannon being present (indigo, `intelligence`), where no colour scheme is at hand.
    public static let shannonIntelligenceColor = adaptive(
        light: ShannonColorTokens.Light.brandPresence,
        dark: ShannonColorTokens.Dark.brandPresence
    )
}
