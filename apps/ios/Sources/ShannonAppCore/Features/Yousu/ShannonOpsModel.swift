import Foundation
import Observation

/// The operations console on the owner's phone: the latest report of the legacy runtime,
/// and the commands the server says it would accept (`docs/ops-contract.md`).
///
/// The rules it holds, whatever the views do:
/// - a control exists only for a command the server listed in `allowed`;
/// - a report older than `staleAfterSeconds` (counted on the server's clock from the last
///   reading), a missing report, and a server that cannot be reached allow nothing;
/// - a command is checked against those rules again at the moment it is sent, so a
///   confirmation that stayed open cannot send what is no longer offered;
/// - what happened to a command is what the server recorded, never an assumption.
@MainActor
@Observable
public final class ShannonOpsModel {
    /// What the screen says about the last press of a command button.
    public enum Notice: Equatable, Sendable {
        /// Recorded by the server; the row of `commands` with this id says how it went.
        case accepted(ShannonOpsCommandDTO)
        /// Not sent, refused, or of unknown delivery: what is known, and one neutral sentence.
        case problem(title: String, message: String)
    }

    public private(set) var view: ShannonOpsViewDTO?
    public private(set) var didLoad = false
    public private(set) var isLoading = false
    /// False when the server has no such route; the screen is then not offered.
    public private(set) var isSupported = true
    /// Set while the API itself did not answer: a different message from a stale report.
    public private(set) var unreachableMessage: String?
    public private(set) var isSending = false
    public private(set) var notice: Notice?

    private let scopeKey: String
    private let client: (any ShannonYousuServing)?
    private let clock: @Sendable () -> Date
    private var fetchedAt: Date?
    private var ageAtFetch: TimeInterval = 0
    private var acceptedAt: Date?
    /// Set when a reading was asked for while another was in flight: one more follows it.
    private var needsAnotherRead = false

    public init(
        scopeKey: String = "local-owner",
        client: (any ShannonYousuServing)? = ShannonAPIClient(),
        clock: @escaping @Sendable () -> Date = { Date() }
    ) {
        self.scopeKey = scopeKey
        self.client = client
        self.clock = clock
        if client == nil { isSupported = false }
    }

    // MARK: What the screen may show

    public var snapshot: ShannonOpsSnapshotDTO? { view?.snapshot }

    /// The screen exists only once a report was received (contract: otherwise hide it).
    public var hasReport: Bool { isSupported && snapshot != nil }

    /// The report is not current: the server said so, or it aged past the limit since the last reading.
    public func isStale(at date: Date? = nil) -> Bool {
        guard let view, view.snapshot != nil, !view.stale, let fetchedAt else { return true }
        return ageAtFetch + max(0, (date ?? clock()).timeIntervalSince(fetchedAt)) > view.staleAfterSeconds
    }

    /// Status is shown as the present only for a current report from a reachable server.
    public func isCurrent(at date: Date? = nil) -> Bool {
        unreachableMessage == nil && !isStale(at: date)
    }

    /// What may be commanded now. Nothing while the report is old or the server is unreachable.
    public func allowed(at date: Date? = nil) -> ShannonOpsAllowedDTO {
        guard let view, view.commandsSupported, isCurrent(at: date), !isSending else { return .nothing }
        return view.allowed
    }

    public var commandsSupported: Bool { view?.commandsSupported == true }
    public var commands: [ShannonOpsCommandDTO] { view?.commands ?? [] }

    /// Commands that await their result: the open ones of the record, and the one just accepted
    /// until a reading of the record contains it (and no longer than the time it may be claimed in).
    public var openCommands: [ShannonOpsCommandDTO] {
        var open = commands.filter(\.status.isOpen)
        if case .accepted(let accepted) = notice, accepted.status.isOpen, !commands.contains(where: { $0.id == accepted.id }),
           let acceptedAt, clock().timeIntervalSince(acceptedAt) < Self.claimSeconds {
            open.append(accepted)
        }
        return open
    }

    /// Read every 30 seconds while the screen is visible, every 3 while a command awaits its result.
    /// While the server does not answer, nothing is waited for faster than the normal interval.
    public var pollInterval: Duration {
        unreachableMessage == nil && !openCommands.isEmpty ? .seconds(3) : .seconds(30)
    }

    /// Something on the screen deserves a look: a report that stopped arriving, or a service that is not well.
    public var needsAttention: Bool {
        guard hasReport, let snapshot else { return false }
        if !isCurrent() { return true }
        return snapshot.services.contains { $0.status == .degraded || $0.status == .unknown }
    }

    /// A command for this target still awaits its result; its buttons wait with it.
    /// A schedule and a service of the same name are different targets, and starting the
    /// Minebot body (whose target is a server) counts for the body's row.
    public func isWaiting(target: String, schedule: Bool = false) -> Bool {
        openCommands.contains { command in
            if target == ShannonOpsText.minebotBody {
                return command.type == .minebotStart || command.target == ShannonOpsText.minebotBody
            }
            return command.type != .minebotStart && command.target == target && (command.type == .scheduleRun) == schedule
        }
    }

    public func actions(for service: ShannonOpsServiceDTO, at date: Date? = nil) -> [ShannonOpsAction] {
        guard !isWaiting(target: service.id) else { return [] }
        return ShannonOpsText.serviceActions(service, allowed: allowed(at: date))
    }

    public func action(for schedule: ShannonOpsScheduleDTO, at date: Date? = nil) -> ShannonOpsAction? {
        guard !isWaiting(target: schedule.name, schedule: true) else { return nil }
        return ShannonOpsText.scheduleAction(schedule, allowed: allowed(at: date))
    }

    /// Servers the Minebot body may be started into, when the server accepts that start now.
    /// Nil: no 起動 is offered. Empty: it would be accepted, and no server is running to join.
    public func minebotStartServers(for service: ShannonOpsServiceDTO, at date: Date? = nil) -> [ShannonOpsServiceDTO]? {
        guard service.id == ShannonOpsText.minebotBody, service.status != .running,
              allowed(at: date).minebotStart, !isWaiting(target: service.id), let snapshot else { return nil }
        return ShannonOpsText.minebotServers(snapshot.services)
    }

    /// Whether this exact command is offered at this moment.
    public func canSend(_ action: ShannonOpsAction, at date: Date? = nil) -> Bool {
        guard let snapshot else { return false }
        switch action.type {
        case .scheduleRun:
            return snapshot.schedules.contains { $0.name == action.target && self.action(for: $0, at: date)?.type == .scheduleRun }
        case .minebotStart:
            guard let body = snapshot.services.first(where: { $0.id == ShannonOpsText.minebotBody }) else { return false }
            return minebotStartServers(for: body, at: date)?.contains { $0.id == action.target } == true
        case .serviceStart, .serviceStop, .minecraftStart, .minecraftStop:
            return snapshot.services.contains { $0.id == action.target && actions(for: $0, at: date).contains { $0.type == action.type } }
        }
    }

    /// The command of the last press as the server records it now.
    public var noticedCommand: ShannonOpsCommandDTO? {
        guard case .accepted(let accepted) = notice else { return nil }
        return commands.first { $0.id == accepted.id } ?? accepted
    }

    // MARK: Reading and sending

    public func refresh() async {
        guard let client else { return }
        guard !isLoading else {
            // The reading in flight may predate what the caller wants to see.
            needsAnotherRead = true
            return
        }
        isLoading = true
        defer { isLoading = false }
        repeat {
            needsAnotherRead = false
            await read(client)
        } while needsAnotherRead && !Task.isCancelled
    }

    private func read(_ client: any ShannonYousuServing) async {
        do {
            let reading = try await client.loadOps(scopeKey: scopeKey)
            let readAt = clock()
            view = reading.view
            fetchedAt = readAt
            ageAtFetch = Self.age(of: reading, readAt: readAt)
            isSupported = true
            unreachableMessage = nil
            didLoad = true
        } catch where Self.isCancellation(error) {
            // The screen went away mid-request. Nothing was learned, and nothing is claimed.
            return
        } catch let error as ShannonAPIError where error == .rejected(status: 404) {
            // An older server has no operations console. The screen is not offered.
            isSupported = false
            view = nil
            didLoad = true
        } catch let error as ShannonAPIError where error == .rejected(status: 401) {
            unreachableMessage = "接続が無効になりました。もう一度接続してください。"
            didLoad = true
        } catch {
            unreachableMessage = "シャノンのサーバーに届きませんでした。サーバーが止まっているか、通信ができていません。"
            didLoad = true
        }
    }

    nonisolated static func isCancellation(_ error: Error) -> Bool {
        error is CancellationError || (error as? URLError)?.code == .cancelled || Task.isCancelled
    }

    /// A command that was not claimed in this time is expired by the server (`docs/ops-contract.md`).
    private static let claimSeconds: TimeInterval = 300

    /// Asks for one operation. The caller has shown the confirmation; this checks once more
    /// that the command is still offered, sends it once, and reads the status again.
    public func send(_ action: ShannonOpsAction) async {
        guard let client, !isSending else { return }
        guard canSend(action) else {
            notice = .problem(title: ShannonOpsText.notSentTitle, message: isCurrent() ? ShannonOpsText.noLongerAllowed : ShannonOpsText.staleBeforeSending)
            return
        }
        isSending = true
        let outcome = await client.sendOpsCommand(
            scopeKey: scopeKey, idempotencyKey: UUID().uuidString.lowercased(), type: action.type, target: action.target
        )
        isSending = false
        switch outcome {
        case .accepted(let command):
            acceptedAt = clock()
            notice = .accepted(command)
        case .refused(let status, let code):
            notice = .problem(title: ShannonOpsText.notSentTitle, message: ShannonOpsText.refusal(status: status, code: code))
        case .notSent:
            notice = .problem(title: ShannonOpsText.notSentTitle, message: ShannonOpsText.refusal(status: 400, code: "INVALID_REQUEST"))
        case .unknownDelivery:
            notice = .problem(title: ShannonOpsText.unknownDeliveryTitle, message: ShannonOpsText.unknownDelivery)
        case .unreadable:
            notice = .problem(title: ShannonOpsText.unreadableTitle, message: ShannonOpsText.unreadableAnswer)
        }
        await refresh()
    }

    public func dismissNotice() {
        notice = nil
    }

    /// How old the report already was when it was read: on the server's own clock when the answer carried it,
    /// otherwise on this device's. A report whose time cannot be read is not called current.
    private static func age(of reading: ShannonOpsReading, readAt: Date) -> TimeInterval {
        guard let receivedAt = reading.view.receivedAt.flatMap(ShannonYousuTime.date) else { return .infinity }
        return max(0, (reading.serverDate ?? readAt).timeIntervalSince(receivedAt))
    }
}

/// Timestamps of the server, as the 「ようす」 screens read and word them.
public enum ShannonYousuTime {
    public static func date(_ iso: String) -> Date? {
        (try? Date.ISO8601FormatStyle(includingFractionalSeconds: true).parse(iso)) ?? (try? Date.ISO8601FormatStyle().parse(iso))
    }

    /// 「16:24」 today, 「10月2日 16:24」 on another day, in the device's time zone.
    public static func clock(_ iso: String, now: Date = Date(), calendar: Calendar = .current) -> String {
        guard let date = date(iso) else { return "不明" }
        let locale = Locale(identifier: "ja_JP")
        var style = Date.FormatStyle(locale: locale, calendar: calendar, timeZone: calendar.timeZone).hour().minute()
        if !calendar.isDate(date, inSameDayAs: now) { style = style.month().day() }
        return date.formatted(style)
    }

    /// 「1分前」「2時間前」「3日前」; 「たったいま」 under a minute.
    public static func ago(_ iso: String, now: Date = Date()) -> String? {
        guard let date = date(iso) else { return nil }
        let minutes = Int(max(0, now.timeIntervalSince(date)) / 60)
        if minutes < 1 { return "たったいま" }
        if minutes < 60 { return "\(minutes)分前" }
        if minutes < 60 * 24 { return "\(minutes / 60)時間前" }
        return "\(minutes / (60 * 24))日前"
    }
}
