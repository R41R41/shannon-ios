import Foundation

public struct ShannonConnectionCredential: Codable, Equatable, Sendable {
    public let baseURL: URL
    public let token: String
    public let deviceID: String
    public let scopeKey: String
    public let displayName: String
    public let expiresAt: Date

    public init(
        baseURL: URL,
        token: String,
        deviceID: String,
        scopeKey: String,
        displayName: String,
        expiresAt: Date
    ) {
        self.baseURL = baseURL
        self.token = token
        self.deviceID = deviceID
        self.scopeKey = scopeKey
        self.displayName = displayName
        self.expiresAt = expiresAt
    }
}

public protocol ShannonConnectionStoreProtocol: Sendable {
    func load() throws -> ShannonConnectionCredential?
    func save(_ credential: ShannonConnectionCredential) throws
    func delete() throws
}

public enum ShannonConnectionError: Error, Equatable, LocalizedError {
    case insecureServer
    case invalidCode
    case invalidConnectionLink
    case invalidResponse
    case rejected(status: Int)
    case expiredCredential
    case revokedCredential
    case invalidStoredCredential
    case keychain(OSStatus)

    public var errorDescription: String? {
        switch self {
        case .insecureServer:
            "安全なHTTPS接続先が設定されていません。"
        case .invalidCode:
            "接続情報が正しくありません。"
        case .invalidConnectionLink:
            "このリンクはシャノンの接続リンクではありません。"
        case .invalidResponse:
            "接続情報を受け取れませんでした。"
        case .rejected(let status) where status == 401:
            "接続コードが無効か、期限切れです。"
        case .rejected(let status) where status == 429:
            "試行回数が多すぎます。少し待ってください。"
        case .rejected(let status):
            "サーバーに接続できませんでした（HTTP \(status)）。"
        case .expiredCredential:
            "接続の有効期限が切れました。もう一度接続してください。"
        case .revokedCredential:
            "この端末の接続は無効になりました。もう一度接続してください。"
        case .invalidStoredCredential:
            "保存された接続情報を読み取れませんでした。"
        case .keychain:
#if os(macOS)
            "MacのKeychainへ接続情報を保存できませんでした。"
#else
            "iPhoneのKeychainへ接続情報を保存できませんでした。"
#endif
        }
    }
}

public enum ShannonConnectionStatus: Equatable, Sendable {
    case disconnected
    case connecting
    case connected(deviceName: String)
    case failed(message: String)
}

public enum ShannonConnectionVerificationStatus: Equatable, Sendable {
    case idle
    case checking
    case verified(at: Date)
    case failed(message: String)
}

public struct ShannonConnectedDevice: Codable, Equatable, Identifiable, Sendable {
    public let deviceId: String
    public let displayName: String
    public let expiresAt: String
    public let lastUsedAt: String?
    public let isCurrent: Bool

    public var id: String { deviceId }
}
