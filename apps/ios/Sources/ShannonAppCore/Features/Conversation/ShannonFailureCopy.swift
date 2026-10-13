import Foundation

/// Why a request did not go through, derived only from the error the client already has.
public enum ShannonFailureCause: Equatable, Sendable {
    case offline
    case timedOut
    case unreachable
    case tooLong
    case tooLarge
    case busy
    case notAuthorized
    case unavailable
    case rejected
    case serverFailed
    case unknown

    public init(_ error: Error, messageLength: Int = 0) {
        if let urlError = error as? URLError {
            switch urlError.code {
            case .notConnectedToInternet, .networkConnectionLost, .dataNotAllowed, .internationalRoamingOff:
                self = .offline
            case .timedOut:
                self = .timedOut
            case .cannotFindHost, .cannotConnectToHost, .dnsLookupFailed, .secureConnectionFailed:
                self = .unreachable
            default:
                self = .unknown
            }
            return
        }
        let status: Int
        switch error as? ShannonAPIError {
        case .rejected(let value), .realtimeVoiceRejected(let value, _): status = value
        case .invalidResponse: self = .serverFailed; return
        case nil: self = .unknown; return
        }
        switch status {
        case 400: self = messageLength > Self.maximumMessageLength ? .tooLong : .rejected
        case 401, 403: self = .notAuthorized
        case 408, 504: self = .timedOut
        case 409: self = .unavailable
        case 413: self = .tooLarge
        case 429: self = .busy
        case 500...599: self = .serverFailed
        default: self = .unknown
        }
    }

    /// The API accepts a message of up to this many characters.
    public static let maximumMessageLength = 8_000
}

/// Owner-facing copy for a failed request: what happened and what to do next.
/// It never points the owner at infrastructure they cannot operate.
public enum ShannonFailureCopy {
    public static func send(_ error: Error, messageLength: Int, includesPhoto: Bool = false) -> String {
        switch ShannonFailureCause(error, messageLength: messageLength) {
        case .offline:
            "インターネットにつながっていません。接続を確認して「再送」してください。"
        case .timedOut:
            "シャノンの返事が時間内に届きませんでした。少し待って「再送」してください。"
        case .unreachable:
            "シャノンのサーバーに接続できません。少し待って「再送」してください。"
        case .tooLong:
            "メッセージが長すぎます（8,000文字まで）。分けて送ってください。"
        case .tooLarge:
            "添付を含めた内容が大きすぎます。添付を減らすか、分けて送ってください。"
        case .busy:
            "いま混み合っています。少し待って「再送」してください。"
        case .notAuthorized:
            "この端末の接続が無効になっています。設定の「接続」からつなぎ直してください。"
        case .rejected:
            "この内容は送信できませんでした。添付と文字数を確認してください。"
        case .unavailable, .serverFailed:
            "シャノン側で返事を作れませんでした。少し待って「再送」してください。"
        case .unknown:
            includesPhoto
                ? "写真を確認または送信できませんでした。「再送」できます。"
                : "送信できませんでした。少し待って「再送」してください。"
        }
    }

    /// The server took back a reply it had begun to show (docs/chat-stream-contract.md): the words are gone.
    public static let streamRetracted = "シャノンの返事が途中で取り消されました。少し待って「再送」してください。"

    /// The reply stopped arriving partway. The server may still finish it; the app looks for it before 再送 sends again.
    public static let streamInterrupted = "返事が途中で途切れました。届いていれば自動で表示します。表示されなければ「再送」してください。"

    /// 再送 could not read the Talk to see whether the cut-off turn was finished; the next 再送 sends it.
    public static let streamUnconfirmed = "前の返事が届いたか確かめられませんでした。接続を確認して、もう一度「再送」してください。"

    public static func agentTaskStart(_ error: Error) -> String {
        switch ShannonFailureCause(error) {
        case .offline:
            "インターネットにつながっていないため、作業を開始できませんでした。接続を確認してもう一度お試しください。"
        case .timedOut, .unreachable:
            "シャノンのサーバーに接続できず、作業を開始できませんでした。少し待ってもう一度お試しください。"
        case .unavailable:
            "選んだ実行先がいま使えないため、作業を開始できませんでした。実行先を選び直してください。"
        case .notAuthorized:
            "この端末の接続が無効になっています。設定の「接続」からつなぎ直してください。"
        case .rejected, .tooLong, .tooLarge:
            "作業の内容を受け付けられませんでした。会話でもう一度頼み直してください。"
        case .busy, .serverFailed, .unknown:
            "作業を開始できませんでした。少し待ってもう一度お試しください。"
        }
    }
}
