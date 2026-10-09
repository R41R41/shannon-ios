import Foundation

extension ShannonGeminiLiveSessionModel {
    @discardableResult
    public func sendText(_ text: String) -> Bool {
        let value = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty else { return false }
        guard value.utf16.count <= 8_000 else {
            textSendState = .failed(text: value, message: "入力が長すぎます。短く分けて送信してください。")
            return false
        }
        guard transport != nil, performDelegation != nil, streamSpeech != nil, phase != .failed else {
            textSendState = .failed(
                text: value,
                message: "音声会話へ接続してから、もう一度送信してください。"
            )
            return false
        }
        interruptResponse()
        appendUtterance(rawText: value, text: value, source: .typed)
        userTranscript = pendingTurns.displayText
        textSendState = .sending(text: value)
        beginResponse()
        return true
    }

    @discardableResult
    public func retryText() -> Bool {
        guard let text = textSendState.failedText else { return false }
        if pendingTurns.turns.contains(where: { $0.source == .typed && $0.text == text }),
           transport != nil, phase != .failed {
            textSendState = .sending(text: text)
            beginResponse()
            return true
        }
        textSendState = .idle
        return sendText(text)
    }

}
