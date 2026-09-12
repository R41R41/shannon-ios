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
        let palette = ShannonPalette.resolve(colorScheme)

        ZStack {
            Circle().fill(Color.white)
            avatarImage
                .resizable()
                .scaledToFill()
                .scaleEffect(expression.avatarScale)
        }
            .frame(width: size, height: size)
            .clipShape(Circle())
            .overlay {
                Circle()
                    .stroke(palette.divider.opacity(0.75), lineWidth: max(1, size / 48))
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

public struct ShannonExpressionPortraitView: View {
    public let expression: ShannonExpressionDTO

    public init(expression: ShannonExpressionDTO) {
        self.expression = expression
    }

    public var body: some View {
        portraitImage
            .resizable()
            .scaledToFit()
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(expression.accessibilityDescription)
    }

    private var portraitImage: Image {
#if canImport(UIKit)
        if let image = ShannonExpressionAssets.uiImage(for: expression) {
            return Image(uiImage: image)
        }
        return Image(systemName: "person.crop.rectangle")
#elseif canImport(AppKit)
        if let image = ShannonExpressionAssets.nsImage(for: expression) {
            return Image(nsImage: image)
        }
        return Image(systemName: "person.crop.rectangle")
#else
        return Image(systemName: "person.crop.rectangle")
#endif
    }
}

public struct ShannonDialogueStagePortraitView: View {
    public init() {}

    public var body: some View {
        stageImage
            .resizable()
            .scaledToFit()
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("シャノン")
    }

    private var stageImage: Image {
#if canImport(UIKit)
        if let url = ShannonDialogueAssets.stagePortraitURL,
           let image = UIImage(contentsOfFile: url.path) {
            return Image(uiImage: image)
        }
        return Image(systemName: "person.crop.rectangle")
#elseif canImport(AppKit)
        if let url = ShannonDialogueAssets.stagePortraitURL,
           let image = NSImage(contentsOf: url) {
            return Image(nsImage: image)
        }
        return Image(systemName: "person.crop.rectangle")
#else
        return Image(systemName: "person.crop.rectangle")
#endif
    }
}
