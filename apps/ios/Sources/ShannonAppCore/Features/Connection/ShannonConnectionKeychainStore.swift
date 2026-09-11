import Foundation
import Security

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
