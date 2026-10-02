import Foundation

/// The device's upcoming-schedule snapshot on the Shannon server. Only a paired
/// device (device token) may send or remove one; there is no read call.
public protocol ShannonCalendarServing: Sendable {
    /// Scope and device of the paired connection, or nil when this device is not paired.
    func calendarSharingIdentity() -> ShannonCalendarSharingIdentity?
    /// `body` is the already bounded and encoded snapshot (see `ShannonCalendarSnapshotBuilder`).
    func putUpcomingCalendar(_ body: Data) async throws -> ShannonCalendarUpcomingResponseDTO
    func deleteUpcomingCalendar() async throws
}

extension ShannonAPIClient: ShannonCalendarServing {
    static let upcomingCalendarPath = "/v1/calendar/upcoming"

    public func calendarSharingIdentity() -> ShannonCalendarSharingIdentity? {
        guard let connection = currentConnection() else { return nil }
        return ShannonCalendarSharingIdentity(scopeKey: connection.scopeKey, deviceID: connection.deviceID)
    }

    public func putUpcomingCalendar(_ body: Data) async throws -> ShannonCalendarUpcomingResponseDTO {
        var request = try calendarRequest(method: "PUT")
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = body
        return try await response(ShannonCalendarUpcomingResponseDTO.self, for: request)
    }

    public func deleteUpcomingCalendar() async throws {
        let request = try calendarRequest(method: "DELETE")
        let (_, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw ShannonAPIError.invalidResponse }
        guard (200..<300).contains(http.statusCode) else { throw ShannonAPIError.rejected(status: http.statusCode) }
    }

    /// Only the paired device's own token is used; the build-time token never sends a schedule.
    private func calendarRequest(method: String) throws -> URLRequest {
        guard let connection = currentConnection() else { throw ShannonCalendarSharingError.notPaired }
        var request = URLRequest(url: baseURL.appending(path: Self.upcomingCalendarPath))
        request.httpMethod = method
        request.timeoutInterval = 30
        authorize(&request, connection: connection)
        return request
    }
}
