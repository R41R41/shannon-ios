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
    /// `POST /v1/ops/settings` `{freshWorld}` (「新しいワールドで始める」): the switches as the server stored them.
    /// One call per press, never retried; a throw means nothing is known to have been saved.
    func setOpsSettings(scopeKey: String, freshWorld: Bool) async throws -> ShannonOpsSettingsDTO
    func loadShannonNow(scopeKey: String) async throws -> ShannonNowDTO
    func loadShannonOwnTime(scopeKey: String) async throws -> ShannonNowOwnTimeDTO
    func loadShannonStudyWaiting(scopeKey: String) async throws -> ShannonNowStudyDTO
    func loadShannonRecentActivity(scopeKey: String) async throws -> ShannonAutonomyActivityDTO
    /// `GET /v1/shannon/mood-history?hours=` (24 or 168). Only the owner's paired device may read it.
    func loadShannonMoodHistory(scopeKey: String, hours: Int) async throws -> ShannonMoodHistoryDTO
    /// 学び (Syzygy ADR-0008 §13): `GET /v1/autonomy/values`, owner only.
    func loadShannonValues(scopeKey: String) async throws -> ShannonValuesDTO
    /// `POST /v1/autonomy/values/rollback` with the version to return to. One call per confirmed press, never retried.
    func rollbackShannonValues(scopeKey: String, versionID: String?) async throws -> ShannonValuesDTO
    /// `POST /v1/autonomy/values/resume`. One call per confirmed press, never retried.
    func resumeShannonValues(scopeKey: String) async throws -> ShannonValuesDTO
    /// `GET /v1/autonomy/skills`, owner only.
    func loadShannonSkills(scopeKey: String) async throws -> ShannonSkillsDTO
    /// `GET /v1/autonomy/skills/{id}`.
    func loadShannonSkill(scopeKey: String, id: String) async throws -> ShannonSkillDetailDTO
    /// `POST /v1/autonomy/skills/{id}/pin` or `/unpin`: the skill as it now is.
    func setShannonSkillPinned(scopeKey: String, id: String, pinned: Bool) async throws -> ShannonSkillDTO
    /// 目標 (Syzygy ADR-0009 E7, `docs/executive-ui-contract.md`): `GET /v1/autonomy/goals`, owner only.
    func loadShannonGoals(scopeKey: String) async throws -> ShannonGoalsDTO
    /// `GET /v1/autonomy/choices?days=`, owner only.
    func loadShannonChoices(scopeKey: String, days: Int) async throws -> ShannonChoicesDTO
    /// `POST /v1/autonomy/pursuits/{id}/confirm`: the owner confirms a goal is done. One call per confirmed press, never retried.
    func confirmShannonGoal(scopeKey: String, id: String) async throws -> ShannonGoalsDTO
    /// `POST /v1/autonomy/pursuits/{id}/status` with `resting` or `dropped`. One call per confirmed press, never retried.
    func setShannonGoalStatus(scopeKey: String, id: String, status: String) async throws
    /// 点検: `GET /v1/autonomy/capabilities`, owner only.
    func loadShannonCapabilities(scopeKey: String) async throws -> ShannonCapabilitiesDTO
    /// `GET /v1/autonomy/inspection?day=` (nil: today on the server), owner only.
    func loadShannonInspection(scopeKey: String, day: String?) async throws -> ShannonInspectionDTO
    /// Whose 運用 a reading is: the server, the connection's scope and this pairing. Nil while this app has no
    /// way to be let in (not paired and no developer token): then nothing about 運用 is remembered or marked.
    func opsReportScope(scopeKey: String) -> String?
}

extension ShannonYousuServing {
    /// A reader without the 運用 switches answers as an older server does: no switch is offered.
    public func setOpsSettings(scopeKey: String, freshWorld: Bool) async throws -> ShannonOpsSettingsDTO { throw ShannonAPIError.rejected(status: 404) }

    /// A reader without the mood history answers as an older server does: the trend is left out.
    public func loadShannonMoodHistory(scopeKey: String, hours: Int) async throws -> ShannonMoodHistoryDTO {
        throw ShannonAPIError.rejected(status: 404)
    }

    /// A reader without 学び answers as an older server does: the parts are left out.
    public func loadShannonValues(scopeKey: String) async throws -> ShannonValuesDTO { throw ShannonAPIError.rejected(status: 404) }
    public func rollbackShannonValues(scopeKey: String, versionID: String?) async throws -> ShannonValuesDTO { throw ShannonAPIError.rejected(status: 404) }
    public func resumeShannonValues(scopeKey: String) async throws -> ShannonValuesDTO { throw ShannonAPIError.rejected(status: 404) }
    public func loadShannonSkills(scopeKey: String) async throws -> ShannonSkillsDTO { throw ShannonAPIError.rejected(status: 404) }
    public func loadShannonSkill(scopeKey: String, id: String) async throws -> ShannonSkillDetailDTO { throw ShannonAPIError.rejected(status: 404) }
    public func setShannonSkillPinned(scopeKey: String, id: String, pinned: Bool) async throws -> ShannonSkillDTO { throw ShannonAPIError.rejected(status: 404) }

    /// A reader without 目標 and 点検 answers as a server before them does: the tabs say 「準備中」.
    public func loadShannonGoals(scopeKey: String) async throws -> ShannonGoalsDTO { throw ShannonAPIError.rejected(status: 404) }
    public func loadShannonChoices(scopeKey: String, days: Int) async throws -> ShannonChoicesDTO { throw ShannonAPIError.rejected(status: 404) }
    public func confirmShannonGoal(scopeKey: String, id: String) async throws -> ShannonGoalsDTO { throw ShannonAPIError.rejected(status: 404) }
    public func setShannonGoalStatus(scopeKey: String, id: String, status: String) async throws { throw ShannonAPIError.rejected(status: 404) }
    public func loadShannonCapabilities(scopeKey: String) async throws -> ShannonCapabilitiesDTO { throw ShannonAPIError.rejected(status: 404) }
    public func loadShannonInspection(scopeKey: String, day: String?) async throws -> ShannonInspectionDTO { throw ShannonAPIError.rejected(status: 404) }
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

    public func setOpsSettings(scopeKey: String, freshWorld: Bool) async throws -> ShannonOpsSettingsDTO {
        let connection = currentConnection()
        return try await response(ShannonOpsSettingsResponseDTO.self, for: autonomyPost(
            "/v1/ops/settings",
            body: ShannonOpsSettingsRequestDTO(scopeKey: connection?.scopeKey ?? scopeKey, freshWorld: freshWorld),
            connection: connection
        )).settings
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
