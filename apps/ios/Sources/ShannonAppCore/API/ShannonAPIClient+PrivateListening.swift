import Foundation

extension ShannonAPIClient: ShannonPrivateListeningServing {
    static let privateListeningPath = "/v1/private-listening"

    public func privateListeningScopeKey() -> String? {
        currentConnection()?.scopeKey
    }

    public func reportPrivateListening(
        _ report: ShannonPrivateListeningReportDTO
    ) async throws -> ShannonPrivateListeningResponseDTO {
        let request = try privateListeningRequest(path: Self.privateListeningPath, body: report)
        return try await response(ShannonPrivateListeningResponseDTO.self, for: request)
    }

    /// Only the paired device's own token is used; the build-time token never reports.
    func privateListeningRequest(path: String, body: some Encodable) throws -> URLRequest {
        guard let connection = currentConnection() else { throw ShannonPrivateListeningError.notPaired }
        var request = URLRequest(url: baseURL.appending(path: path))
        request.httpMethod = "POST"
        request.timeoutInterval = 20
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        authorize(&request, connection: connection)
        request.httpBody = try JSONEncoder().encode(body)
        return request
    }
}
