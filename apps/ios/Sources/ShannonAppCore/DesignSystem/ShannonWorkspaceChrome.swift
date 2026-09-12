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
    case memory

    var id: Int { rawValue }
    var title: String {
        switch self {
        case .talk: "トーク"
        case .work: "作業全体"
        case .memory: "頭の中"
        }
    }
    var symbol: String {
        switch self {
        case .talk: "bubble.left.and.bubble.right.fill"
        case .work: "point.3.connected.trianglepath.dotted"
        case .memory: "brain.head.profile.fill"
        }
    }
}

enum ShannonWorkspaceChrome {
    static let contentTopInset: CGFloat = 72
    static let contentBottomInset: CGFloat = 112
    static let bottomReadabilityHeight: CGFloat = contentBottomInset + 80
}

struct ShannonAppHeader: View {
    let selection: ShannonWorkspacePage
    let unreadInitiativeCount: Int
    let openThreadDrawer: () -> Void
    let createThread: () -> Void
    @Environment(\.colorScheme) var colorScheme

    var body: some View {
        let palette = ShannonPalette.resolve(colorScheme)

        HStack(spacing: 0) {
            Button(action: openThreadDrawer) {
                ZStack(alignment: .topTrailing) {
                    Image(systemName: "sidebar.left")
                        .font(.system(size: 18, weight: .medium))
                        .foregroundStyle(palette.textPrimary)
                        .frame(width: ShannonTouchTarget.minimum, height: ShannonTouchTarget.minimum)
                    if unreadInitiativeCount > 0 {
                        Text(unreadInitiativeCount > 9 ? "9+" : "\(unreadInitiativeCount)")
                            .font(.system(size: 9, weight: .bold))
                            .foregroundStyle(.white)
                            .padding(.horizontal, unreadInitiativeCount > 9 ? 4 : 3)
                            .frame(minWidth: 15, minHeight: 15)
                            .background(palette.danger, in: Capsule())
                            .offset(x: 1, y: 1)
                    }
                }
                .frame(width: 48, height: 48)
                .background(.ultraThinMaterial, in: Circle())
                .overlay {
                    Circle().stroke(palette.divider.opacity(0.6), lineWidth: 0.7)
                }
                .shadow(color: .black.opacity(colorScheme == .dark ? 0.28 : 0.10), radius: 9, y: 3)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("メニュー")

            Spacer(minLength: 0)

            Button(action: createThread) {
                Image(systemName: "square.and.pencil")
                    .font(.system(size: 18, weight: .medium))
                    .foregroundStyle(palette.textPrimary)
                    .frame(width: ShannonTouchTarget.minimum, height: ShannonTouchTarget.minimum)
                    .frame(width: 48, height: 48)
                    .background(.ultraThinMaterial, in: Circle())
                    .overlay {
                        Circle().stroke(palette.divider.opacity(0.6), lineWidth: 0.7)
                    }
                    .shadow(color: .black.opacity(colorScheme == .dark ? 0.28 : 0.10), radius: 9, y: 3)
            }
            .buttonStyle(.plain)
            .opacity(selection == .talk ? 1 : 0)
            .allowsHitTesting(selection == .talk)
            .accessibilityHidden(selection != .talk)
            .accessibilityLabel("新しいトーク")
        }
        .padding(.horizontal, ShannonSpacing.large)
        .frame(maxWidth: .infinity)
    }
}

struct ShannonTopReadabilityGradient: View {
    let palette: ShannonPalette

    var body: some View {
        LinearGradient(
            stops: [
                .init(color: palette.canvas.opacity(0.82), location: 0),
                .init(color: palette.canvas.opacity(0.50), location: 0.34),
                .init(color: palette.canvas.opacity(0.16), location: 0.72),
                .init(color: .clear, location: 1),
            ],
            startPoint: .top,
            endPoint: .bottom
        )
        .frame(height: 118)
        .ignoresSafeArea(.container, edges: .top)
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}

struct ShannonBottomReadabilityGradient: View {
    let palette: ShannonPalette
    var bottomSafeAreaInset: CGFloat = 0

    var body: some View {
        LinearGradient(
            stops: [
                .init(color: .clear, location: 0),
                .init(color: palette.canvas.opacity(0.16), location: 0.24),
                .init(color: palette.canvas.opacity(0.58), location: 0.64),
                .init(color: palette.canvas.opacity(0.84), location: 1),
            ],
            startPoint: .top,
            endPoint: .bottom
        )
        .frame(
            height: ShannonWorkspaceChrome.bottomReadabilityHeight + bottomSafeAreaInset
        )
        .accessibilityHidden(true)
    }
}

enum ShannonHaptics {
    static func page() {
#if canImport(UIKit)
        UIImpactFeedbackGenerator(style: .light).impactOccurred(intensity: 0.65)
#endif
    }

    static func drawer() {
#if canImport(UIKit)
        UISelectionFeedbackGenerator().selectionChanged()
#endif
    }
}
