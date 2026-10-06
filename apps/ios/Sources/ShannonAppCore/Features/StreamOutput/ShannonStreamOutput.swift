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
    @ObservationIgnored private var serverToken: UUID?
    /// Listeners told to stop that have not let the port go yet: a new one waits for them, so that turning it off and
    /// on again never meets its own old listener (the port is not shared; `allowLocalEndpointReuse` is off).
    @ObservationIgnored private var stopping: [UUID: ShannonStreamOutputServer] = [:]
    @ObservationIgnored private var opensWhenStopped = false
    /// How long a stopping listener is waited for before it is given up on.
    @ObservationIgnored var stopWait: Duration = .seconds(3)
    /// The port it listens on while live (the stream's port; another only in tests).
    @ObservationIgnored private(set) var listeningPort: UInt16?
    @ObservationIgnored private var started = false
    @ObservationIgnored private var bodyObserver: NSObjectProtocol?
    /// Keeps the app's windows out of screen capture while the switch is on (owner decision 2026-10-06).
    @ObservationIgnored let capture: ShannonStreamOutputWindowCapture
    /// The key of `.shannonStreamOutputChanged`'s `userInfo`: whether the switch is on now.
    public static let isOnKey = "isOn"

    init(
        defaults: UserDefaults = .standard, port: UInt16 = ShannonStreamOutput.port,
        files: @escaping () -> ShannonStreamOutputFiles? = { .bundled }, capture: ShannonStreamOutputWindowCapture? = nil
    ) {
        self.defaults = defaults
        self.port = port
        self.files = files
        self.capture = capture ?? .shared
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

    /// Says the switch to what follows it: the app's windows, and its voice call and notifications
    /// (`.shannonStreamOutputChanged`).
    private func announce() {
        capture.apply(hiding: isOn)
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
        guard stopping.isEmpty else {
            opensWhenStopped = true
            state = .starting
            return
        }
        let stage = ShannonLive2DStage.shared
        let snapshot = ShannonStreamOutputSnapshot.seeded(body: stage.streamBody, mood: stage.mood, presence: stage.presence, phase: stage.phase)
        let token = UUID()
        let server = ShannonStreamOutputServer(port: port, files: files, snapshot: snapshot) { [weak self] state in
            Task { @MainActor in self?.serverChanged(state, token: token) }
        }
        self.server = server
        serverToken = token
        server.start()
        // Her body follows the owner's choice wherever it is made (the stage follows it the same way).
        bodyObserver = NotificationCenter.default.addObserver(forName: UserDefaults.didChangeNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.mirror(.setBody(ShannonLive2DStage.shared.streamBody)) }
        }
        ShannonLive2DDesktopLink.shared.streamMirror = { [weak self] command in self?.mirror(command) }
        state = .starting
    }

    private func close() {
        opensWhenStopped = false
        if let server, let serverToken {
            stopping[serverToken] = server
            server.stop()
            let wait = stopWait
            Task { [weak self] in
                try? await Task.sleep(for: wait)
                self?.serverChanged(.stopped, token: serverToken)
            }
        }
        server = nil
        serverToken = nil
        listeningPort = nil
        if let bodyObserver { NotificationCenter.default.removeObserver(bodyObserver) }
        bodyObserver = nil
        ShannonLive2DDesktopLink.shared.streamMirror = nil
    }

    private func serverChanged(_ state: ShannonStreamOutputServer.State, token: UUID) {
        if state == .stopped {
            guard stopping.removeValue(forKey: token) != nil else { return }
            if stopping.isEmpty, opensWhenStopped, isOn {
                opensWhenStopped = false
                open()
            }
            return
        }
        guard isOn, token == serverToken else { return }
        switch state {
        case .starting: self.state = .starting
        case let .listening(port):
            listeningPort = port
            self.state = .live
        case let .failed(reason, portTaken):
            NSLog("[ShannonStream] the stream output could not listen: %@", reason)
            fail(portTaken ? ShannonGeneratedStrings.desktopStreamPortTaken(port: String(port)) : ShannonGeneratedStrings.desktopStreamFailed)
        case .stopped:
            break
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
