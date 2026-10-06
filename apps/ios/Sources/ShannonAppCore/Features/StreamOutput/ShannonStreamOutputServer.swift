#if os(macOS)
import Foundation
import Network

/// The stream output's listener (roadmap A18 S5): bound to 127.0.0.1 only, it serves the stream page's files and its
/// event stream, one request per connection (the event stream stays open). Every rule of what is answered is in
/// `ShannonStreamOutputHTTP`; this only moves bytes. All of its state lives on its own queue.
final class ShannonStreamOutputServer: @unchecked Sendable {
    enum State: Equatable, Sendable {
        case starting
        case listening(port: UInt16)
        /// `portTaken`: another process (the Electron app, another build of this one) holds the port.
        case failed(reason: String, portTaken: Bool)
        /// The listener let the port go (it reached `.cancelled`, or never held it): a new one may take it now.
        case stopped
    }

    private let queue = DispatchQueue(label: "shannon.stream-output")
    private let files: ShannonStreamOutputFiles
    private let requestedPort: UInt16
    private let stateChanged: @Sendable (State) -> Void
    private var listener: NWListener?
    private var boundPort: UInt16?
    private var viewers: [ObjectIdentifier: NWConnection] = [:]
    private var snapshot: ShannonStreamOutputSnapshot
    private var keepAlive: DispatchSourceTimer?
    /// Connections that asked and are being answered (a long file, or a watching page): not cut after 10 seconds.
    private var answered: Set<ObjectIdentifier> = []
    private var stopped = false

    /// `port` 0 asks the system for a free one (tests).
    init(port: UInt16, files: ShannonStreamOutputFiles, snapshot: ShannonStreamOutputSnapshot, stateChanged: @escaping @Sendable (State) -> Void) {
        self.requestedPort = port
        self.files = files
        self.snapshot = snapshot
        self.stateChanged = stateChanged
    }

    /// Whether a peer is this Mac itself. The listener is bound to 127.0.0.1, so nothing else should reach it; a peer
    /// that is not loopback is dropped without an answer all the same.
    static func isLoopback(_ endpoint: NWEndpoint) -> Bool {
        guard case let .hostPort(host, _) = endpoint else { return false }
        // 127.0.0.0/8 (`IPv4Address.isLoopback` names 127.0.0.1 alone).
        func loopback(_ address: IPv4Address) -> Bool { address.rawValue.first == 127 }
        switch host {
        case let .ipv4(address): return loopback(address)
        case let .ipv6(address):
            if address.isLoopback { return true }
            // An IPv4 loopback peer seen through a dual-stack socket (::ffff:127.x.x.x).
            return address.asIPv4.map(loopback) ?? false
        default: return false
        }
    }

    /// The address is in use: the error a listener gives for a port another socket holds.
    static func isPortTaken(_ error: Error) -> Bool {
        if case let .posix(code) = error as? NWError { return code == .EADDRINUSE }
        return (error as NSError).domain == NSPOSIXErrorDomain && (error as NSError).code == Int(EADDRINUSE)
    }

    func start() {
        queue.async { self.open() }
    }

    func stop() {
        queue.async { self.close() }
    }

    /// Takes a call of her figure and sends it to every watching page when it changes anything.
    func publish(_ command: ShannonLive2DCommand) {
        queue.async {
            guard !self.stopped, let event = self.snapshot.take(command), let data = ShannonStreamOutputHTTP.event(event.payload) else { return }
            self.broadcast(data)
        }
    }

    // MARK: On the queue

    private func open() {
        guard listener == nil, !stopped else { return }
        stateChanged(.starting)
        let parameters = NWParameters.tcp
        // Never shared: a second listener on the same port (another build, the old Electron app) fails as taken.
        parameters.allowLocalEndpointReuse = false
        parameters.acceptLocalOnly = true
        parameters.requiredLocalEndpoint = .hostPort(host: .ipv4(.loopback), port: NWEndpoint.Port(rawValue: requestedPort) ?? .any)
        let listener: NWListener
        do {
            listener = try NWListener(using: parameters)
        } catch {
            stopped = true
            stateChanged(.failed(reason: String(describing: error), portTaken: Self.isPortTaken(error)))
            stateChanged(.stopped)
            return
        }
        self.listener = listener
        listener.newConnectionHandler = { [weak self] connection in self?.accept(connection) }
        listener.stateUpdateHandler = { [weak self, weak listener] state in
            guard let self else { return }
            switch state {
            case .ready:
                let port = listener?.port?.rawValue ?? self.requestedPort
                self.boundPort = port
                self.startKeepAlive()
                self.stateChanged(.listening(port: port))
            case let .failed(error), let .waiting(error):
                // Said, and closed; `.cancelled` follows and says the port is free again.
                self.stateChanged(.failed(reason: String(describing: error), portTaken: Self.isPortTaken(error)))
                self.close()
            case .cancelled:
                self.listener = nil
                self.stateChanged(.stopped)
            default:
                break
            }
        }
        listener.start(queue: queue)
    }

    /// Cancels the listener; its `.cancelled` says `.stopped` (at once when there is none).
    private func close() {
        let first = !stopped
        stopped = true
        keepAlive?.cancel()
        keepAlive = nil
        if let listener {
            listener.newConnectionHandler = nil
            listener.cancel()
        } else if first {
            stateChanged(.stopped)
        }
        for connection in viewers.values {
            connection.send(content: ShannonStreamOutputHTTP.lastChunk, isComplete: true, completion: .contentProcessed { _ in connection.cancel() })
        }
        viewers.removeAll()
    }

    private func accept(_ connection: NWConnection) {
        guard !stopped, Self.isLoopback(connection.endpoint) else {
            connection.cancel()
            return
        }
        connection.start(queue: queue)
        // A peer that does not finish its request soon is let go.
        queue.asyncAfter(deadline: .now() + 10) { [weak self, weak connection] in
            guard let self, let connection, !self.answered.contains(ObjectIdentifier(connection)) else { return }
            connection.cancel()
        }
        receive(connection, buffer: Data())
    }

    private func receive(_ connection: NWConnection, buffer: Data) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: ShannonStreamOutputHTTP.maximumHeadBytes) { [weak self] data, _, isComplete, error in
            guard let self else { return }
            var buffer = buffer
            if let data { buffer.append(data) }
            switch ShannonStreamOutputHTTP.parse(buffer) {
            case .incomplete:
                if isComplete || error != nil { connection.cancel() } else { self.receive(connection, buffer: buffer) }
            case .malformed:
                self.finish(connection, ShannonStreamOutputHTTP.refusal(status: 400))
            case let .request(request):
                self.answer(request, on: connection)
            }
        }
    }

    private func answer(_ request: ShannonStreamOutputHTTP.Request, on connection: NWConnection) {
        answered.insert(ObjectIdentifier(connection))
        switch ShannonStreamOutputHTTP.route(request, port: boundPort ?? requestedPort, files: files) {
        case let .refused(status):
            finish(connection, ShannonStreamOutputHTTP.refusal(status: status))
        case let .file(entry):
            guard let body = try? Data(contentsOf: entry.url, options: .alwaysMapped) else {
                finish(connection, ShannonStreamOutputHTTP.refusal(status: 404))
                return
            }
            finish(connection, ShannonStreamOutputHTTP.fileHead(entry, length: body.count) + body)
        case .events:
            guard viewers.count < ShannonStreamOutputHTTP.maximumViewers else {
                finish(connection, ShannonStreamOutputHTTP.refusal(status: 503))
                return
            }
            let id = ObjectIdentifier(connection)
            viewers[id] = connection
            connection.stateUpdateHandler = { [weak self] state in
                switch state {
                case .failed, .cancelled: self?.drop(id)
                default: break
                }
            }
            var opening = ShannonStreamOutputHTTP.chunk(ShannonStreamOutputHTTP.opening)
            for event in snapshot.opening {
                if let data = ShannonStreamOutputHTTP.event(event.payload) { opening += ShannonStreamOutputHTTP.chunk(data) }
            }
            send(ShannonStreamOutputHTTP.eventsHead() + opening, to: id)
        }
    }

    private func finish(_ connection: NWConnection, _ data: Data) {
        // Completions run on `queue`, where the connection was started.
        connection.send(content: data, isComplete: true, completion: .contentProcessed { [weak self] _ in
            connection.cancel()
            self?.answered.remove(ObjectIdentifier(connection))
        })
    }

    private func broadcast(_ event: Data) {
        let chunk = ShannonStreamOutputHTTP.chunk(event)
        for id in viewers.keys { send(chunk, to: id) }
    }

    private func send(_ data: Data, to id: ObjectIdentifier) {
        guard let connection = viewers[id] else { return }
        connection.send(content: data, completion: .contentProcessed { [weak self] error in
            if error != nil { self?.drop(id) }
        })
    }

    private func drop(_ id: ObjectIdentifier) {
        answered.remove(id)
        guard let connection = viewers.removeValue(forKey: id) else { return }
        connection.cancel()
    }

    private func startKeepAlive() {
        keepAlive?.cancel()
        let timer = DispatchSource.makeTimerSource(queue: queue)
        timer.schedule(deadline: .now() + 15, repeating: 15)
        timer.setEventHandler { [weak self] in self?.broadcast(ShannonStreamOutputHTTP.keepAlive) }
        timer.resume()
        keepAlive = timer
    }
}
#endif
