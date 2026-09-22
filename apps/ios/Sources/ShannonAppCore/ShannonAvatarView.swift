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

public enum ShannonChatAvatarStyle: String, CaseIterable, Sendable {
    case expression
    case secondAppIcon

    public static let storageKey = "shannon.chat-avatar.style"
    public static let secondIconChoice: ShannonAppIconChoice = .level06

    public var japaneseName: String {
        switch self {
        case .expression: "表情アイコン"
        case .secondAppIcon: "2つ目のアイコン（L06）"
        }
    }
}

public struct ShannonChatAvatarView: View {
    public let expression: ShannonExpressionDTO
    public let size: CGFloat

    @AppStorage(ShannonChatAvatarStyle.storageKey) private var styleRawValue = ShannonChatAvatarStyle.expression.rawValue
    @Environment(\.colorScheme) private var colorScheme

    public init(expression: ShannonExpressionDTO, size: CGFloat = 44) {
        self.expression = expression
        self.size = size
    }

    public var body: some View {
        if styleRawValue == ShannonChatAvatarStyle.secondAppIcon.rawValue {
            let palette = ShannonPalette.resolve(colorScheme)
            iconImage
                .resizable()
                .scaledToFill()
                .frame(width: size, height: size)
                .clipShape(RoundedRectangle(cornerRadius: size * 0.22, style: .continuous))
                .overlay {
                    RoundedRectangle(cornerRadius: size * 0.22, style: .continuous)
                        .stroke(palette.divider.opacity(0.75), lineWidth: max(1, size / 48))
                }
                .accessibilityElement(children: .ignore)
                .accessibilityLabel("シャノン、2つ目のアイコン")
        } else {
            ShannonAvatarView(expression: expression, size: size)
        }
    }

    private var iconImage: Image {
#if canImport(UIKit)
        if let image = ShannonAppIconAssets.uiImage(for: ShannonChatAvatarStyle.secondIconChoice.previewAssetName) {
            return Image(uiImage: image)
        }
#elseif canImport(AppKit)
        if let image = ShannonAppIconAssets.nsImage(for: ShannonChatAvatarStyle.secondIconChoice.previewAssetName) {
            return Image(nsImage: image)
        }
#endif
        return Image(systemName: "person.crop.circle.fill")
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
