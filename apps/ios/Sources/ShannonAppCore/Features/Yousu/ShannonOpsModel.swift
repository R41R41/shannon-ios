import CryptoKit
import Foundation
import Observation

/// Counts unpairings and pairings of this app. A reading of 運用 belongs to the pairing it was made under:
/// when this moves on, what was read before is no longer shown or marked, at once.
@MainActor
@Observable
final class ShannonOpsPairingEpoch {
    static let shared = ShannonOpsPairingEpoch()
    private(set) var value = 0
    func advance() { value &+= 1 }
}

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
    /// The server refused this app's connection (401). A matter of the connection, not of 運用: no mark,
    /// and the 運用 row says it in the same words as the page (decision of the review, 2026-10-05).
    public private(set) var connectionIsInvalid = false
    public private(set) var isSending = false
    public private(set) var notice: Notice?

    private let scopeKey: String
    private let client: (any ShannonYousuServing)?
    private let clock: @Sendable () -> Date
    /// Where "a report has arrived for this pairing before" is kept across launches; nil keeps nothing.
    private let defaults: UserDefaults?
    /// Whose 運用 the readings are (`ShannonYousuServing.opsReportScope`): asked once per pairing, not at every poll.
    private var reportScope: String?
    private var reportScopeIsKnown = false
    private var pairingEpoch = ShannonOpsPairingEpoch.shared.value
    private var isCurrentPairing: Bool { pairingEpoch == ShannonOpsPairingEpoch.shared.value }
    private var fetchedAt: Date?
    private var ageAtFetch: TimeInterval = 0
    private var acceptedAt: Date?
    /// Set when a reading was asked for while another was in flight: one more follows it.
    private var needsAnotherRead = false

    public init(
        scopeKey: String = "local-owner",
        client: (any ShannonYousuServing)? = ShannonAPIClient(),
        clock: @escaping @Sendable () -> Date = { Date() },
        defaults: UserDefaults? = nil
    ) {
        self.scopeKey = scopeKey
        self.client = client
        self.clock = clock
        self.defaults = defaults
        if client == nil { isSupported = false }
    }

    /// A report has arrived for this pairing at some time, in this launch or an earlier one.
    /// False for an app that is not paired: there is nobody's 運用 to remember.
    public var reportArrivedBefore: Bool {
        guard let defaults, let reportScope else { return false }
        return defaults.bool(forKey: Self.reportArrivedKey(reportScope))
    }

    /// Only a yes or no is kept: no part of a report is written to the device.
    /// The scope is hashed: the server, scope and pairing are not written to the device as they are.
    nonisolated static let reportArrivedPrefix = "shannon.ops.report-arrived."
    nonisolated static func reportArrivedKey(_ scope: String) -> String {
        reportArrivedPrefix + SHA256.hash(data: Data(scope.utf8)).prefix(16).map { String(format: "%02x", $0) }.joined()
    }

    /// Unpairing or pairing again starts from "no report has arrived" (`ShannonConnectionModel`), and what
    /// was read under the old pairing stops showing and marking at once.
    public static func forgetArrivedReports(in defaults: UserDefaults = .standard) {
        for key in defaults.dictionaryRepresentation().keys where key.hasPrefix(reportArrivedPrefix) {
            defaults.removeObject(forKey: key)
        }
        ShannonOpsPairingEpoch.shared.advance()
    }

    // MARK: What the screen may show

    public var snapshot: ShannonOpsSnapshotDTO? { isCurrentPairing ? view?.snapshot : nil }

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
        guard isCurrentPairing, let view, view.commandsSupported, isCurrent(at: date), !isSending else { return .nothing }
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

    /// Something in 運用 deserves a look (docs/product/information-architecture.md, 4 and 8): the mark on the
    /// top-left button, on the 設定 tile and on the 運用 row. Never before the first report ever arrived.
    public var needsAttention: Bool { attentionReason() != nil }

    /// Why 運用 deserves a look, in one line; nil while all is well or before the first report ever arrived.
    /// The server cannot be reached, the report stopped arriving, a service is not well, or an
    /// operation of the last hour failed or expired. "Ever" outlives the launch: a server that is
    /// down when the app starts is marked if a report had arrived before.
    public func attentionReason(at date: Date? = nil) -> String? {
        guard isCurrentPairing, isSupported, !connectionIsInvalid, hasReport || reportArrivedBefore else { return nil }
        if unreachableMessage != nil { return ShannonGeneratedStrings.opsAttentionUnreachable }
        // Not read yet in this launch: nothing is known, and nothing is claimed.
        guard didLoad else { return nil }
        guard let snapshot else { return ShannonGeneratedStrings.opsAttentionNoReport }
        if isStale(at: date) { return ShannonGeneratedStrings.opsAttentionNoReport }
        if let service = snapshot.services.first(where: { $0.status == .degraded || $0.status == .unknown }) {
            return ShannonGeneratedStrings.opsAttentionUnwell(name: ShannonOpsText.serviceName(service))
        }
        if let command = recentProblemCommand(at: date) {
            let target = ShannonOpsText.commandTargetName(type: command.type, target: command.target)
            return command.status == .failed
                ? ShannonGeneratedStrings.opsAttentionFailed(target: target)
                : ShannonGeneratedStrings.opsAttentionExpired(target: target)
        }
        return nil
    }

    /// Only operations of the last hour count for the mark; older ones stay in the record (2026-10-05).
    static let problemWindowSeconds: TimeInterval = 60 * 60

    /// The newest operation of the last hour that failed or expired.
    func recentProblemCommand(at date: Date? = nil) -> ShannonOpsCommandDTO? {
        let now = date ?? clock()
        return commands
            .filter { $0.status == .failed || $0.status == .expired }
            .compactMap { command in Self.problemTime(command).map { (command, $0) } }
            .filter { now.timeIntervalSince($0.1) <= Self.problemWindowSeconds }
            .max { $0.1 < $1.1 }?.0
    }

    /// When it ended: its finish, the moment it expired, or else when it was asked for.
    private static func problemTime(_ command: ShannonOpsCommandDTO) -> Date? {
        if let finished = command.finishedAt.flatMap(ShannonYousuTime.date) { return finished }
        if command.status == .expired, let expired = ShannonYousuTime.date(command.expiresAt) { return expired }
        return ShannonYousuTime.date(command.createdAt)
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
        if !isCurrentPairing { forgetReading() }
        if !reportScopeIsKnown {
            reportScope = client.opsReportScope(scopeKey: scopeKey)
            reportScopeIsKnown = true
        }
        let epoch = pairingEpoch
        let result: Result<ShannonOpsReading, Error>
        do { result = .success(try await client.loadOps(scopeKey: scopeKey)) } catch { result = .failure(error) }
        // Unpaired or paired anew meanwhile: the answer belongs to a pairing that is gone, and is not kept.
        guard epoch == ShannonOpsPairingEpoch.shared.value else { return }
        switch result {
        case .success(let reading):
            let readAt = clock()
            view = reading.view
            connectionIsInvalid = false
            if reading.view.snapshot != nil, let reportScope, !reportArrivedBefore {
                defaults?.set(true, forKey: Self.reportArrivedKey(reportScope))
            }
            fetchedAt = readAt
            ageAtFetch = Self.age(of: reading, readAt: readAt)
            isSupported = true
            unreachableMessage = nil
            didLoad = true
        case .failure(let error) where Self.isCancellation(error):
            // The screen went away mid-request. Nothing was learned, and nothing is claimed.
            return
        case .failure(let error as ShannonAPIError) where error == .rejected(status: 404):
            // An older server has no operations console. The screen is not offered.
            isSupported = false
            view = nil
            connectionIsInvalid = false
            didLoad = true
        case .failure(let error as ShannonAPIError) where error == .rejected(status: 401):
            unreachableMessage = ShannonGeneratedStrings.opsConnectionInvalid
            connectionIsInvalid = true
            didLoad = true
        case .failure:
            unreachableMessage = "シャノンのサーバーに届きませんでした。サーバーが止まっているか、通信ができていません。"
            connectionIsInvalid = false
            didLoad = true
        }
    }

    /// What was read under a pairing that is gone.
    private func forgetReading() {
        pairingEpoch = ShannonOpsPairingEpoch.shared.value
        view = nil
        fetchedAt = nil
        didLoad = false
        unreachableMessage = nil
        connectionIsInvalid = false
        notice = nil
        reportScope = nil
        reportScopeIsKnown = false
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
