import Foundation

public enum ShannonAPIError: Error, Equatable {
    case invalidResponse
    case rejected(status: Int)
    case realtimeVoiceRejected(status: Int, code: String?)
}

struct ShannonRealtimeVoiceErrorDTO: Decodable {
    let error: String?
}

public struct ShannonAPIClient: ShannonAPIClientProtocol, Sendable {
    public let baseURL: URL
    let apiToken: String?
    let connectionStore: (any ShannonConnectionStoreProtocol)?
    let session: URLSession

    public init(
        baseURL: URL = URL(string: "http://127.0.0.1:4317")!,
        apiToken: String? = nil,
        connectionStore: (any ShannonConnectionStoreProtocol)? = nil,
        session: URLSession = .shared
    ) {
        self.baseURL = baseURL
        self.apiToken = apiToken
        self.connectionStore = connectionStore
        self.session = session
    }
}
