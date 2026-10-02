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

    public func claimPrivateReachOut(id: String) async throws -> ShannonPrivateReachOutClaimDTO {
        let request = try privateListeningRequest(
            path: "\(Self.privateListeningPath)/reach-outs/\(id)/claim", body: PrivateReachOutScope(scopeKey: try pairedScopeKey())
        )
        return try await response(ShannonPrivateReachOutClaimDTO.self, for: request)
    }

    public func reportPrivateReachOut(id: String, outcome: ShannonPrivateReachOutOutcome) async throws {
        let request = try privateListeningRequest(
            path: "\(Self.privateListeningPath)/reach-outs/\(id)/delivery",
            body: PrivateReachOutDelivery(scopeKey: try pairedScopeKey(), outcome: outcome)
        )
        let (_, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw ShannonAPIError.invalidResponse }
        guard (200..<300).contains(http.statusCode) else { throw ShannonAPIError.rejected(status: http.statusCode) }
    }

    private func pairedScopeKey() throws -> String {
        guard let scopeKey = privateListeningScopeKey() else { throw ShannonPrivateListeningError.notPaired }
        return scopeKey
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

private struct PrivateReachOutScope: Encodable {
    let scopeKey: String
}

private struct PrivateReachOutDelivery: Encodable {
    let scopeKey: String
    let outcome: ShannonPrivateReachOutOutcome
}
