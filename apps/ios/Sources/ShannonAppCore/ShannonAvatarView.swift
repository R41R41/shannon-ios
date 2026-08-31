import SwiftUI

public struct ShannonAvatarView: View {
    public let expression: ShannonExpressionDTO
    public let size: CGFloat

    @Environment(\.colorScheme) private var colorScheme

    public init(expression: ShannonExpressionDTO, size: CGFloat = 44) {
        self.expression = expression
        self.size = size
    }

    public var body: some View {
        let palette = M3Palette.resolve(colorScheme)

        Image(expression.assetName, bundle: .module)
            .resizable()
            .scaledToFill()
            .frame(width: size, height: size)
            .clipShape(Circle())
            .overlay {
                Circle()
                    .stroke(palette.outlineVariant.opacity(0.75), lineWidth: max(1, size / 48))
            }
            .shadow(color: .black.opacity(colorScheme == .dark ? 0.22 : 0.10), radius: size / 18, y: size / 36)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(expression.accessibilityDescription)
    }
}

