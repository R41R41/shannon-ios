import Foundation

extension ShannonAPIClient: ShannonVisionServing {
    public var visionDeviceId: String? { currentConnection()?.deviceID }

    /// `GET /v1/vision/status`: whether this device may watch now, and the limits it keeps.
    public func visionStatus() async throws -> ShannonVisionStatus {
        let connection = currentConnection()
        var request = URLRequest(url: baseURL.appending(path: "/v1/vision/status"))
        request.timeoutInterval = 10
        request.cachePolicy = .reloadIgnoringLocalCacheData
        authorize(&request, connection: connection)
        return try await response(ShannonVisionStatus.self, for: request)
    }

    /// `POST /v1/vision/frames`: one frame that passed the edge gate. The JPEG is the body and nothing else; its description
    /// (`vision.frame.v1`) rides in `x-shannon-vision-frame`. The bytes leave the app here and are kept nowhere: no file, no
    /// cache, no log.
    public func sendVisionFrame(_ frame: ShannonVisionFrame, jpeg: Data) async -> ShannonVisionFrameResult {
        let connection = currentConnection()
        var request = URLRequest(url: baseURL.appending(path: "/v1/vision/frames"))
        request.httpMethod = "POST"
        request.timeoutInterval = 15
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.setValue("image/jpeg", forHTTPHeaderField: "content-type")
        guard let header = try? ShannonVisionWire.headerValue(frame) else { return .rejected(status: 0) }
        request.setValue(header, forHTTPHeaderField: ShannonVisionWire.frameHeader)
        authorize(&request, connection: connection)
        request.httpBody = jpeg
        let sentAt = Date()
        guard let answer = try? await session.data(for: request),
              let http = answer.1 as? HTTPURLResponse else { return .workerDown }
        return Self.frameResult(status: http.statusCode, data: answer.0, retryAfter: http.value(forHTTPHeaderField: "retry-after"), sentAt: sentAt)
    }

    /// `POST /v1/vision/presence`: the device saw two or more people and stopped watching.
    public func reportVisionPresence(personCount: Int, at: Date) async throws {
        let connection = currentConnection()
        var request = URLRequest(url: baseURL.appending(path: "/v1/vision/presence"))
        request.httpMethod = "POST"
        request.timeoutInterval = 10
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        authorize(&request, connection: connection)
        request.httpBody = try JSONEncoder().encode(PresenceBody(personCount: personCount, at: ShannonVisionWire.timestamp(at)))
        let (_, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw ShannonAPIError.invalidResponse }
        guard (200..<300).contains(http.statusCode) else { throw ShannonAPIError.rejected(status: http.statusCode) }
    }

    /// What a status and body mean for watching.
    static func frameResult(status: Int, data: Data, retryAfter: String?, sentAt: Date) -> ShannonVisionFrameResult {
        switch status {
        case 200..<300:
            guard let reply = try? JSONDecoder().decode(ShannonVisionFrameReply.self, from: data) else { return .rejected(status: status) }
            return .reply(reply)
        case 429:
            return .notNow(until: notBefore(data: data, retryAfter: retryAfter, sentAt: sentAt))
        case 502, 503, 504:
            return .workerDown
        default:
            return .rejected(status: status)
        }
    }

    /// A 429 names the time in `nextFrameNotBefore` (or `Retry-After`); without either the device waits two seconds.
    static func notBefore(data: Data, retryAfter: String?, sentAt: Date) -> Date {
        if let body = try? JSONDecoder().decode(NotNowBody.self, from: data),
           let text = body.nextFrameNotBefore, let date = ShannonVisionWire.date(text) {
            return date
        }
        if let retryAfter, let seconds = Double(retryAfter.trimmingCharacters(in: .whitespaces)), seconds >= 0 {
            return sentAt.addingTimeInterval(seconds)
        }
        return sentAt.addingTimeInterval(ShannonVisionWire.notNowSeconds)
    }

    private struct PresenceBody: Encodable {
        let personCount: Int
        let at: String
    }

    private struct NotNowBody: Decodable {
        let nextFrameNotBefore: String?
    }
}
