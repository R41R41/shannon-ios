import Foundation

extension ShannonAPIClient: ShannonModelModeServing {
    @MainActor public func modelModeConnection() -> ShannonModelModeConnection? {
        currentConnection().map(ShannonModelModeConnection.init)
    }

    @MainActor public func loadModelMode() async throws -> ShannonModelModeDTO {
        guard let connection = modelModeConnection() else { throw ShannonModelModeAPIError.pairingRequired }
        return try await loadModelMode(connection: connection)
    }

    @MainActor public func loadModelMode(connection: ShannonModelModeConnection) async throws -> ShannonModelModeDTO {
        try await modelModeRequest(method: "GET", command: nil, expectedConnection: connection)
    }

    @MainActor public func setModelMode(_ mode: ShannonModelMode, expectedRevision: Int) async throws -> ShannonModelModeDTO {
        guard let connection = modelModeConnection() else { throw ShannonModelModeAPIError.pairingRequired }
        return try await setModelMode(mode, expectedRevision: expectedRevision, connection: connection)
    }

    @MainActor public func setModelMode(_ mode: ShannonModelMode, expectedRevision: Int, connection: ShannonModelModeConnection) async throws -> ShannonModelModeDTO {
        guard (0...ShannonModelModeDTO.maximumRevision).contains(expectedRevision) else { throw ShannonAPIError.invalidResponse }
        return try await modelModeRequest(method: "PUT", command: ModelModeCommand(mode: mode, expectedRevision: expectedRevision), expectedConnection: connection)
    }

    private struct ModelModeCommand: Encodable {
        let mode: ShannonModelMode
        let expectedRevision: Int
    }

    @MainActor private func modelModeRequest(method: String, command: ModelModeCommand?, expectedConnection: ShannonModelModeConnection) async throws -> ShannonModelModeDTO {
        // Unlike legacy local API access, this owner-shared setting requires a paired credential.
        try Task.checkCancellation()
        guard let connection = currentConnection() else { throw ShannonModelModeAPIError.pairingRequired }
        let identity = ShannonModelModeConnection(connection)
        guard identity == expectedConnection else { throw ShannonModelModeAPIError.connectionChanged }
        var request = URLRequest(url: baseURL.appending(path: "/v1/model-mode"), cachePolicy: .reloadIgnoringLocalCacheData)
        request.httpMethod = method
        request.setValue("no-store", forHTTPHeaderField: "cache-control")
        authorize(&request, connection: connection)
        if let command {
            request.setValue("application/json", forHTTPHeaderField: "content-type")
            request.httpBody = try JSONEncoder().encode(command)
        }
        let (data, response) = try await session.data(for: request)
        guard modelModeConnection() == identity else { throw ShannonModelModeAPIError.connectionChanged }
        guard let http = response as? HTTPURLResponse else { throw ShannonAPIError.invalidResponse }
        guard (200..<300).contains(http.statusCode) else { throw ShannonModelModeAPIError.rejected(status: http.statusCode) }
        return try JSONDecoder().decode(ShannonModelModeDTO.self, from: data)
    }
}
