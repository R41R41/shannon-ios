#if os(macOS)
import Darwin
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
            let asked = now()
            guard let step = try await transport.claim(ShannonFolderHostClaimRequest(scopeKey: "owner", host: host, localStop: stop)) else {
                if stop { return Turn(link: link, delay: ShannonFolderHostWire.stoppedClaimSeconds, entry: nil) }
                let held = now().timeIntervalSince(asked)
                return Turn(link: link, delay: max(0, ShannonFolderHostWire.shortestClaimSeconds - held), entry: nil)
            }
            // A step in hand is carried out (or, once the owner paused, refused `stopped_locally`) and reported even when this
            // turn is cancelled meanwhile (the pause restarts the loop): the server hears what became of it and need not wait
            // for its lease to run out.
            let delivered = await Task { [worker, transport] () -> Result<ShannonFolderHostReport, Error> in
                let report = await worker.perform(step, stopped: await stopped())
                do {
                    try await transport.report(id: step.id, report)
                    return .success(report)
                } catch {
                    return .failure(error)
                }
            }.value
            let report = try delivered.get()
            return Turn(link: link, delay: 0, entry: ShannonFolderHostLogEntry(step: step, report: report, at: now()))
        } catch ShannonFolderHostTransportError.notPaired {
            binding = nil
            return Turn(link: .notPaired, delay: 60, entry: nil)
        } catch ShannonFolderHostTransportError.notBound {
            binding = nil
            return Turn(link: .notRegistered, delay: 60, entry: nil)
        } catch is CancellationError {
            return Turn(link: .waiting, delay: 0, entry: nil)
        } catch ShannonFolderHostTransportError.rejected {
            // The server answered but refused (an older server without the binding route answers 404): no fast retries.
            return Turn(link: .offline, delay: 60, entry: nil)
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

/// `Application Support/Shannon/folder-activity.jsonl`: append-only and content-free. Lines are only ever added; at the
/// size the voice diagnostics log keeps (128 KiB) the file is renamed whole to `folder-activity.1.jsonl` (replacing the one
/// before) and a new one is started, so no line is ever rewritten and the log stays bounded.
public struct ShannonFolderHostActivityLog: Sendable {
    public let fileURL: URL
    public let maximumBytes: Int

    public init(fileURL: URL? = nil, maximumBytes: Int = 128 * 1_024) {
        let root = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first ?? FileManager.default.temporaryDirectory
        self.fileURL = fileURL ?? root.appendingPathComponent("Shannon/folder-activity.jsonl")
        self.maximumBytes = max(1_024, maximumBytes)
    }

    /// The previous file, kept whole after a rotation.
    public var previousURL: URL {
        fileURL.deletingPathExtension().appendingPathExtension("1").appendingPathExtension(fileURL.pathExtension)
    }

    public func append(_ entry: ShannonFolderHostLogEntry) {
        guard var line = try? JSONEncoder().encode(entry) else { return }
        line.append(0x0A)
        try? FileManager.default.createDirectory(at: fileURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        if let size = ShannonFolderHostRoot.lstatOf(fileURL.path).map({ Int($0.st_size) }), size + line.count > maximumBytes {
            _ = Darwin.rename(fileURL.path, previousURL.path)
        }
        let descriptor = open(fileURL.path, O_WRONLY | O_APPEND | O_CREAT | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard descriptor >= 0 else { return }
        defer { close(descriptor) }
        _ = line.withUnsafeBytes { write(descriptor, $0.baseAddress, $0.count) }
    }

    /// The newest entries first, at most `limit`, from this file and then the one before.
    public func recent(limit: Int = 50) -> [ShannonFolderHostLogEntry] {
        let decoder = JSONDecoder()
        let lines = [previousURL, fileURL].flatMap { url in
            ((try? Data(contentsOf: url)) ?? Data()).split(separator: 0x0A)
        }
        return lines.suffix(limit).reversed().compactMap { try? decoder.decode(ShannonFolderHostLogEntry.self, from: Data($0)) }
    }
}
#endif
