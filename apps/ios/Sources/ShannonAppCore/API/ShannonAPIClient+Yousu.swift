import Foundation

/// One reading of `GET /v1/ops`, with the server's own clock at that moment when the
/// answer carried it. The age of a report is counted on the server's clock, so a phone
/// whose clock is off never calls an old report current.
public struct ShannonOpsReading: Equatable, Sendable {
    public let view: ShannonOpsViewDTO
    public let serverDate: Date?

    public init(view: ShannonOpsViewDTO, serverDate: Date? = nil) {
        self.view = view
        self.serverDate = serverDate
    }
}

/// What became of one press of a command button, as far as this device knows.
public enum ShannonOpsSendOutcome: Equatable, Sendable {
    /// The server recorded it. Its result arrives later in `GET /v1/ops`.
    case accepted(ShannonOpsCommandDTO)
    /// The server refused it and recorded nothing.
    case refused(status: Int, code: String?)
    /// The request could not be built: nothing left this device.
    case notSent
    /// The request failed on the way: it may or may not have arrived.
    case unknownDelivery
    /// The server answered success in a shape this app cannot read.
    case unreadable
}

/// The owner's reads for 「ようす」, and the one write: asking for an operation.
public protocol ShannonYousuServing: Sendable {
    func loadOps(scopeKey: String) async throws -> ShannonOpsReading
    /// One call per press. It is never retried here: a retry could run an operation twice.
    func sendOpsCommand(scopeKey: String, idempotencyKey: String, type: ShannonOpsCommandType, target: String) async -> ShannonOpsSendOutcome
    func loadShannonNow(scopeKey: String) async throws -> ShannonNowDTO
    func loadShannonOwnTime(scopeKey: String) async throws -> ShannonNowOwnTimeDTO
    func loadShannonStudyWaiting(scopeKey: String) async throws -> ShannonNowStudyDTO
    func loadShannonRecentActivity(scopeKey: String) async throws -> ShannonAutonomyActivityDTO
    /// `GET /v1/shannon/mood-history?hours=` (24 or 168). Only the owner's paired device may read it.
    func loadShannonMoodHistory(scopeKey: String, hours: Int) async throws -> ShannonMoodHistoryDTO
    /// Whose 運用 a reading is: the server, the connection's scope and this pairing. Nil while this app has no
    /// way to be let in (not paired and no developer token): then nothing about 運用 is remembered or marked.
    func opsReportScope(scopeKey: String) -> String?
}

extension ShannonYousuServing {
    /// A reader without the mood history answers as an older server does: the trend is left out.
    public func loadShannonMoodHistory(scopeKey: String, hours: Int) async throws -> ShannonMoodHistoryDTO {
        throw ShannonAPIError.rejected(status: 404)
    }
}

extension ShannonAPIClient: ShannonYousuServing {
    public func opsReportScope(scopeKey: String) -> String? {
        if let connection = currentConnection() {
            return "\(connection.baseURL.absoluteString)|\(connection.scopeKey)|\(connection.deviceID)"
        }
        guard let apiToken, !apiToken.isEmpty, !apiToken.contains("$(") else { return nil }
        return "\(baseURL.absoluteString)|\(scopeKey)|token"
    }

    public func loadOps(scopeKey: String) async throws -> ShannonOpsReading {
        let (data, response) = try await session.data(for: autonomyGet("/v1/ops", scopeKey: scopeKey))
        guard let http = response as? HTTPURLResponse else { throw ShannonAPIError.invalidResponse }
        guard (200..<300).contains(http.statusCode) else { throw ShannonAPIError.rejected(status: http.statusCode) }
        return ShannonOpsReading(
            view: try JSONDecoder().decode(ShannonOpsViewDTO.self, from: data),
            serverDate: http.value(forHTTPHeaderField: "Date").flatMap(Self.httpDate)
        )
    }

    public func sendOpsCommand(
        scopeKey: String, idempotencyKey: String, type: ShannonOpsCommandType, target: String
    ) async -> ShannonOpsSendOutcome {
        let connection = currentConnection()
        guard let request = try? autonomyPost(
            "/v1/ops/commands",
            body: ShannonOpsCommandRequestDTO(
                scopeKey: connection?.scopeKey ?? scopeKey, idempotencyKey: idempotencyKey, type: type, target: target
            ),
            connection: connection
        ) else { return .notSent }
        guard let (data, response) = try? await session.data(for: request),
              let http = response as? HTTPURLResponse else { return .unknownDelivery }
        guard (200..<300).contains(http.statusCode) else {
            return .refused(status: http.statusCode, code: (try? JSONDecoder().decode(ShannonOpsErrorDTO.self, from: data))?.error)
        }
        guard let decoded = try? JSONDecoder().decode(ShannonOpsCommandResponseDTO.self, from: data) else { return .unreadable }
        return .accepted(decoded.command)
    }

    public func loadShannonNow(scopeKey: String) async throws -> ShannonNowDTO {
        try await response(ShannonNowDTO.self, for: autonomyGet("/v1/shannon/now", scopeKey: scopeKey))
    }

    public func loadShannonOwnTime(scopeKey: String) async throws -> ShannonNowOwnTimeDTO {
        try await response(ShannonNowOwnTimeDTO.self, for: autonomyGet("/v1/autonomy", scopeKey: scopeKey))
    }

    public func loadShannonStudyWaiting(scopeKey: String) async throws -> ShannonNowStudyDTO {
        try await response(ShannonNowStudyDTO.self, for: autonomyGet("/v1/autonomy/study", scopeKey: scopeKey))
    }

    public func loadShannonRecentActivity(scopeKey: String) async throws -> ShannonAutonomyActivityDTO {
        try await loadAutonomyActivity(scopeKey: scopeKey, days: 2)
    }

    public func loadShannonMoodHistory(scopeKey: String, hours: Int) async throws -> ShannonMoodHistoryDTO {
        try await response(ShannonMoodHistoryDTO.self, for: autonomyGet(
            "/v1/shannon/mood-history", scopeKey: scopeKey, extra: [URLQueryItem(name: "hours", value: String(hours))]
        ))
    }

    /// `Sat, 03 Oct 2026 07:00:00 GMT` (RFC 9110 IMF-fixdate).
    static func httpDate(_ value: String) -> Date? {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(identifier: "GMT")
        formatter.dateFormat = "EEE, dd MMM yyyy HH:mm:ss zzz"
        return formatter.date(from: value)
    }
}
