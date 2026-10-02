import Foundation

extension ShannonAPIClient: ShannonIncomingCallServing {
    static let incomingCallPath = "/v1/incoming-calls"

    public func incomingCallIsPaired() -> Bool {
        currentConnection() != nil
    }

    public func registerIncomingCalls(
        deviceToken: String, environment: ShannonPushEnvironmentDTO, bundleId: String, enabled: Bool
    ) async throws -> ShannonIncomingCallRegistrationResponseDTO {
        guard let scopeKey = privateListeningScopeKey() else { throw ShannonPrivateListeningError.notPaired }
        let request = try privateListeningRequest(
            path: "\(Self.incomingCallPath)/registration",
            body: ShannonIncomingCallRegistrationDTO(
                scopeKey: scopeKey, deviceToken: deviceToken, environment: environment, bundleId: bundleId, enabled: enabled
            )
        )
        return try await response(ShannonIncomingCallRegistrationResponseDTO.self, for: request)
    }

    public func answerIncomingCall(reachOutID: String, callID: String) async throws -> ShannonPrivateReachOutClaimDTO {
        guard let scopeKey = privateListeningScopeKey() else { throw ShannonPrivateListeningError.notPaired }
        let request = try privateListeningRequest(
            path: "\(Self.privateListeningPath)/reach-outs/\(reachOutID)/claim",
            body: IncomingCallAnswer(scopeKey: scopeKey, callId: callID)
        )
        return try await response(ShannonPrivateReachOutClaimDTO.self, for: request)
    }

    public func reportIncomingCall(callID: String, outcome: ShannonIncomingCallOutcome) async throws {
        guard let scopeKey = privateListeningScopeKey() else { throw ShannonPrivateListeningError.notPaired }
        let request = try privateListeningRequest(
            path: "\(Self.incomingCallPath)/\(callID)/report",
            body: IncomingCallReport(scopeKey: scopeKey, outcome: outcome)
        )
        let (_, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw ShannonAPIError.invalidResponse }
        guard (200..<300).contains(http.statusCode) else { throw ShannonAPIError.rejected(status: http.statusCode) }
    }
}

private struct IncomingCallAnswer: Encodable {
    let scopeKey: String
    let callId: String
}

private struct IncomingCallReport: Encodable {
    let scopeKey: String
    let outcome: ShannonIncomingCallOutcome
}
