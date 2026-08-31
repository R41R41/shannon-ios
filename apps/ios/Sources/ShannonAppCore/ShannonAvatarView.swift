import SwiftUI
#if canImport(UIKit)
import UIKit
#elseif canImport(AppKit)
import AppKit
#endif

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

        avatarImage
            .resizable()
            .scaledToFill()
            .scaleEffect(expression.avatarScale)
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

    private var avatarImage: Image {
#if canImport(UIKit)
        if let image = ShannonExpressionAssets.uiImage(for: expression) {
            return Image(uiImage: image)
        }
        return Image(systemName: "person.crop.circle.fill")
#elseif canImport(AppKit)
        if let image = ShannonExpressionAssets.nsImage(for: expression) {
            return Image(nsImage: image)
        }
        return Image(systemName: "person.crop.circle.fill")
#else
        return Image(systemName: "person.crop.circle.fill")
#endif
    }
}
