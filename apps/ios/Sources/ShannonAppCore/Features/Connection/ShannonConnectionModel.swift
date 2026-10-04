import Foundation
import Observation

@MainActor
@Observable
public final class ShannonConnectionModel {
    public private(set) var status: ShannonConnectionStatus = .disconnected
    public private(set) var verificationStatus: ShannonConnectionVerificationStatus = .idle
    public private(set) var connectedDevices: [ShannonConnectedDevice] = []
    public private(set) var isLoadingDevices = false
    public private(set) var revokingDeviceIDs: Set<String> = []
    public private(set) var deviceManagementError: String?

    public let baseURL: URL
    private let store: any ShannonConnectionStoreProtocol
    private let session: URLSession
    private let deviceName: @Sendable () -> String
    private var connectedDeviceRevision = 0
    /// Runs before this device unpairs, while its token still works (removes what it shared).
    @ObservationIgnored public var beforeDisconnect: (@MainActor () async -> Void)?

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

    public var verificationLabel: String {
        switch verificationStatus {
        case .idle: "未確認"
        case .checking: "確認中…"
        case .verified: "通信確認済み"
        case .failed: "通信確認に失敗"
        }
    }

    public func refreshFromKeychain() {
        verificationStatus = .idle
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
            ShannonOpsModel.forgetArrivedReports()
            connectedDeviceRevision += 1
            connectedDevices = []
            status = .connected(deviceName: paired.displayName)
            verificationStatus = .idle
            return true
        } catch {
            status = .failed(message: userMessage(for: error))
            return false
        }
    }

    @discardableResult
    public func verifyConnection() async -> Bool {
        guard !isVerifying else { return false }
        let credential: ShannonConnectionCredential
        do {
            guard let stored = try store.load(), stored.baseURL == baseURL else {
                status = .disconnected
                verificationStatus = .failed(message: "接続情報がありません。")
                return false
            }
            guard stored.expiresAt > Date() else {
                try store.delete()
                status = .failed(message: ShannonConnectionError.expiredCredential.localizedDescription)
                verificationStatus = .failed(message: ShannonConnectionError.expiredCredential.localizedDescription)
                return false
            }
            credential = stored
        } catch {
            let message = userMessage(for: error)
            status = .failed(message: message)
            verificationStatus = .failed(message: message)
            return false
        }

        verificationStatus = .checking
        do {
            var components = URLComponents(
                url: baseURL.appending(path: "/v1/threads"),
                resolvingAgainstBaseURL: false
            )
            components?.queryItems = [URLQueryItem(name: "scopeKey", value: credential.scopeKey)]
            guard let url = components?.url else { throw ShannonConnectionError.invalidResponse }
            var request = URLRequest(url: url)
            request.httpMethod = "GET"
            request.timeoutInterval = 15
            request.setValue("Bearer \(credential.token)", forHTTPHeaderField: "authorization")
            let (data, response) = try await session.data(for: request)
            guard let http = response as? HTTPURLResponse else { throw ShannonConnectionError.invalidResponse }
            if http.statusCode == 401 {
                try store.delete()
                throw ShannonConnectionError.revokedCredential
            }
            guard (200..<300).contains(http.statusCode) else {
                throw ShannonConnectionError.rejected(status: http.statusCode)
            }
            _ = try JSONDecoder().decode(ThreadListResponseDTO.self, from: data)
            status = .connected(deviceName: credential.displayName)
            verificationStatus = .verified(at: Date())
            return true
        } catch {
            let message = userMessage(for: error)
            if (error as? ShannonConnectionError) == .revokedCredential {
                status = .failed(message: message)
            }
            verificationStatus = .failed(message: message)
            return false
        }
    }

    public var isVerifying: Bool {
        if case .checking = verificationStatus { return true }
        return false
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

    @discardableResult
    public func disconnect() async -> Bool {
        guard let credential = credentialForAuthenticatedRequest() else { return false }
        await beforeDisconnect?()
        do {
            var request = URLRequest(url: baseURL.appending(path: "/v1/devices"))
            request.httpMethod = "POST"
            request.timeoutInterval = 15
            request.setValue("application/json", forHTTPHeaderField: "content-type")
            request.setValue("Bearer \(credential.token)", forHTTPHeaderField: "authorization")
            request.httpBody = try JSONEncoder().encode(DeviceRevocationRequest(
                deviceId: credential.deviceID,
                revokeCurrent: true
            ))
            let (_, response) = try await session.data(for: request)
            guard let http = response as? HTTPURLResponse else { throw ShannonConnectionError.invalidResponse }
            guard (200..<300).contains(http.statusCode) || http.statusCode == 401 else {
                throw ShannonConnectionError.rejected(status: http.statusCode)
            }
            try store.delete()
            ShannonOpsModel.forgetArrivedReports()
            connectedDeviceRevision += 1
            status = .disconnected
            verificationStatus = .idle
            connectedDevices = []
            deviceManagementError = nil
            return true
        } catch {
            deviceManagementError = userMessage(for: error)
            return false
        }
    }

    public func loadConnectedDevices() async {
        guard !isLoadingDevices else { return }
        guard let credential = credentialForAuthenticatedRequest() else { return }
        let revision = connectedDeviceRevision
        isLoadingDevices = true
        deviceManagementError = nil
        defer { isLoadingDevices = false }
        do {
            var request = URLRequest(url: baseURL.appending(path: "/v1/devices"))
            request.httpMethod = "GET"
            request.timeoutInterval = 15
            request.setValue("Bearer \(credential.token)", forHTTPHeaderField: "authorization")
            let (data, response) = try await session.data(for: request)
            try handleAuthenticatedResponse(response)
            let devices = try JSONDecoder().decode(DeviceListResponse.self, from: data).devices
            connectedDevices = Self.applyingLoadedDevices(
                devices,
                loadedAtRevision: revision,
                currentRevision: connectedDeviceRevision,
                currentDevices: connectedDevices
            )
        } catch {
            guard revision == connectedDeviceRevision else { return }
            deviceManagementError = userMessage(for: error)
        }
    }

    @discardableResult
    public func revokeConnectedDevice(_ device: ShannonConnectedDevice) async -> Bool {
        guard !device.isCurrent, !revokingDeviceIDs.contains(device.id) else { return false }
        guard let credential = credentialForAuthenticatedRequest() else { return false }
        revokingDeviceIDs.insert(device.id)
        deviceManagementError = nil
        defer { revokingDeviceIDs.remove(device.id) }
        do {
            var request = URLRequest(url: baseURL.appending(path: "/v1/devices"))
            request.httpMethod = "POST"
            request.timeoutInterval = 15
            request.setValue("application/json", forHTTPHeaderField: "content-type")
            request.setValue("Bearer \(credential.token)", forHTTPHeaderField: "authorization")
            request.httpBody = try JSONEncoder().encode(DeviceRevocationRequest(
                deviceId: device.id,
                revokeCurrent: false
            ))
            let (_, response) = try await session.data(for: request)
            try handleAuthenticatedResponse(response)
            connectedDeviceRevision += 1
            connectedDevices.removeAll { $0.id == device.id }
            return true
        } catch {
            deviceManagementError = userMessage(for: error)
            return false
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

    static func applyingLoadedDevices(
        _ loadedDevices: [ShannonConnectedDevice],
        loadedAtRevision: Int,
        currentRevision: Int,
        currentDevices: [ShannonConnectedDevice]
    ) -> [ShannonConnectedDevice] {
        loadedAtRevision == currentRevision ? loadedDevices : currentDevices
    }

    private func userMessage(for error: Error) -> String {
        (error as? LocalizedError)?.errorDescription ?? "シャノンへ接続できませんでした。"
    }

    private func credentialForAuthenticatedRequest() -> ShannonConnectionCredential? {
        do {
            guard let credential = try store.load(), credential.baseURL == baseURL else {
                deviceManagementError = "接続情報がありません。"
                return nil
            }
            guard credential.expiresAt > Date() else {
                try store.delete()
                status = .failed(message: ShannonConnectionError.expiredCredential.localizedDescription)
                deviceManagementError = ShannonConnectionError.expiredCredential.localizedDescription
                return nil
            }
            return credential
        } catch {
            deviceManagementError = userMessage(for: error)
            return nil
        }
    }

    private func handleAuthenticatedResponse(_ response: URLResponse) throws {
        guard let http = response as? HTTPURLResponse else { throw ShannonConnectionError.invalidResponse }
        if http.statusCode == 401 {
            try store.delete()
            status = .failed(message: ShannonConnectionError.revokedCredential.localizedDescription)
            throw ShannonConnectionError.revokedCredential
        }
        guard (200..<300).contains(http.statusCode) else {
            throw ShannonConnectionError.rejected(status: http.statusCode)
        }
    }
}

struct PairingRequest: Encodable {
    let code: String
    let deviceName: String
}

struct PairingResponse: Decodable {
    let token: String
    let deviceId: String
    let scopeKey: String
    let displayName: String
    let expiresAt: String
}

struct DeviceListResponse: Decodable {
    let devices: [ShannonConnectedDevice]
}

struct DeviceRevocationRequest: Encodable {
    let deviceId: String
    let revokeCurrent: Bool
}
