import Foundation

/// The device-action outbox (`docs/device-actions-contract.md`): this device takes what Shannon asked of the owner's
/// devices, does it, and reports each action once. Only the paired device's own token is used.
public protocol ShannonDeviceActionServing: Sendable {
    /// Whether this app is paired (only a paired device of the owner takes actions).
    func deviceActionsPaired() -> Bool
    /// `GET /v1/device/actions`. With `wait` the server holds the answer up to 15 s until an action arrives.
    func pollDeviceActions(platform: String, foreground: Bool, inCall: Bool, kinds: [String], wait: Bool) async throws -> ShannonDeviceActionPollDTO
    /// `POST /v1/device/actions/{id}/result`. A repeated report is answered with what was recorded.
    func reportDeviceAction(id: String, report: ShannonDeviceActionReportDTO) async throws -> ShannonDeviceActionReportResponseDTO
    /// `POST /v1/device/music/plays`.
    func reportMusicPlay(_ play: ShannonMusicPlayReportDTO) async throws
}

extension ShannonAPIClient: ShannonDeviceActionServing {
    static let deviceActionsPath = "/v1/device/actions"
    static let deviceMusicPlaysPath = "/v1/device/music/plays"

    public func deviceActionsPaired() -> Bool {
        currentConnection() != nil
    }

    public func pollDeviceActions(platform: String, foreground: Bool, inCall: Bool, kinds: [String], wait: Bool) async throws -> ShannonDeviceActionPollDTO {
        guard let connection = currentConnection() else { throw ShannonDeviceActionError.notPaired }
        guard var components = URLComponents(url: baseURL.appending(path: Self.deviceActionsPath), resolvingAgainstBaseURL: false) else {
            throw ShannonAPIError.invalidResponse
        }
        components.queryItems = [
            URLQueryItem(name: "platform", value: platform),
            URLQueryItem(name: "foreground", value: foreground ? "1" : "0"),
            URLQueryItem(name: "call", value: inCall ? "1" : "0"),
            URLQueryItem(name: "kinds", value: kinds.joined(separator: ",")),
            URLQueryItem(name: "wait", value: wait ? "1" : "0"),
        ]
        guard let url = components.url else { throw ShannonAPIError.invalidResponse }
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.timeoutInterval = wait ? 25 : 15
        authorize(&request, connection: connection)
        return try await response(ShannonDeviceActionPollDTO.self, for: request)
    }

    public func reportDeviceAction(id: String, report: ShannonDeviceActionReportDTO) async throws -> ShannonDeviceActionReportResponseDTO {
        var request = try deviceActionPost(path: "\(Self.deviceActionsPath)/\(id)/result")
        request.httpBody = try JSONEncoder().encode(report)
        return try await response(ShannonDeviceActionReportResponseDTO.self, for: request)
    }

    public func reportMusicPlay(_ play: ShannonMusicPlayReportDTO) async throws {
        var request = try deviceActionPost(path: Self.deviceMusicPlaysPath)
        request.httpBody = try JSONEncoder().encode(play)
        let (_, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw ShannonAPIError.invalidResponse }
        guard (200..<300).contains(http.statusCode) else { throw ShannonAPIError.rejected(status: http.statusCode) }
    }

    private func deviceActionPost(path: String) throws -> URLRequest {
        guard let connection = currentConnection() else { throw ShannonDeviceActionError.notPaired }
        var request = URLRequest(url: baseURL.appending(path: path))
        request.httpMethod = "POST"
        request.timeoutInterval = 20
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        authorize(&request, connection: connection)
        return request
    }
}
