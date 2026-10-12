import Foundation
import Observation

/// Does what Shannon asked of the owner's devices (`docs/device-actions-contract.md`): while the app runs, it polls the
/// device-action outbox (held open while the app is in front or a call is on), does each action with the system's own
/// frameworks, and reports it once. An action is done at most once on this device: its id is written down before it
/// runs, and a report that did not arrive is sent again from what was written, never by running the action again.
@MainActor
@Observable
public final class ShannonDeviceActionModel {
    /// What is playing because she chose it; the conversation's now-playing card shows it.
    public private(set) var nowPlaying: ShannonNowPlaying?

    /// Set by the app while its scene is active.
    @ObservationIgnored public var isForeground = true
    /// Whether a voice call is on (the poll is held open then, also with the app in the background).
    @ObservationIgnored public var inCall: @MainActor () -> Bool = ShannonDeviceActionModel.defaultInCall

    @ObservationIgnored private let client: (any ShannonDeviceActionServing)?
    @ObservationIgnored private let ledger: ShannonDeviceActionLedger
    @ObservationIgnored private let sleep: @Sendable (TimeInterval) async -> Void
    @ObservationIgnored private let eventKit = ShannonDeviceEventKitWriter()
    @ObservationIgnored private let music = ShannonDeviceMusic()
    @ObservationIgnored private var isRunning = false
    @ObservationIgnored private var isPreview = false
    /// The card's stop or skip was pressed: the player's next stop is that, not a song that ended.
    @ObservationIgnored private var stoppedByOwner = false
    /// When the card's song began: a player that has not started yet is not a song that ended.
    @ObservationIgnored private var playingSince = Date.distantPast

    /// The kinds this app can do (the server hands nothing else to it).
    static let kinds = ["reminder.create", "timer.start", "calendar.create_event", "music.search", "music.recent", "music.play",
                        "music.control", "music.playlist_create"]

    public init(
        client: (any ShannonDeviceActionServing)?,
        defaults: UserDefaults = .standard,
        sleep: @escaping @Sendable (TimeInterval) async -> Void = { try? await Task.sleep(for: .seconds($0)) }
    ) {
        self.client = client
        self.ledger = ShannonDeviceActionLedger(defaults: defaults)
        self.sleep = sleep
    }

    /// A fixed state for design previews; it never polls or plays.
    public static func designPreview(nowPlaying: ShannonNowPlaying? = nil) -> ShannonDeviceActionModel {
        let model = ShannonDeviceActionModel(client: nil)
        model.isPreview = true
        model.nowPlaying = nowPlaying
        return model
    }

    static var platform: String {
#if os(macOS)
        "macos"
#else
        "ios"
#endif
    }

    static func defaultInCall() -> Bool {
#if os(iOS)
        ShannonVoiceCallHost.shared.voiceModel.phase.isCallActive || ShannonVoiceCallHost.shared.systemCallIsActive
#else
        false
#endif
    }

    /// The poll loop, one for the app (a second window's call returns at once).
    public func run() async {
        guard !isPreview, !isRunning, let client else { return }
        isRunning = true
        defer { isRunning = false }
        var failures = 0
        while !Task.isCancelled {
            var delay: TimeInterval = 30
            if client.deviceActionsPaired() {
                let live = isForeground || inCall()
                do {
                    let poll = try await client.pollDeviceActions(platform: Self.platform, foreground: isForeground, inCall: inCall(), kinds: Self.kinds, wait: live)
                    failures = 0
                    for action in poll.actions { await handle(action, client: client) }
                    delay = poll.actions.isEmpty ? (poll.pollSeconds ?? (live ? 2 : 20)) : 0.2
                } catch ShannonAPIError.rejected(let status) where status == 403 {
                    // Switched off on the server, or not the owner's device: ask again much later.
                    delay = 300
                } catch {
                    failures += 1
                    delay = min(60, 5 * Double(failures))
                }
            }
            followPlayback()
            await sleep(delay)
        }
    }

    // MARK: The now-playing card

    public func skip() async {
        guard let playing = nowPlaying else { return }
        report(playing, outcome: "skipped")
        _ = await music.control("skip")
    }

    public func stop() async {
        guard let playing = nowPlaying else { return }
        stoppedByOwner = true
        report(playing, outcome: "stopped")
        _ = await music.control("stop")
        nowPlaying = nil
    }

    public func togglePause() async {
        guard var playing = nowPlaying else { return }
        _ = await music.control(playing.isPaused ? "resume" : "pause")
        playing.isPaused.toggle()
        nowPlaying = playing
    }

    // MARK: Actions

    func handle(_ action: ShannonDeviceActionDTO, client: any ShannonDeviceActionServing) async {
        let report: ShannonDeviceActionReportDTO
        if let known = ledger.report(for: action.id) {
            report = known
        } else if ledger.wasStarted(action.id) {
            // It began here and its outcome was never written (the app ended): never run it again.
            report = .failed(.failed)
            ledger.record(report, for: action.id)
        } else {
            ledger.markStarted(action.id)
            report = await perform(action)
            ledger.record(report, for: action.id)
        }
        if (try? await client.reportDeviceAction(id: action.id, report: report)) != nil {
            ledger.markReported(action.id)
        }
    }

    private func perform(_ action: ShannonDeviceActionDTO) async -> ShannonDeviceActionReportDTO {
        if let expires = ShannonDeviceActionClock.date(action.expiresAt), expires < Date() { return .failed(.past) }
        switch action.kind {
        case "reminder.create": return await eventKit.createReminder(action)
        case "calendar.create_event": return await eventKit.createEvent(action)
        case "timer.start": return await ShannonDeviceTimers.start(action)
        case "music.search": return await music.search(action)
        case "music.recent": return await music.recent()
        case "music.play": return await play(action)
        case "music.control": return await control(action.string("action"))
        case "music.playlist_create": return await music.createPlaylist(action)
        default: return .failed(.unsupported)
        }
    }

    private func play(_ action: ShannonDeviceActionDTO) async -> ShannonDeviceActionReportDTO {
        let played = await music.play(action)
        if let playing = played.nowPlaying {
            if let previous = nowPlaying, previous.actionID != playing.actionID { report(previous, outcome: "skipped") }
            stoppedByOwner = false
            playingSince = Date()
            nowPlaying = playing
            report(playing, outcome: "started")
        }
        return played.report
    }

    private func control(_ verb: String?) async -> ShannonDeviceActionReportDTO {
        if verb == "stop" || verb == "skip", let playing = nowPlaying {
            stoppedByOwner = verb == "stop"
            report(playing, outcome: verb == "stop" ? "stopped" : "skipped")
        }
        let result = await music.control(verb)
        if result.status == "done" {
            if verb == "stop" { nowPlaying = nil }
            if verb == "pause" || verb == "resume", var playing = nowPlaying {
                playing.isPaused = verb == "pause"
                nowPlaying = playing
            }
        }
        return result
    }

    /// A song she chose that played to its end is reported `finished`, once, and the card goes away.
    private func followPlayback() {
        guard let playing = nowPlaying, Date().timeIntervalSince(playingSince) > 10 else { return }
        let status = music.status()
        guard status.isStopped else { return }
        if !stoppedByOwner { report(playing, outcome: "finished") }
        stoppedByOwner = false
        nowPlaying = nil
    }

    private func report(_ playing: ShannonNowPlaying, outcome: String) {
        guard let client else { return }
        let play = ShannonMusicPlayReportDTO(actionId: playing.actionID, itemId: playing.itemID, title: playing.title, artist: playing.artist, outcome: outcome)
        Task { try? await client.reportMusicPlay(play) }
    }
}

/// What this device did with each action id: written before an action runs and when it ends, so that no id runs twice.
/// Kept for the newest 200 ids.
struct ShannonDeviceActionLedger {
    private let defaults: UserDefaults
    private static let key = "shannon.deviceActions.ledger"
    private static let limit = 200

    init(defaults: UserDefaults) {
        self.defaults = defaults
    }

    private struct Entry: Codable {
        var startedAt: Date
        var report: ShannonDeviceActionReportDTO?
        var reported: Bool
    }

    private func entries() -> [String: Entry] {
        guard let data = defaults.data(forKey: Self.key) else { return [:] }
        return (try? JSONDecoder().decode([String: Entry].self, from: data)) ?? [:]
    }

    private func save(_ entries: [String: Entry]) {
        let kept = entries.count > Self.limit
            ? Dictionary(uniqueKeysWithValues: entries.sorted { $0.value.startedAt > $1.value.startedAt }.prefix(Self.limit).map { ($0.key, $0.value) })
            : entries
        if let data = try? JSONEncoder().encode(kept) { defaults.set(data, forKey: Self.key) }
    }

    func report(for id: String) -> ShannonDeviceActionReportDTO? { entries()[id]?.report }

    func wasStarted(_ id: String) -> Bool { entries()[id] != nil }

    func markStarted(_ id: String) {
        var all = entries()
        all[id] = Entry(startedAt: Date(), report: nil, reported: false)
        save(all)
    }

    func record(_ report: ShannonDeviceActionReportDTO, for id: String) {
        var all = entries()
        all[id] = Entry(startedAt: all[id]?.startedAt ?? Date(), report: report, reported: false)
        save(all)
    }

    func markReported(_ id: String) {
        var all = entries()
        all[id]?.reported = true
        save(all)
    }
}
