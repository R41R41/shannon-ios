#if os(macOS)
import AppKit
import Foundation
import Observation

public extension Notification.Name {
    /// The owner turned 配信用の出力（OBS） on or off, or it went off because it could not start
    /// (`userInfo[ShannonStreamOutput.isOnKey]`).
    static let shannonStreamOutputChanged = Notification.Name("ShannonStreamOutputChanged")
}

/// 配信用の出力（OBS） on the Mac (roadmap A18 S5, `desktop.stream-output`, `desktop.stream-output-body`; the last thing
/// the Electron Mac app did). While the owner has it on, `http://127.0.0.1:41760/stream.html` shows her figure on a
/// transparent background for an OBS browser source: the bundled body page, in the body her desktop body takes, moved
/// by the same calls as her figure in the app (faces, mood, presence, phase, mouth, gestures). It shows nothing else:
/// no words, no camera, nothing of the owner's.
///
/// While it is on, other people may be watching: the Mac reports `others` as her bodies do while a stream is live
/// (`docs/body-contract.md`, "Audience"; the Windows body's `othersPresent`), whether or not a page is watching.
@MainActor
@Observable
public final class ShannonStreamOutput {
    public static let shared = ShannonStreamOutput()

    /// The Electron app's port (`shannon-desktop/electron/streamServer.ts`, `STREAM_PORT`), so that an OBS source made
    /// for it keeps working.
    public static let port: UInt16 = 41760
    /// The owner's switch. Off by default; kept across launches, as on Windows.
    public static let settingKey = "shannon.stream-output.on"

    public enum State: Equatable, Sendable {
        case off, starting, live
        /// It could not start (the port is taken, or the page is not in this build); the switch went back off.
        case failed(String)
    }

    public private(set) var isOn: Bool
    public private(set) var state: State = .off

    /// The address for the OBS browser source.
    public var pageURL: URL { URL(string: "http://127.0.0.1:\(port)\(ShannonStreamOutputFiles.pagePath)")! }

    @ObservationIgnored private let defaults: UserDefaults
    @ObservationIgnored private let port: UInt16
    @ObservationIgnored private let files: () -> ShannonStreamOutputFiles?
    @ObservationIgnored private var server: ShannonStreamOutputServer?
    /// The port it listens on while live (the stream's port; another only in tests).
    @ObservationIgnored private(set) var listeningPort: UInt16?
    @ObservationIgnored private var started = false
    @ObservationIgnored private var bodyObserver: NSObjectProtocol?
    /// The key of `.shannonStreamOutputChanged`'s `userInfo`: whether the switch is on now.
    public static let isOnKey = "isOn"

    init(
        defaults: UserDefaults = .standard, port: UInt16 = ShannonStreamOutput.port,
        files: @escaping () -> ShannonStreamOutputFiles? = { .bundled }
    ) {
        self.defaults = defaults
        self.port = port
        self.files = files
        self.isOn = Self.isOn(defaults)
    }

    public static func isOn(_ defaults: UserDefaults = .standard) -> Bool { defaults.bool(forKey: settingKey) }

    /// Other people may see or hear her: from the moment the owner turns it on until he turns it off.
    public var othersPresent: Bool { isOn }

    /// Who could see or hear her while the stream output is on or off: `others` while it is on, whatever else says
    /// (`docs/body-contract.md`, "Audience": "an OBS stream or recording is live"), with no hold after it is turned off,
    /// as on Windows; otherwise what the call's rule says.
    public nonisolated static func audience(streamOutputOn: Bool, held: ShannonBodyAudience) -> ShannonBodyAudience {
        streamOutputOn ? .others : held
    }

    /// After launch: listens again if the owner left it on. Never in the design preview.
    public func start() {
        guard !started else { return }
        started = true
        guard isOn else { return }
        open()
        announce()
    }

    public func setOn(_ value: Bool) {
        guard value != isOn else { return }
        defaults.set(value, forKey: Self.settingKey)
        isOn = value
        if value {
            state = .off
            open()
        } else {
            close()
            state = .off
        }
        announce()
    }

    /// Says the switch to what follows it: the app's voice call (`.shannonStreamOutputChanged`).
    private func announce() {
        NotificationCenter.default.post(name: .shannonStreamOutputChanged, object: self, userInfo: [Self.isOnKey: isOn])
    }

    /// Puts the page's address on the pasteboard.
    public func copyPageURL() {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(pageURL.absoluteString, forType: .string)
    }

    /// A call of her figure (`ShannonLive2DStage`), for every watching page.
    func mirror(_ command: ShannonLive2DCommand) {
        server?.publish(command)
    }

    // MARK: Listening

    private func open() {
        guard server == nil else { return }
        guard let files = files() else {
            fail(ShannonGeneratedStrings.desktopStreamUnavailable)
            return
        }
        let snapshot = ShannonStreamOutputSnapshot(body: ShannonLive2DStage.shared.streamBody)
        let server = ShannonStreamOutputServer(port: port, files: files, snapshot: snapshot) { [weak self] state in
            Task { @MainActor in self?.serverChanged(state) }
        }
        self.server = server
        server.start()
        // Her body follows the owner's choice wherever it is made (the stage follows it the same way).
        bodyObserver = NotificationCenter.default.addObserver(forName: UserDefaults.didChangeNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.mirror(.setBody(ShannonLive2DStage.shared.streamBody)) }
        }
        ShannonLive2DDesktopLink.shared.streamMirror = { [weak self] command in self?.mirror(command) }
        state = .starting
    }

    private func close() {
        server?.stop()
        server = nil
        listeningPort = nil
        if let bodyObserver { NotificationCenter.default.removeObserver(bodyObserver) }
        bodyObserver = nil
        ShannonLive2DDesktopLink.shared.streamMirror = nil
    }

    private func serverChanged(_ state: ShannonStreamOutputServer.State) {
        guard isOn, server != nil else { return }
        switch state {
        case .starting: self.state = .starting
        case let .listening(port):
            listeningPort = port
            self.state = .live
        case let .failed(reason):
            NSLog("[ShannonStream] the stream output could not listen: %@", reason)
            fail(ShannonGeneratedStrings.desktopStreamPortTaken(port: String(port)))
        }
    }

    /// As on Windows: a stream output that cannot run is switched off, and the reason is said under the switch.
    private func fail(_ reason: String) {
        close()
        defaults.set(false, forKey: Self.settingKey)
        isOn = false
        state = .failed(reason)
        announce()
    }
}

#endif
