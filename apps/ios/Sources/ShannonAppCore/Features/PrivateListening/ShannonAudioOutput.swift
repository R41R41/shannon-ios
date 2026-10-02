import Foundation

/// One place the device's sound currently comes out of, as the system names it.
public struct ShannonAudioOutput: Equatable, Sendable {
    public enum Kind: String, Codable, Equatable, Sendable {
        /// Wired headphones or a wired headset. The system can tell these apart from a speaker.
        case wiredHeadphones
        /// Any Bluetooth audio device. Earphones and a speaker look the same to the system.
        case bluetooth
        /// A USB audio device: earphones, a headset, a DAC, or a speaker.
        case usb
        case builtInSpeaker
        /// Everything else: the receiver, AirPlay, a car, a display, an aggregate device.
        case other
    }

    /// The device's identity, the same whichever Bluetooth profile is in use.
    public let id: String
    public let name: String
    public let kind: Kind

    public init(id: String, name: String, kind: Kind) {
        self.id = id
        self.name = name
        self.kind = kind
    }

    /// Bluetooth earphones and USB devices cannot be told from speakers, so the owner says which are his earphones.
    public var canBeRegistered: Bool { (kind == .bluetooth || kind == .usb) && !id.isEmpty }

    /// iOS appends the Bluetooth profile to a port's UID (`…-tacl` for A2DP, `…-tsco` for HFP), and the
    /// profile changes when a voice conversation starts. The registry keeps the part that stays.
    public static func normalizedPortUID(_ uid: String) -> String {
        guard let dash = uid.lastIndex(of: "-") else { return uid }
        let suffix = uid[uid.index(after: dash)...]
        return suffix.count == 4 && suffix.allSatisfy(\.isLetter) && suffix.first == "t" ? String(uid[..<dash]) : uid
    }

    /// macOS names the two directions of one Bluetooth device `…:output` and `…:input`.
    public static func normalizedDeviceUID(_ uid: String) -> String {
        for suffix in [":output", ":input"] where uid.hasSuffix(suffix) {
            return String(uid.dropLast(suffix.count))
        }
        return uid
    }
}

/// An output the owner registered as "earphones: only I can hear".
public struct ShannonRegisteredEarphones: Codable, Equatable, Identifiable, Sendable {
    public let id: String
    public let name: String
    public let registeredAt: Date

    public init(id: String, name: String, registeredAt: Date) {
        self.id = id
        self.name = name
        self.registeredAt = registeredAt
    }
}

/// Whether only the owner can hear what this device plays now (owner decision 2026-10-02).
///
/// Yes only when every current output is wired headphones or a device he registered. An empty route,
/// a speaker, or one unregistered output among several is no. The identity decides, never the name:
/// two devices that share a name are two devices.
///
/// The system reports a headphone jack as headphones whatever is plugged into it. Someone who keeps
/// speakers on the jack switches `wiredCountsAsPrivate` off; a wired output is then never private.
public enum ShannonPrivateListeningJudge {
    public static func isPrivate(
        _ output: ShannonAudioOutput, registered: [ShannonRegisteredEarphones], wiredCountsAsPrivate: Bool = true
    ) -> Bool {
        switch output.kind {
        case .wiredHeadphones: wiredCountsAsPrivate
        case .bluetooth, .usb: !output.id.isEmpty && registered.contains { $0.id == output.id }
        case .builtInSpeaker, .other: false
        }
    }

    public static func isPrivate(
        route: [ShannonAudioOutput], registered: [ShannonRegisteredEarphones], wiredCountsAsPrivate: Bool = true
    ) -> Bool {
        !route.isEmpty && route.allSatisfy { isPrivate($0, registered: registered, wiredCountsAsPrivate: wiredCountsAsPrivate) }
    }
}

/// The owner's registered earphones. Kept on this device only: nothing here is secret, and the server
/// is never told a device name or identifier.
public struct ShannonEarphoneRegistry {
    public static let defaultsKey = "shannon.privateListening.earphones"
    public static let maximumEntries = 24

    private let defaults: UserDefaults

    public init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    public func load() -> [ShannonRegisteredEarphones] {
        guard let data = defaults.data(forKey: Self.defaultsKey),
              let entries = try? JSONDecoder().decode([ShannonRegisteredEarphones].self, from: data) else { return [] }
        return entries
    }

    /// Adds the output, or renames an entry that has the same identity. Returns the stored list.
    @discardableResult
    public func register(_ output: ShannonAudioOutput, at now: Date) -> [ShannonRegisteredEarphones] {
        guard output.canBeRegistered else { return load() }
        var entries = load().filter { $0.id != output.id }
        entries.append(ShannonRegisteredEarphones(id: output.id, name: output.name, registeredAt: now))
        if entries.count > Self.maximumEntries { entries.removeFirst(entries.count - Self.maximumEntries) }
        save(entries)
        return entries
    }

    @discardableResult
    public func remove(id: String) -> [ShannonRegisteredEarphones] {
        let entries = load().filter { $0.id != id }
        save(entries)
        return entries
    }

    private func save(_ entries: [ShannonRegisteredEarphones]) {
        guard let data = try? JSONEncoder().encode(entries) else { return }
        defaults.set(data, forKey: Self.defaultsKey)
    }
}
