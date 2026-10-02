import Foundation
import Observation

/// Sharing of the owner's upcoming schedule with Shannon. Off by default.
/// While off, the calendar is never read and nothing is sent; switching off
/// removes this device's snapshot from the server. Sharing belongs to one
/// paired device: unpairing or pairing again turns it off.
@MainActor
@Observable
public final class ShannonCalendarSharingModel {
    public private(set) var isEnabled = false
    public private(set) var status: ShannonCalendarSharingStatus = .off
    /// True while the permission prompt or the first request after a switch is in flight.
    public private(set) var isChanging = false
    public private(set) var isSyncing = false

    /// Set by the app while its scene is active; the periodic sync only runs then.
    @ObservationIgnored public var isForeground = true

    @ObservationIgnored private let client: (any ShannonCalendarServing)?
    @ObservationIgnored private let source: any ShannonCalendarEventSource
    @ObservationIgnored private let defaults: UserDefaults
    @ObservationIgnored private let now: @Sendable () -> Date
    @ObservationIgnored private let timeZone: @Sendable () -> TimeZone
    @ObservationIgnored private let sleep: @Sendable (TimeInterval) async -> Void
    @ObservationIgnored private var gate: ShannonCalendarSyncGate
    @ObservationIgnored private var changeGeneration = 0
    @ObservationIgnored private var needsAnotherSync = false
    @ObservationIgnored private var lastOutcome = Outcome.none
    @ObservationIgnored private var isPreview = false

    private enum Outcome { case none, sent, unsupported, failed }

    enum Key {
        static let deviceID = "shannon.calendarSharing.deviceID"
        static let lastSentAt = "shannon.calendarSharing.lastSentAt"
        static let lastCount = "shannon.calendarSharing.lastCount"
        static let pendingRemovalDeviceID = "shannon.calendarSharing.pendingRemovalDeviceID"
    }

    public init(
        client: (any ShannonCalendarServing)?,
        source: any ShannonCalendarEventSource = ShannonEventKitCalendarSource(),
        defaults: UserDefaults = .standard,
        periodicInterval: TimeInterval = ShannonCalendarSyncGate.phoneInterval,
        now: @escaping @Sendable () -> Date = { Date() },
        timeZone: @escaping @Sendable () -> TimeZone = { .current },
        sleep: @escaping @Sendable (TimeInterval) async -> Void = { try? await Task.sleep(for: .seconds($0)) }
    ) {
        self.client = client
        self.source = source
        self.defaults = defaults
        self.now = now
        self.timeZone = timeZone
        self.sleep = sleep
        self.gate = ShannonCalendarSyncGate(periodicInterval: periodicInterval)
        if defaults.object(forKey: Key.lastSentAt) != nil { lastOutcome = .sent }
        refresh()
    }

    /// A fixed state for design previews; it never reads a calendar or contacts a server.
    public static func designPreview(_ status: ShannonCalendarSharingStatus) -> ShannonCalendarSharingModel {
        let model = ShannonCalendarSharingModel(client: nil, source: ShannonCalendarNoSource())
        model.isPreview = true
        model.status = status
        model.isEnabled = status.showsToggleOn
        return model
    }

    // MARK: Owner actions

    /// On: asks for calendar access if needed, then sends. Off: stops reading and removes the snapshot.
    public func setEnabled(_ enabled: Bool) async {
        guard !isPreview, !isChanging else { return }
        isChanging = true
        defer { isChanging = false }
        if enabled {
            guard let identity = client?.calendarSharingIdentity() else {
                status = .notPaired
                return
            }
            if source.authorization() == .notDetermined { _ = await source.requestAccess() }
            defaults.set(identity.deviceID, forKey: Key.deviceID)
            defaults.removeObject(forKey: Key.pendingRemovalDeviceID)
            refresh()
            await sync(.enabled)
        } else {
            let deviceID = defaults.string(forKey: Key.deviceID) ?? client?.calendarSharingIdentity()?.deviceID
            forgetSharing()
            if let deviceID { defaults.set(deviceID, forKey: Key.pendingRemovalDeviceID) }
            refresh()
            await removeSnapshotIfPending()
        }
    }

    /// The permission row's button: asks once if the owner was never asked; otherwise the caller opens Settings.
    /// Returns true when the system Settings should be opened.
    public func resolvePermission() async -> Bool {
        guard !isPreview else { return false }
        guard source.authorization() == .notDetermined else { return true }
        _ = await source.requestAccess()
        await sync(.enabled)
        return false
    }

    /// Called before this device unpairs, while its token still works.
    public func removeBeforeUnpairing() async {
        refresh()
        if isEnabled {
            await setEnabled(false)
        } else {
            await removeSnapshotIfPending()
        }
    }

    // MARK: Syncing

    /// Launch sync, calendar-change observation and the periodic sync. Runs until cancelled.
    public func run() async {
        guard !isPreview else { return }
        await sync(.launch)
        let changes = source.changes()
        let observer = Task { [weak self] in
            for await _ in changes {
                Task { await self?.calendarDidChange() }
            }
        }
        defer { observer.cancel() }
        while !Task.isCancelled {
            await sleep(gate.periodicInterval)
            if Task.isCancelled { break }
            if isForeground { await sync(.periodic) }
        }
    }

    /// Debounced: a burst of change notifications produces one upload after it settles.
    public func calendarDidChange() async {
        guard isEnabled else { return }
        changeGeneration += 1
        let generation = changeGeneration
        await sleep(ShannonCalendarSyncGate.changeDebounce)
        guard generation == changeGeneration else { return }
        await sync(.storeChanged)
    }

    public func sync(_ trigger: ShannonCalendarSyncTrigger) async {
        guard !isPreview else { return }
        refresh()
        await removeSnapshotIfPending()
        guard isEnabled, let client, let identity = client.calendarSharingIdentity() else { return }
        guard gate.allows(trigger, now: now()) else { return }
        guard source.authorization() == .granted else { return }
        if isSyncing {
            needsAnotherSync = true
            return
        }
        isSyncing = true
        refresh()
        repeat {
            needsAnotherSync = false
            await upload(identity: identity, client: client)
        } while needsAnotherSync && currentlyEnabled(for: identity)
        isSyncing = false
        refresh()
        // Switched off while the upload was in flight: make sure nothing stays behind.
        await removeSnapshotIfPending()
    }

    private func upload(identity: ShannonCalendarSharingIdentity, client: any ShannonCalendarServing) async {
        let moment = now()
        gate.record(moment)
        let window = ShannonCalendarSnapshotBuilder.window(now: moment)
        let events = await source.events(from: window.start, to: window.end)
        guard currentlyEnabled(for: identity) else { return }
        let request = ShannonCalendarSnapshotBuilder.request(
            scopeKey: identity.scopeKey, events: events, now: moment, timeZone: timeZone()
        )
        do {
            let response = try await client.putUpcomingCalendar(ShannonCalendarSnapshotBuilder.encode(request))
            guard currentlyEnabled(for: identity) else { return }
            defaults.set(moment.timeIntervalSince1970, forKey: Key.lastSentAt)
            defaults.set(response.stored, forKey: Key.lastCount)
            lastOutcome = .sent
        } catch let error as ShannonAPIError where error == .rejected(status: 404) {
            // An older server has no such route yet. The switch stays on and the next sync tries again.
            lastOutcome = .unsupported
        } catch {
            lastOutcome = .failed
        }
    }

    /// Off sends DELETE; a server that only accepts PUT gets an empty snapshot instead.
    private func removeSnapshotIfPending() async {
        guard let pending = defaults.string(forKey: Key.pendingRemovalDeviceID) else { return }
        guard let client, let identity = client.calendarSharingIdentity(), identity.deviceID == pending else {
            // The device that sent it is no longer paired here; its token cannot remove anything.
            if client?.calendarSharingIdentity() != nil { defaults.removeObject(forKey: Key.pendingRemovalDeviceID) }
            refresh()
            return
        }
        do {
            do {
                try await client.deleteUpcomingCalendar()
            } catch let error as ShannonAPIError
                where error == .rejected(status: 404) || error == .rejected(status: 405) {
                let empty = ShannonCalendarSnapshotBuilder.request(
                    scopeKey: identity.scopeKey, events: [], now: now(), timeZone: timeZone()
                )
                do {
                    _ = try await client.putUpcomingCalendar(ShannonCalendarSnapshotBuilder.encode(empty))
                } catch let error as ShannonAPIError where error == .rejected(status: 404) {
                    // No calendar route at all: this server never stored a snapshot.
                }
            }
            if defaults.string(forKey: Key.pendingRemovalDeviceID) == pending {
                defaults.removeObject(forKey: Key.pendingRemovalDeviceID)
            }
        } catch {
            // Kept pending; the next sync tries again.
        }
        refresh()
    }

    // MARK: State

    private func currentlyEnabled(for identity: ShannonCalendarSharingIdentity) -> Bool {
        defaults.string(forKey: Key.deviceID) == identity.deviceID
            && client?.calendarSharingIdentity() == identity
    }

    private func forgetSharing() {
        defaults.removeObject(forKey: Key.deviceID)
        defaults.removeObject(forKey: Key.lastSentAt)
        defaults.removeObject(forKey: Key.lastCount)
        lastOutcome = .none
    }

    /// Recomputes what the settings row shows from the stored switch, the pairing and the permission.
    public func refresh() {
        guard !isPreview else { return }
        let identity = client?.calendarSharingIdentity()
        if let stored = defaults.string(forKey: Key.deviceID), let identity, stored != identity.deviceID {
            // Paired again as another device: sharing has to be switched on again by the owner.
            forgetSharing()
        }
        let stored = defaults.string(forKey: Key.deviceID)
        isEnabled = stored != nil && stored == identity?.deviceID
        guard isEnabled else {
            if stored != nil {
                status = .notPaired
            } else {
                status = defaults.string(forKey: Key.pendingRemovalDeviceID) == nil ? .off : .removalPending
            }
            return
        }
        guard source.authorization() == .granted else {
            status = .needsPermission
            return
        }
        let sentAt = (defaults.object(forKey: Key.lastSentAt) as? Double).map(Date.init(timeIntervalSince1970:))
        let count = defaults.integer(forKey: Key.lastCount)
        switch lastOutcome {
        case .unsupported: status = .unsupported
        case .failed: status = .failed(lastSentAt: sentAt, count: count)
        case .sent, .none:
            if let sentAt {
                status = .sent(at: sentAt, count: count)
            } else {
                status = isSyncing ? .sending : .waiting
            }
        }
    }
}

/// A source that has nothing and asks for nothing; used by design previews.
struct ShannonCalendarNoSource: ShannonCalendarEventSource {
    func authorization() -> ShannonCalendarAuthorization { .denied }
    func requestAccess() async -> Bool { false }
    func events(from start: Date, to end: Date) async -> [ShannonCalendarSourceEvent] { [] }
    func changes() -> AsyncStream<Void> { AsyncStream { $0.finish() } }
}
