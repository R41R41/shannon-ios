import SwiftUI
#if canImport(UIKit)
import UIKit
#elseif canImport(AppKit)
import AppKit
#endif

struct ShannonAdaptiveComposerLayout: Layout {
    let isExpanded: Bool
    let spacing: CGFloat

    func sizeThatFits(
        proposal: ProposedViewSize,
        subviews: Subviews,
        cache: inout ()
    ) -> CGSize {
        guard subviews.count == 4 else { return .zero }
        let width = proposal.width ?? intrinsicWidth(for: subviews)

        if isExpanded {
            let fieldSize = subviews[0].sizeThatFits(.init(width: width, height: nil))
            let controlSizes = subviews.dropFirst().map { $0.sizeThatFits(.unspecified) }
            let controlHeight = controlSizes.map(\.height).max() ?? 0
            return CGSize(width: width, height: fieldSize.height + spacing + controlHeight)
        }

        let controlSizes = subviews.dropFirst().map { $0.sizeThatFits(.unspecified) }
        let controlsWidth = controlSizes.reduce(0) { $0 + $1.width }
        let fieldWidth = max(1, width - controlsWidth - spacing * 3)
        let fieldSize = subviews[0].sizeThatFits(.init(width: fieldWidth, height: nil))
        let height = max(fieldSize.height, controlSizes.map(\.height).max() ?? 0)
        return CGSize(width: width, height: height)
    }

    func placeSubviews(
        in bounds: CGRect,
        proposal: ProposedViewSize,
        subviews: Subviews,
        cache: inout ()
    ) {
        guard subviews.count == 4 else { return }

        if isExpanded {
            let fieldSize = subviews[0].sizeThatFits(.init(width: bounds.width, height: nil))
            subviews[0].place(
                at: CGPoint(x: bounds.minX, y: bounds.minY),
                anchor: .topLeading,
                proposal: .init(width: bounds.width, height: fieldSize.height)
            )

            let controlY = bounds.maxY
            let menuSize = subviews[1].sizeThatFits(.unspecified)
            let transcriptionSize = subviews[2].sizeThatFits(.unspecified)
            let primarySize = subviews[3].sizeThatFits(.unspecified)
            subviews[1].place(
                at: CGPoint(x: bounds.minX, y: controlY),
                anchor: .bottomLeading,
                proposal: .init(menuSize)
            )
            subviews[3].place(
                at: CGPoint(x: bounds.maxX, y: controlY),
                anchor: .bottomTrailing,
                proposal: .init(primarySize)
            )
            subviews[2].place(
                at: CGPoint(x: bounds.maxX - primarySize.width - spacing, y: controlY),
                anchor: .bottomTrailing,
                proposal: .init(transcriptionSize)
            )
            return
        }

        let menuSize = subviews[1].sizeThatFits(.unspecified)
        let transcriptionSize = subviews[2].sizeThatFits(.unspecified)
        let primarySize = subviews[3].sizeThatFits(.unspecified)
        let fieldWidth = max(
            1,
            bounds.width - menuSize.width - transcriptionSize.width - primarySize.width - spacing * 3
        )
        let bottomY = bounds.maxY
        var x = bounds.minX

        subviews[1].place(
            at: CGPoint(x: x, y: bottomY),
            anchor: .bottomLeading,
            proposal: .init(menuSize)
        )
        x += menuSize.width + spacing
        subviews[0].place(
            at: CGPoint(x: x, y: bottomY),
            anchor: .bottomLeading,
            proposal: .init(width: fieldWidth, height: nil)
        )
        x += fieldWidth + spacing
        subviews[2].place(
            at: CGPoint(x: x, y: bottomY),
            anchor: .bottomLeading,
            proposal: .init(transcriptionSize)
        )
        subviews[3].place(
            at: CGPoint(x: bounds.maxX, y: bottomY),
            anchor: .bottomTrailing,
            proposal: .init(primarySize)
        )
    }

    func intrinsicWidth(for subviews: Subviews) -> CGFloat {
        subviews.reduce(0) { $0 + $1.sizeThatFits(.unspecified).width } + spacing * 3
    }
}

enum ShannonWorkspacePage: Int, CaseIterable, Identifiable {
    case talk
    case work
    /// 「シャノン」: the card (opens ようす), then 頭の中／自律活動／書斎.
    case shannon

    var id: Int { rawValue }
    var title: String {
        switch self {
        case .talk: "トーク"
        case .work: "作業"
        case .shannon: ShannonGeneratedStrings.navShannon
        }
    }
    var symbol: String {
        switch self {
        case .talk: "bubble.left.and.bubble.right.fill"
        case .work: "point.3.connected.trianglepath.dotted"
        case .shannon: "person.crop.circle"
        }
    }
}

enum ShannonHaptics {
    @MainActor
    static func page() {
#if canImport(UIKit)
        UIImpactFeedbackGenerator(style: .light).impactOccurred(intensity: 0.65)
#endif
    }

}
