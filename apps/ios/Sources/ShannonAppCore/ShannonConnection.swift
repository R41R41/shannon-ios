import Foundation
import Observation
import Security

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

public struct ShannonKeychainConnectionStore: ShannonConnectionStoreProtocol, Sendable {
    private let service: String
    private let account: String

    public init(
        service: String = "com.r41r41.shannon.connection",
        account: String = "primary-device"
    ) {
        self.service = service
        self.account = account
    }

    public func load() throws -> ShannonConnectionCredential? {
        var query = baseQuery
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = result as? Data else {
            throw ShannonConnectionError.keychain(status)
        }
        do {
            return try JSONDecoder().decode(ShannonConnectionCredential.self, from: data)
        } catch {
            throw ShannonConnectionError.invalidStoredCredential
        }
    }

    public func save(_ credential: ShannonConnectionCredential) throws {
        let data = try JSONEncoder().encode(credential)
        let attributes: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
        ]
        let status = SecItemUpdate(baseQuery as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            var add = baseQuery
            for (key, value) in attributes { add[key] = value }
            let addStatus = SecItemAdd(add as CFDictionary, nil)
            guard addStatus == errSecSuccess else { throw ShannonConnectionError.keychain(addStatus) }
        } else if status != errSecSuccess {
            throw ShannonConnectionError.keychain(status)
        }
    }

    public func delete() throws {
        let status = SecItemDelete(baseQuery as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw ShannonConnectionError.keychain(status)
        }
    }

    private var baseQuery: [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
    }
}

public enum ShannonConnectionError: Error, Equatable, LocalizedError {
    case insecureServer
    case invalidCode
    case invalidConnectionLink
    case invalidResponse
    case rejected(status: Int)
    case expiredCredential
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
        case .invalidStoredCredential:
            "保存された接続情報を読み取れませんでした。"
        case .keychain:
            "iPhoneのKeychainへ接続情報を保存できませんでした。"
        }
    }
}

public enum ShannonConnectionStatus: Equatable, Sendable {
    case disconnected
    case connecting
    case connected(deviceName: String)
    case failed(message: String)
}

@MainActor
@Observable
public final class ShannonConnectionModel {
    public private(set) var status: ShannonConnectionStatus = .disconnected

    public let baseURL: URL
    private let store: any ShannonConnectionStoreProtocol
    private let session: URLSession
    private let deviceName: @Sendable () -> String

    public init(
        baseURL: URL,
        store: any ShannonConnectionStoreProtocol = ShannonKeychainConnectionStore(),
        session: URLSession = .shared,
        deviceName: @escaping @Sendable () -> String = { "iPhone" }
    ) {
        self.baseURL = baseURL
        self.store = store
        self.session = session
        self.deviceName = deviceName
        refreshFromKeychain()
    }

    public var isConnected: Bool {
        if case .connected = status { return true }
        return false
    }

    public var statusLabel: String {
        switch status {
        case .disconnected: "未接続"
        case .connecting: "接続中…"
        case .connected(let deviceName): "接続済み・\(deviceName)"
        case .failed: "接続エラー"
        }
    }

    public func refreshFromKeychain() {
        do {
            guard let credential = try store.load(), credential.baseURL == baseURL else {
                status = .disconnected
                return
            }
            guard credential.expiresAt > Date() else {
                try store.delete()
                status = .failed(message: ShannonConnectionError.expiredCredential.localizedDescription)
                return
            }
            status = .connected(deviceName: credential.displayName)
        } catch {
            status = .failed(message: userMessage(for: error))
        }
    }

    @discardableResult
    public func connect(using url: URL) async -> Bool {
        if isConnected { return true }
        guard let code = Self.pairingCode(from: url) else {
            status = .failed(message: ShannonConnectionError.invalidConnectionLink.localizedDescription)
            return false
        }
        return await pair(code: code)
    }

    @discardableResult
    public func pair(code: String) async -> Bool {
        if isConnected { return true }
        if case .connecting = status { return false }
        let normalized = code.replacingOccurrences(of: "-", with: "")
            .replacingOccurrences(of: " ", with: "")
            .uppercased()
        guard normalized.range(of: "^[A-F0-9]{12}$", options: .regularExpression) != nil else {
            status = .failed(message: ShannonConnectionError.invalidCode.localizedDescription)
            return false
        }
        guard Self.isAllowedPairingURL(baseURL) else {
            status = .failed(message: ShannonConnectionError.insecureServer.localizedDescription)
            return false
        }

        status = .connecting
        do {
            var request = URLRequest(url: baseURL.appending(path: "/v1/pair"))
            request.httpMethod = "POST"
            request.timeoutInterval = 15
            request.setValue("application/json", forHTTPHeaderField: "content-type")
            request.httpBody = try JSONEncoder().encode(PairingRequest(code: normalized, deviceName: deviceName()))
            let (data, response) = try await session.data(for: request)
            guard let http = response as? HTTPURLResponse else { throw ShannonConnectionError.invalidResponse }
            guard (200..<300).contains(http.statusCode) else {
                throw ShannonConnectionError.rejected(status: http.statusCode)
            }
            let paired = try JSONDecoder().decode(PairingResponse.self, from: data)
            guard paired.token.range(of: "^[A-Za-z0-9_-]{43}$", options: .regularExpression) != nil,
                  !paired.deviceId.isEmpty,
                  !paired.scopeKey.isEmpty,
                  let expiresAt = try? Date(paired.expiresAt, strategy: .iso8601),
                  expiresAt > Date() else {
                throw ShannonConnectionError.invalidResponse
            }
            let credential = ShannonConnectionCredential(
                baseURL: baseURL,
                token: paired.token,
                deviceID: paired.deviceId,
                scopeKey: paired.scopeKey,
                displayName: paired.displayName,
                expiresAt: expiresAt
            )
            try store.save(credential)
            status = .connected(deviceName: paired.displayName)
            return true
        } catch {
            status = .failed(message: userMessage(for: error))
            return false
        }
    }

    public static func pairingCode(from url: URL) -> String? {
        guard url.scheme?.lowercased() == "shannon",
              url.host?.lowercased() == "connect",
              let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              let code = components.queryItems?.first(where: { $0.name == "code" })?.value else {
            return nil
        }
        let normalized = code.replacingOccurrences(of: "-", with: "")
            .replacingOccurrences(of: " ", with: "")
            .uppercased()
        return normalized.range(of: "^[A-F0-9]{12}$", options: .regularExpression) != nil
            ? normalized
            : nil
    }

    public func disconnect() {
        do {
            try store.delete()
            status = .disconnected
        } catch {
            status = .failed(message: userMessage(for: error))
        }
    }

    public static func isAllowedPairingURL(_ url: URL) -> Bool {
        if url.scheme?.lowercased() == "https" { return true }
#if DEBUG
        guard url.scheme?.lowercased() == "http", let host = url.host?.lowercased() else { return false }
        if host == "127.0.0.1" || host == "localhost" || host.hasSuffix(".local") { return true }
        let octets = host.split(separator: ".").compactMap { Int($0) }
        guard octets.count == 4 else { return false }
        return octets[0] == 10
            || (octets[0] == 172 && (16...31).contains(octets[1]))
            || (octets[0] == 192 && octets[1] == 168)
#else
        return false
#endif
    }

    private func userMessage(for error: Error) -> String {
        (error as? LocalizedError)?.errorDescription ?? "シャノンへ接続できませんでした。"
    }
}

private struct PairingRequest: Encodable {
    let code: String
    let deviceName: String
}

private struct PairingResponse: Decodable {
    let token: String
    let deviceId: String
    let scopeKey: String
    let displayName: String
    let expiresAt: String
}
