import Foundation

extension ShannonExpressionDTO {
    var assetName: String {
        "shannon-expression-\(rawValue)"
    }

    var japaneseName: String {
        switch self {
        case .joyful: "うれしい"
        case .curious: "興味津々"
        case .tender: "やさしい"
        case .calm: "穏やか"
        case .concerned: "心配"
        case .sad: "かなしい"
        case .sleepy: "眠そう"
        case .neutral: "いつもの表情"
        }
    }

    var accessibilityDescription: String {
        "Shannonは\(japaneseName)表情"
    }
}

enum ShannonExpressionAssets {
    static func url(for expression: ShannonExpressionDTO) -> URL? {
        Bundle.module.url(forResource: expression.assetName, withExtension: "png")
    }
}
