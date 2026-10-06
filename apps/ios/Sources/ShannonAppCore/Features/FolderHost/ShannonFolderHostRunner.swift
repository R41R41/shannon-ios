#if os(macOS)
import Foundation

/// How this Mac stands with the server as her folder's device.
public enum ShannonFolderHostLink: Equatable, Sendable {
    /// Not asked yet.
    case waiting
    /// No device token (not paired, or the pairing was revoked).
    case notPaired
    /// Paired, but no host names this Mac (`GET /v1/autonomy/host-steps/binding` answered none, or a claim was refused).
    case notRegistered
    /// Claiming for `host`; `stopped` while the owner's stop switch on this Mac is on.
    case connected(host: String, label: String?, stopped: Bool)
    /// The server could not be reached; it is tried again in a few seconds.
    case offline
}

/// The claim loop, one turn at a time (`docs/host-folder-contract.md`, 「What a v2 device must implement」): a long-poll
/// claim with `waitSeconds: 25`, the step carried out by the worker, the report, and at once the next claim. While the
/// owner's stop switch on this Mac is on it claims with `localStop: true` at most every 15 seconds and runs nothing.
public actor ShannonFolderHostRunner {
    public struct Turn: Equatable, Sendable {
        public let link: ShannonFolderHostLink
        /// Seconds to wait before the next turn (0: claim again at once).
        public let delay: Double
        /// What was done in this turn, for the local log; nil when no step came.
        public let entry: ShannonFolderHostLogEntry?
    }

    private let transport: any ShannonFolderHostTransport
    private let worker: ShannonFolderHostWorker
    private let now: @Sendable () -> Date
    private var binding: ShannonFolderHostBinding?

    public init(transport: any ShannonFolderHostTransport, worker: ShannonFolderHostWorker, now: @escaping @Sendable () -> Date = Date.init) {
        self.transport = transport
        self.worker = worker
        self.now = now
    }

    /// Forgets the host, so the next turn asks the server again (after pairing or registering anew).
    public func reset() { binding = nil }

    /// One claim. `stopped` is read again when a step arrives: a step handed out just as the owner stopped it is not run.
    public func turn(stopped: @escaping @Sendable () async -> Bool) async -> Turn {
        do {
            let binding: ShannonFolderHostBinding
            if let known = self.binding {
                binding = known
            } else {
                binding = try await transport.binding()
            }
            guard let host = binding.host else { return Turn(link: .notRegistered, delay: 60, entry: nil) }
            self.binding = binding
            let stop = await stopped()
            let link = ShannonFolderHostLink.connected(host: host, label: binding.label, stopped: stop)
            guard let step = try await transport.claim(ShannonFolderHostClaimRequest(scopeKey: "owner", host: host, localStop: stop)) else {
                return Turn(link: link, delay: stop ? ShannonFolderHostWire.stoppedClaimSeconds : 0, entry: nil)
            }
            let report = await worker.perform(step, stopped: await stopped())
            try await transport.report(id: step.id, report)
            return Turn(link: link, delay: 0, entry: ShannonFolderHostLogEntry(step: step, report: report, at: now()))
        } catch ShannonFolderHostTransportError.notPaired {
            binding = nil
            return Turn(link: .notPaired, delay: 60, entry: nil)
        } catch ShannonFolderHostTransportError.notBound {
            binding = nil
            return Turn(link: .notRegistered, delay: 60, entry: nil)
        } catch is CancellationError {
            return Turn(link: .waiting, delay: 0, entry: nil)
        } catch {
            // On a network error the device waits 1–5 seconds and tries again.
            return Turn(link: .offline, delay: Double.random(in: 1...5), entry: nil)
        }
    }
}

/// One line of the local log: what was done, never what a file says or what was searched for.
public struct ShannonFolderHostLogEntry: Codable, Equatable, Sendable {
    public let at: String
    public let operation: String
    public let path: String?
    public let outcome: String
    public let code: String?
    /// Entries listed, bytes read, or hits found.
    public let count: Int?

    public init(at: String, operation: String, path: String?, outcome: String, code: String?, count: Int?) {
        self.at = at
        self.operation = operation
        self.path = path
        self.outcome = outcome
        self.code = code
        self.count = count
    }

    init(step: ShannonFolderHostStep, report: ShannonFolderHostReport, at: Date) {
        let count: Int? = switch report.result {
        case .list(let list): list.entries.count
        case .read(let read): (read.nextOffset ?? read.totalBytes) - read.offset
        case .search(let search): search.hits.count
        case nil: nil
        }
        let operation = ShannonFolderHostWire.operations.contains(step.operation) ? step.operation : "unknown"
        self.init(at: ShannonFolderHostTime.string(at), operation: operation, path: step.relativePath.map { String($0.prefix(240)) },
                  outcome: report.outcome, code: report.code?.rawValue, count: count)
    }
}

/// `Application Support/Shannon/folder-activity.jsonl`: append-only and content-free. Lines are only ever added.
public struct ShannonFolderHostActivityLog: Sendable {
    public let fileURL: URL

    public init(fileURL: URL? = nil) {
        let root = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first ?? FileManager.default.temporaryDirectory
        self.fileURL = fileURL ?? root.appendingPathComponent("Shannon/folder-activity.jsonl")
    }

    public func append(_ entry: ShannonFolderHostLogEntry) {
        guard var line = try? JSONEncoder().encode(entry) else { return }
        line.append(0x0A)
        try? FileManager.default.createDirectory(at: fileURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        let descriptor = open(fileURL.path, O_WRONLY | O_APPEND | O_CREAT | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard descriptor >= 0 else { return }
        defer { close(descriptor) }
        _ = line.withUnsafeBytes { write(descriptor, $0.baseAddress, $0.count) }
    }

    /// The newest entries first, at most `limit`.
    public func recent(limit: Int = 50) -> [ShannonFolderHostLogEntry] {
        guard let data = try? Data(contentsOf: fileURL) else { return [] }
        let decoder = JSONDecoder()
        return data.split(separator: 0x0A).suffix(limit).reversed().compactMap { try? decoder.decode(ShannonFolderHostLogEntry.self, from: Data($0)) }
    }
}
#endif
