import Foundation

public enum ShannonGeminiTextSendState: Equatable, Sendable {
    case idle
    case sending(text: String)
    case failed(text: String, message: String)

    public var isSending: Bool {
        if case .sending = self { true } else { false }
    }

    public var failedText: String? {
        if case let .failed(text, _) = self { text } else { nil }
    }

    mutating func preservePendingText(message: String) {
        guard case let .sending(text) = self else { return }
        self = .failed(text: text, message: message)
    }
}
